/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { z } from 'zod';
import { ILogger } from '../../../../../platform/log/common/logService';
import { makeTextResult } from './utils';

export function registerRunLspQueryTool(server: McpServer, logger: ILogger): void {
	const schema = {
		command: z.enum([
			'vscode.executeDocumentHighlights',
			'vscode.executeDocumentSymbolProvider',
			'vscode.executeFormatDocumentProvider',
			'vscode.executeFormatRangeProvider',
			'vscode.executeFormatOnTypeProvider',
			'vscode.executeDefinitionProvider',
			'vscode.executeTypeDefinitionProvider',
			'vscode.executeDeclarationProvider',
			'vscode.executeImplementationProvider',
			'vscode.executeReferenceProvider',
			'vscode.executeHoverProvider',
			'vscode.executeSelectionRangeProvider',
			'vscode.executeWorkspaceSymbolProvider',
			'vscode.prepareCallHierarchy',
			'vscode.provideIncomingCalls',
			'vscode.provideOutgoingCalls',
			'vscode.prepareRename',
			'vscode.executeDocumentRenameProvider',
			'vscode.executeLinkProvider',
			'vscode.provideDocumentSemanticTokensLegend',
			'vscode.provideDocumentSemanticTokens',
			'vscode.provideDocumentRangeSemanticTokensLegend'
		]).describe('The VS Code LSP command to execute'),
		uri: z.string().describe('The URI of the document'),
		position: z.object({
			line: z.number(),
			character: z.number()
		}).optional().describe('The position in the document (if required by the command)'),
		query: z.string().optional().describe('A string query (for workspace symbols)'),
	};
	server.registerTool(
		'run_lsp_query',
		{
			description: 'Execute a precise LSP query (e.g. definitions, references, hover) using built-in VS Code commands. Pass the command name and the appropriate arguments.',
			inputSchema: schema,
		},
		// @ts-ignore - TS2589: zod type instantiation too deep for server.tool() generics
		async (args: { command: string; uri: string; position?: { line: number; character: number }; query?: string }) => {
			const { command, uri, position, query } = args;
			logger.debug(`Executing LSP query: ${command} on ${uri}`);
			try {
				const decodedUri = decodeURIComponent(uri);
				const documentUri = decodedUri.startsWith('file:') ? vscode.Uri.parse(decodedUri) : vscode.Uri.file(decodedUri);
				const pos = position ? new vscode.Position(position.line, position.character) : undefined;
				let result: unknown;

				if (command === 'vscode.executeWorkspaceSymbolProvider' && query !== undefined) {
					result = await vscode.commands.executeCommand(command, query);
				} else if (pos) {
					result = await vscode.commands.executeCommand(command, documentUri, pos);
				} else {
					result = await vscode.commands.executeCommand(command, documentUri);
				}

				if (Array.isArray(result) && result.length > 0) {
					const grouped: Record<string, unknown[]> = {};
					const ungrouped: unknown[] = [];
					let hasUri = false;

					for (const unknownItem of result) {
						// Cast to a flexible object temporarily since we just asserted it's in an array
						// and we're looking for specific properties
						const item = unknownItem as Record<string, unknown>;

						if (!item || typeof item !== 'object') {
							ungrouped.push(item);
							continue;
						}

						const uriObj = (item.uri || item.targetUri || (item.location as Record<string, unknown>)?.uri) as { fsPath?: string; toString?: () => string } | undefined;

						if (uriObj && (uriObj.fsPath || typeof uriObj.toString === 'function')) {
							hasUri = true;
							const uriStr = uriObj.fsPath || uriObj.toString!();
							if (!grouped[uriStr]) {
								grouped[uriStr] = [];
							}
							const compactItem = { ...item };
							delete compactItem.uri;
							delete compactItem.targetUri;
							if (compactItem.location && typeof compactItem.location === 'object') {
								const locationObj = compactItem.location as Record<string, unknown>;
								if (locationObj.uri) {
									compactItem.location = { ...locationObj };
									delete (compactItem.location as Record<string, unknown>).uri;
								}
							}
							grouped[uriStr].push(compactItem);
						} else {
							ungrouped.push(item);
						}
					}

					if (hasUri) {
						result = ungrouped.length > 0 ? { grouped, ungrouped } : grouped;
					}
				}

				// Safe stringify handling circular references or overwhelming output
				const replacer = () => {
					const seen = new WeakSet();
					return (key: string, value: unknown) => {
						if (typeof value === 'object' && value !== null) {
							if (seen.has(value)) {
								return '[Circular]';
							}
							seen.add(value);
						}
						// Limit arrays
						if (Array.isArray(value) && value.length > 50) {
							return [...value.slice(0, 50), `... ${value.length - 50} more items`];
						}
						return value;
					};
				};

				const resultString = JSON.stringify(result, replacer(), 2) ?? 'No results found.';
				const explanation = `These are the results of executing ${command} on ${uri}${position ? ` at line ${position.line}, character ${position.character}` : ''}${query ? ` with query "${query}"` : ''}.`;

				if (resultString.length > 50000) {
					const tmpFile = path.join(os.tmpdir(), `lsp_query_result_${Date.now()}.json`);
					await fs.writeFile(tmpFile, resultString);
					logger.trace(`Returning saved file path for LSP query ${command} due to size`);
					return makeTextResult(`${explanation}\n\nThe result is very long and has been saved to: ${tmpFile}`);
				}

				logger.trace(`Returning result for LSP query ${command}`);
				return makeTextResult(`${explanation}\n\n${resultString}`);
			} catch (error) {
				logger.error(`Error executing LSP query ${command}: ${error}`);
				return makeTextResult(`Error executing ${command}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	);
}
