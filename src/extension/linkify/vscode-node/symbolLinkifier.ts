/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IParserService } from '../../../platform/parser/node/parserService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { collapseRangeToStart } from '../../../util/common/range';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { SymbolInformation, Uri } from '../../../vscodeTypes';
import { LinkifiedPart, LinkifiedText, LinkifySymbolAnchor } from '../common/linkifiedText';
import { IContributedLinkifier, LinkifierContext } from '../common/linkifyService';
import { findBestSymbolByPath } from './findSymbol';
import { findSymbolLocationInFile, type SymbolFileCache } from './findWord';

/**
 * Linkifies symbol paths in responses. For example:
 *
 * ```
 * [`symbol`](file.md)
 * ```
 */
export class SymbolLinkifier implements IContributedLinkifier {

	constructor(
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@IParserService private readonly parserService: IParserService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

	async linkify(
		text: string,
		context: LinkifierContext,
		token: CancellationToken,
	): Promise<LinkifiedText | undefined> {
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		if (!workspaceFolders.length) {
			return;
		}

		const out: LinkifiedPart[] = [];
		const symbolFileCache: SymbolFileCache = new Map();

		let endLastMatch = 0;
		for (const match of text.matchAll(/\[`([^`\[\]]+?)`]\((\S+?\.\w+)\)/g)) {
			const prefix = text.slice(endLastMatch, match.index);
			if (prefix) {
				out.push(prefix);
			}

			const symbolText = match[1];
			let symbolPath = match[2];
			try {
				symbolPath = decodeURIComponent(symbolPath);
			} catch {
				// noop
			}

			const resolvedUri = await this.resolveInWorkspace(symbolPath, workspaceFolders);

			if (resolvedUri) {
				const initialLocation = await findSymbolLocationInFile(this.parserService, resolvedUri, symbolText, token, symbolFileCache)
					.catch(() => undefined);
				console.log(`[SymbolLinkifier] tree-sitter initial symbol="${symbolText}" uri="${resolvedUri.toString()}" location=${formatLocationForLog(initialLocation)}`);
				const info: SymbolInformation = {
					name: symbolText,
					containerName: '',
					kind: vscode.SymbolKind.Variable,
					location: initialLocation ?? new vscode.Location(resolvedUri, new vscode.Position(0, 0))
				};

				out.push(new LinkifySymbolAnchor(info, async (token) => {
					console.log(`[SymbolLinkifier] LSP resolve start symbol="${symbolText}" uri="${resolvedUri.toString()}" currentLocation=${formatLocationForLog(info.location)}`);
					let symbols: Array<vscode.SymbolInformation | vscode.DocumentSymbol> | undefined;
					try {
						symbols = await vscode.commands.executeCommand<Array<vscode.SymbolInformation | vscode.DocumentSymbol> | undefined>('vscode.executeDocumentSymbolProvider', resolvedUri);
						console.log(`[SymbolLinkifier] LSP document symbols symbol="${symbolText}" count=${symbols?.length ?? 0} names=${formatSymbolNamesForLog(symbols)}`);
					} catch (e) {
						console.log(`[SymbolLinkifier] LSP document symbols failed symbol="${symbolText}" uri="${resolvedUri.toString()}"`, e);
					}

					// Tree-sitter gives a best-effort initial location. Document symbols remain
					// the richer source for symbol kind and nested same-name disambiguation.
					if (symbols?.length) {
						const matchingSymbol = findBestSymbolByPath(symbols, symbolText);
						console.log(`[SymbolLinkifier] LSP match symbol="${symbolText}" match=${formatSymbolForLog(matchingSymbol)}`);
						if (matchingSymbol) {
							info.kind = matchingSymbol.kind;

							// Not a real instance of 'vscode.DocumentSymbol' so use cast to check
							if ((matchingSymbol as vscode.DocumentSymbol).children) {
								const symbol = matchingSymbol as vscode.DocumentSymbol;
								info.location = new vscode.Location(resolvedUri, collapseRangeToStart(symbol.selectionRange));
							} else {
								const symbol = matchingSymbol as vscode.SymbolInformation;
								info.location = new vscode.Location(symbol.location.uri, collapseRangeToStart(symbol.location.range));
							}
							console.log(`[SymbolLinkifier] LSP resolved symbol="${symbolText}" kind=${info.kind} location=${formatLocationForLog(info.location)}`);
						}
					}
					return info;
				}));
			} else {
				out.push('`' + symbolText + '`');
			}

			endLastMatch = match.index + match[0].length;
		}

		const suffix = text.slice(endLastMatch);
		if (suffix) {
			out.push(suffix);
		}

		return { parts: out };
	}

	private async resolveInWorkspace(symbolPath: string, workspaceFolders: readonly Uri[]): Promise<Uri | undefined> {
		const candidates = workspaceFolders.map(folder => Uri.joinPath(folder, symbolPath));
		const results = await Promise.all(candidates.map(uri => this.exists(uri).then(exists => exists ? uri : undefined)));
		return results.find((uri): uri is Uri => uri !== undefined);
	}

	private async exists(uri: Uri) {
		try {
			await this.fileSystem.stat(uri);
			return true;
		} catch {
			return false;
		}
	}
}

function formatLocationForLog(location: vscode.Location | undefined): string {
	if (!location) {
		return '<none>';
	}
	return `${location.uri.toString()}#${formatRangeForLog(location.range)}`;
}

function formatRangeForLog(range: vscode.Range | undefined): string {
	if (!range) {
		return '<none>';
	}
	return `${formatPositionForLog(range.start)}-${formatPositionForLog(range.end)}`;
}

function formatPositionForLog(position: vscode.Position): string {
	return `${position.line + 1}:${position.character + 1}`;
}

function formatSymbolNamesForLog(symbols: Array<vscode.SymbolInformation | vscode.DocumentSymbol> | undefined): string {
	if (!symbols?.length) {
		return '<none>';
	}

	const names: string[] = [];
	collectSymbolNamesForLog(symbols, names, 80);
	const suffix = names.length >= 80 ? ', ...' : '';
	return names.join(', ') + suffix;
}

function collectSymbolNamesForLog(symbols: readonly (vscode.SymbolInformation | vscode.DocumentSymbol)[], names: string[], limit: number): void {
	for (const symbol of symbols) {
		if (names.length >= limit) {
			return;
		}

		names.push(symbol.name);
		if (isDocumentSymbolForLog(symbol)) {
			collectSymbolNamesForLog(symbol.children, names, limit);
		}
	}
}

function formatSymbolForLog(symbol: vscode.SymbolInformation | vscode.DocumentSymbol | undefined): string {
	if (!symbol) {
		return '<none>';
	}

	if (isDocumentSymbolForLog(symbol)) {
		return `DocumentSymbol(name="${symbol.name}", kind=${symbol.kind}, range=${formatRangeForLog(symbol.range)}, selectionRange=${formatRangeForLog(symbol.selectionRange)}, children=${symbol.children.length})`;
	}

	return `SymbolInformation(name="${symbol.name}", kind=${symbol.kind}, uri="${symbol.location.uri.toString()}", range=${formatRangeForLog(symbol.location.range)})`;
}

function isDocumentSymbolForLog(symbol: vscode.SymbolInformation | vscode.DocumentSymbol): symbol is vscode.DocumentSymbol {
	return Array.isArray((symbol as vscode.DocumentSymbol).children);
}
