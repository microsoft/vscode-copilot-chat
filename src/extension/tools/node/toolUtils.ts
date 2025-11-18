/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptPiece } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { RelativePattern } from '../../../platform/filesystem/common/fileTypes';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { ILanguageFeaturesService } from '../../../platform/languages/common/languageFeaturesService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError } from '../../../util/vs/base/common/errors';
import { Schemas } from '../../../util/vs/base/common/network';
import { isAbsolute } from '../../../util/vs/base/common/path';
import { isEqual, normalizePath } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelPromptTsxPart, LanguageModelToolResult, Position, SymbolKind } from '../../../vscodeTypes';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';

export function checkCancellation(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

export async function toolTSX(insta: IInstantiationService, options: vscode.LanguageModelToolInvocationOptions<unknown>, piece: PromptPiece, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
	return new LanguageModelToolResult([
		new LanguageModelPromptTsxPart(
			await renderPromptElementJSON(insta, class extends PromptElement {
				render() {
					return piece;
				}
			}, {}, options.tokenizationOptions, token)
		)
	]);
}

/**
 * Converts a user input glob or file path into a VS Code glob pattern or RelativePattern.
 *
 * @param query The user input glob or file path.
 * @param workspaceService The workspace service used to resolve relative paths.
 * @param modelFamily The language model family (e.g., 'gpt-4.1'). If set to 'gpt-4.1', a workaround is applied:
 *   GPT-4.1 struggles to append '/**' to patterns, so this function adds an additional pattern with '/**' appended.
 *   Other models do not require this workaround.
 * @returns An array of glob patterns suitable for use in file matching.
 */
export function inputGlobToPattern(query: string, workspaceService: IWorkspaceService, modelFamily: string | undefined): vscode.GlobPattern[] {
	let pattern: vscode.GlobPattern = query;
	if (isAbsolute(query)) {
		try {
			const relative = workspaceService.asRelativePath(query);
			if (relative !== query) {
				const workspaceFolder = workspaceService.getWorkspaceFolder(URI.file(query));
				if (workspaceFolder) {
					pattern = new RelativePattern(workspaceFolder, relative);
				}
			}
		} catch (e) {
			// ignore
		}
	}

	const patterns = [pattern];

	// For gpt-4.1, it struggles to append /** to the pattern itself, so here we work around it by
	// adding a second pattern with /** appended.
	// Other models are smart enough to append the /** suffix so they don't need this workaround.
	if (modelFamily === 'gpt-4.1') {
		if (typeof pattern === 'string' && !pattern.endsWith('/**')) {
			patterns.push(pattern + '/**');
		} else if (typeof pattern !== 'string' && !pattern.pattern.endsWith('/**')) {
			patterns.push(new RelativePattern(pattern.baseUri, pattern.pattern + '/**'));
		}
	}

	return patterns;
}

export function resolveToolInputPath(path: string, promptPathRepresentationService: IPromptPathRepresentationService): URI {
	const uri = promptPathRepresentationService.resolveFilePath(path);
	if (!uri) {
		throw new Error(`Invalid input path: ${path}. Be sure to use an absolute path.`);
	}

	return uri;
}

export async function isFileOkForTool(accessor: ServicesAccessor, uri: URI): Promise<boolean> {
	try {
		await assertFileOkForTool(accessor, uri);
		return true;
	} catch {
		return false;
	}
}

export async function assertFileOkForTool(accessor: ServicesAccessor, uri: URI): Promise<void> {
	const workspaceService = accessor.get(IWorkspaceService);
	const tabsAndEditorsService = accessor.get(ITabsAndEditorsService);
	const promptPathRepresentationService = accessor.get(IPromptPathRepresentationService);
	const customInstructionsService = accessor.get(ICustomInstructionsService);

	await assertFileNotContentExcluded(accessor, uri);

	if (!workspaceService.getWorkspaceFolder(normalizePath(uri)) && !customInstructionsService.isExternalInstructionsFile(uri) && uri.scheme !== Schemas.untitled) {
		const fileOpenInSomeTab = tabsAndEditorsService.tabs.some(tab => isEqual(tab.uri, uri));
		if (!fileOpenInSomeTab) {
			throw new Error(`File ${promptPathRepresentationService.getFilePath(uri)} is outside of the workspace, and not open in an editor, and can't be read`);
		}
	}
}

export async function assertFileNotContentExcluded(accessor: ServicesAccessor, uri: URI): Promise<void> {
	const ignoreService = accessor.get(IIgnoreService);
	const promptPathRepresentationService = accessor.get(IPromptPathRepresentationService);

	if (await ignoreService.isCopilotIgnored(uri)) {
		throw new Error(`File ${promptPathRepresentationService.getFilePath(uri)} is configured to be ignored by Copilot`);
	}
}

export interface NormalizedSymbolPosition {
	readonly position: Position;
	readonly line: number;
	readonly column: number;
	readonly symbolId?: string;
}

export interface SymbolCandidate {
	readonly symbolId: string;
	readonly kind: string;
	readonly name: string;
	readonly column: number;
}

export class SymbolAmbiguityError extends Error {
	constructor(
		message: string,
		public readonly candidates: SymbolCandidate[]
	) {
		super(message);
		this.name = 'SymbolAmbiguityError';
	}
}

export async function normalizeSymbolPosition(
	document: vscode.TextDocument,
	line: number,
	symbolName: string,
	expectedKind: string,
	symbolId: string | undefined,
	promptPathService: IPromptPathRepresentationService,
	languageFeaturesService: ILanguageFeaturesService,
	token: CancellationToken
): Promise<NormalizedSymbolPosition> {
	const normalizedLine = normalizePositiveInteger(line, 'line');
	const zeroBasedLine = normalizedLine - 1;
	if (zeroBasedLine < 0 || zeroBasedLine >= document.lineCount) {
		throw new Error(`Line ${normalizedLine} is outside the range of ${promptPathService.getFilePath(document.uri)} (file has ${document.lineCount} lines).`);
	}

	const normalizedSymbolName = symbolName?.trim();
	if (!normalizedSymbolName) {
		throw new Error(`A non-empty symbolName is required to locate the symbol in ${promptPathService.getFilePath(document.uri)}.`);
	}

	// Get all document symbols
	const allSymbols = await languageFeaturesService.getDocumentSymbols(document.uri);
	checkCancellation(token);

	// Find all symbols on the requested line with matching name
	const candidates = findSymbolsOnLine(allSymbols, zeroBasedLine, normalizedSymbolName);

	// If symbolId is provided, use it for direct lookup
	if (symbolId) {
		const match = candidates.find(c => c.symbolId === symbolId);
		if (!match) {
			throw new Error(`Symbol with ID "${symbolId}" was not found on line ${normalizedLine} of ${promptPathService.getFilePath(document.uri)}.`);
		}
		return {
			position: new Position(zeroBasedLine, match.column),
			line: normalizedLine,
			column: match.column + 1,
			symbolId: match.symbolId,
		};
	}

	// Filter by expectedKind if provided
	const filteredCandidates = candidates.filter(c => symbolKindMatches(c.kind, expectedKind));

	// Case A: No candidates found
	if (filteredCandidates.length === 0) {
		if (candidates.length > 0) {
			// Found symbols with the name but wrong kind
			throw new Error(`No symbol named "${normalizedSymbolName}" with kind "${expectedKind}" found on line ${normalizedLine} of ${promptPathService.getFilePath(document.uri)}.`);
		}
		// Fallback to text search for backwards compatibility
		const lineText = document.lineAt(zeroBasedLine).text;
		const symbolColumn = findSymbolColumnIndex(lineText, normalizedSymbolName);
		if (symbolColumn === undefined) {
			throw new Error(`Symbol "${normalizedSymbolName}" was not found on line ${normalizedLine} of ${promptPathService.getFilePath(document.uri)}.`);
		}
		return {
			position: new Position(zeroBasedLine, symbolColumn),
			line: normalizedLine,
			column: symbolColumn + 1,
		};
	}

	// Case B: Exactly one candidate - use it
	if (filteredCandidates.length === 1) {
		const candidate = filteredCandidates[0];
		return {
			position: new Position(zeroBasedLine, candidate.column),
			line: normalizedLine,
			column: candidate.column + 1,
			symbolId: candidate.symbolId,
		};
	}

	// Case C: Multiple candidates - return ambiguity error
	throw new SymbolAmbiguityError(
		`Multiple symbols named "${normalizedSymbolName}" found on line ${normalizedLine} of ${promptPathService.getFilePath(document.uri)}. Please specify expectedKind or use symbolId from this response.`,
		filteredCandidates
	);
}

function findSymbolsOnLine(symbols: vscode.DocumentSymbol[], line: number, name: string): SymbolCandidate[] {
	const candidates: SymbolCandidate[] = [];

	function visit(symbol: vscode.DocumentSymbol, parentPath: string = '') {
		// Check if symbol is on the target line
		if (symbol.range.start.line <= line && symbol.range.end.line >= line) {
			// Check if symbol name matches
			if (symbol.name === name && symbol.selectionRange.start.line === line) {
				const symbolPath = parentPath ? `${parentPath}.${symbol.name}` : symbol.name;
				candidates.push({
					symbolId: `${symbolPath}:${symbol.range.start.line}:${symbol.range.start.character}`,
					kind: SymbolKind[symbol.kind],
					name: symbol.name,
					column: symbol.selectionRange.start.character,
				});
			}

			// Recursively check children
			if (symbol.children) {
				const symbolPath = parentPath ? `${parentPath}.${symbol.name}` : symbol.name;
				for (const child of symbol.children) {
					visit(child, symbolPath);
				}
			}
		}
	}

	for (const symbol of symbols) {
		visit(symbol);
	}

	return candidates;
}

function symbolKindMatches(symbolKind: string, expectedKind: string): boolean {
	// Normalize both to lowercase for comparison
	const normalizedSymbolKind = symbolKind.toLowerCase();
	const normalizedExpectedKind = expectedKind.toLowerCase();

	// Direct match
	if (normalizedSymbolKind === normalizedExpectedKind) {
		return true;
	}

	// Map common aliases
	const kindAliases: Record<string, string[]> = {
		'type': ['class', 'interface', 'enum', 'struct'],
		'class': ['type'],
		'interface': ['type'],
		'enum': ['type'],
		'function': ['method'],
		'method': ['function'],
		'variable': ['field', 'property', 'local'],
		'field': ['variable', 'property'],
		'property': ['variable', 'field'],
		'local': ['variable'],
		'parameter': ['variable'],
		'constant': ['variable', 'field'],
	};

	const aliases = kindAliases[normalizedExpectedKind] || [];
	return aliases.includes(normalizedSymbolKind);
}

function findSymbolColumnIndex(lineText: string, symbolName: string): number | undefined {
	const matches = collectSymbolMatches(lineText, symbolName);
	for (const candidate of matches) {
		if (isWholeIdentifierMatch(lineText, candidate, symbolName.length)) {
			return candidate;
		}
	}

	return matches[0];
}

function collectSymbolMatches(lineText: string, symbolName: string): number[] {
	const matches: number[] = [];
	let index = lineText.indexOf(symbolName);
	while (index !== -1) {
		matches.push(index);
		index = lineText.indexOf(symbolName, index + Math.max(symbolName.length, 1));
	}
	return matches;
}

function isWholeIdentifierMatch(lineText: string, start: number, length: number): boolean {
	const before = start === 0 ? undefined : lineText.charAt(start - 1);
	const after = start + length >= lineText.length ? undefined : lineText.charAt(start + length);
	return !isIdentifierCharacter(before) && !isIdentifierCharacter(after);
}

function isIdentifierCharacter(char: string | undefined): boolean {
	return !!char && /[A-Za-z0-9_$]/.test(char);
}

function normalizePositiveInteger(value: number, field: string): number {
	if (!Number.isFinite(value)) {
		throw new Error(`The ${field} value must be a finite number.`);
	}

	return Math.max(1, Math.floor(value));
}
