/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as vscode from 'vscode';
import { z } from 'zod';
import { ILogger } from '../../../../../platform/log/common/logService';
import { makeTextResult } from './utils';

export const MAX_RESULT_LENGTH = 50000;

export function registerRunLspQueryTool(server: McpServer, logger: ILogger): void {
	const schema = {
		operation: z.enum([
			'goToDefinition',
			'goToTypeDefinition',
			'goToDeclaration',
			'goToImplementation',
			'findReferences',
			'hover',
			'documentSymbol',
			'workspaceSymbol',
			'incomingCalls',
			'outgoingCalls',
			'rename'
		]).describe('The LSP operation to perform'),
		uri: z.string().optional().describe('The URI of the document (required for most operations except workspaceSymbol)'),
		line: z.number().optional().describe('The 0-based line number (required for position-based operations like definitions, references, hover, etc.)'),
		character: z.number().optional().describe('The 0-based character position within the line (required for position-based operations)'),
		query: z.string().optional().describe('A string query (required for workspaceSymbol)'),
		newName: z.string().optional().describe('The new name for the symbol (required for rename operation)'),
	};
	server.registerTool(
		'run_lsp_query',
		{
			description: `Language Server Protocol tool for code intelligence. Operations:
- goToDefinition: Find where a symbol is defined
- goToTypeDefinition: Find the type definition of a symbol
- goToDeclaration: Find the declaration of a symbol
- goToImplementation: Find implementations of an interface/type
- findReferences: Find all usages of a symbol
- hover: Get type info and documentation
- documentSymbol: List all symbols in a file
- workspaceSymbol: Search symbols across workspace
- incomingCalls: Find what calls a function
- outgoingCalls: Find what a function calls
- rename: Semantically rename a symbol across files

**Operations that require uri + line + character:**
- goToDefinition, goToTypeDefinition, goToDeclaration, goToImplementation, findReferences, hover, incomingCalls, outgoingCalls, rename

**Operations that require uri only:**
- documentSymbol

**Operations that use query parameter:**
- workspaceSymbol (search by name)`,
			inputSchema: schema,
		},
		// @ts-ignore - TS2589: zod type instantiation too deep for server.tool() generics
		async (args: { operation: string; uri?: string; line?: number; character?: number; query?: string; newName?: string }) => {
			const { operation, uri, line, character, query, newName } = args;

			const commandMap: Record<string, string> = {
				'goToDefinition': 'vscode.executeDefinitionProvider',
				'goToTypeDefinition': 'vscode.executeTypeDefinitionProvider',
				'goToDeclaration': 'vscode.executeDeclarationProvider',
				'goToImplementation': 'vscode.executeImplementationProvider',
				'findReferences': 'vscode.executeReferenceProvider',
				'hover': 'vscode.executeHoverProvider',
				'documentSymbol': 'vscode.executeDocumentSymbolProvider',
				'workspaceSymbol': 'vscode.executeWorkspaceSymbolProvider',
				'incomingCalls': 'vscode.provideIncomingCalls',
				'outgoingCalls': 'vscode.provideOutgoingCalls',
				'rename': 'vscode.executeDocumentRenameProvider'
			};

			const command = commandMap[operation];
			if (!command) {
				return makeTextResult(`Unsupported operation: ${operation}`);
			}

			const positionOps = [
				'goToDefinition', 'goToTypeDefinition', 'goToDeclaration',
				'goToImplementation', 'findReferences', 'hover',
				'incomingCalls', 'outgoingCalls', 'rename'
			];
			const fileOps = [...positionOps, 'documentSymbol'];

			if (fileOps.includes(operation) && !uri) {
				return makeTextResult(`The '${operation}' operation requires a 'uri' parameter.`);
			}
			if (positionOps.includes(operation) && (line === undefined || character === undefined)) {
				return makeTextResult(`The '${operation}' operation requires 'line' and 'character' parameters.`);
			}
			if (operation === 'rename' && !newName) {
				return makeTextResult(`The 'rename' operation requires a 'newName' parameter.`);
			}
			if (operation === 'workspaceSymbol' && !query) {
				return makeTextResult(`The 'workspaceSymbol' operation requires a 'query' parameter.`);
			}

			logger.debug(`Executing LSP query: ${operation} (${command})${uri ? ` on ${uri}` : ''}`);
			try {
				let result: unknown;

				if (operation === 'workspaceSymbol' && query !== undefined) {
					result = await vscode.commands.executeCommand(command, query);
				} else {
					if (!uri) {
						return makeTextResult(`The '${operation}' operation requires a 'uri' parameter.`);
					}
					const decodedUri = decodeURIComponent(uri);
					// Important: Do not assume everything without 'file:' is a local path and use Uri.file().
					// We must handle schemas properly for Codespaces/Remote/WSL (vscode-vfs://, vscode-remote://)
					// and unsaved files (untitled:).
					const isSchemeUri = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(decodedUri) || decodedUri.startsWith('untitled:');
					const documentUri = isSchemeUri ? vscode.Uri.parse(decodedUri) : vscode.Uri.file(decodedUri);
					const pos = (line !== undefined && character !== undefined) ? new vscode.Position(line, character) : undefined;

					if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
						if (!pos) {
							return makeTextResult(`The '${operation}' operation requires 'line' and 'character' parameters.`);
						}
						const hierarchyItems = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', documentUri, pos);
						if (!hierarchyItems || hierarchyItems.length === 0) {
							return makeTextResult('No call hierarchy available at this position.');
						}
						result = await vscode.commands.executeCommand(command, hierarchyItems[0]);
					} else if (operation === 'rename' && pos) {
						result = await vscode.commands.executeCommand(command, documentUri, pos, newName);
					} else if (pos) {
						result = await vscode.commands.executeCommand(command, documentUri, pos);
					} else {
						result = await vscode.commands.executeCommand(command, documentUri);
					}
				}

				let formattedResult = '';

				if (Array.isArray(result) && result.length === 0) {
					formattedResult = 'No results found.';
				} else if (operation === 'hover') {
					const hovers = result as vscode.Hover[];
					formattedResult = hovers.map(h =>
						h.contents.map(c => typeof c === 'string' ? c : (c as vscode.MarkdownString).value).join('\n---\n')
					).join('\n===\n') || 'No hover information found.';
				} else if (['goToDefinition', 'goToTypeDefinition', 'goToDeclaration', 'goToImplementation', 'findReferences'].includes(operation)) {
					const locs = (Array.isArray(result) ? result : (result ? [result] : [])) as (vscode.Location | vscode.LocationLink)[];
					if (locs.length === 0) {
						formattedResult = 'No locations found.';
					} else {
						formattedResult = locs.map((loc) => {
							const targetUri = 'targetUri' in loc ? loc.targetUri : loc.uri;
							const targetRange = 'targetRange' in loc ? loc.targetRange : loc.range;
							if (targetUri && targetRange) {
								const fsPath = targetUri.fsPath || targetUri.toString();
								const start = targetRange.start;
								if (start) {
									return `${fsPath}:${start.line + 1}:${start.character + 1}`;
								}
								return fsPath;
							}
							return JSON.stringify(loc);
						}).join('\n');
					}
				} else if (operation === 'documentSymbol' || operation === 'workspaceSymbol') {
					if (!result || (Array.isArray(result) && result.length === 0)) {
						formattedResult = 'No symbols found.';
					} else {
						const symbols = result as (vscode.DocumentSymbol | vscode.SymbolInformation)[];
						const formatSymbol = (s: vscode.DocumentSymbol | vscode.SymbolInformation, indent = ''): string => {
							const name = s.name;
							const kindStr = typeof s.kind === 'number' ? (vscode.SymbolKind[s.kind] || s.kind) : s.kind;
							const detail = 'detail' in s && s.detail ? ` (${s.detail})` : '';

							let posStr = '';
							if ('range' in s && s.range && s.range.start) {
								posStr = ` [Line ${s.range.start.line + 1}]`;
							} else if ('location' in s && s.location && s.location.range && s.location.range.start) {
								const fsPath = s.location.uri ? (s.location.uri.fsPath || s.location.uri.toString()) : '';
								posStr = ` - ${fsPath}:${s.location.range.start.line + 1}`;
							}

							let res = `${indent}- ${name}${detail} [${kindStr}]${posStr}`;
							if ('children' in s && s.children && Array.isArray(s.children)) {
								const childrenStr = s.children.map((c) => formatSymbol(c, indent + '  ')).join('\n');
								res += '\n' + childrenStr;
							}
							return res;
						};
						formattedResult = symbols.map(s => formatSymbol(s)).join('\n');
					}
				} else if (operation === 'rename') {
					// Rename usually returns a WorkspaceEdit
					const we = result as vscode.WorkspaceEdit;
					if (!we) {
						formattedResult = 'Rename operation returned no editable changes.';
					} else {
						// Optionally apply it directly, or describe it
						const applied = await vscode.workspace.applyEdit(we);
						if (applied) {
							formattedResult = `Successfully renamed symbol to "${newName}". Workspace edits were applied.`;
						} else {
							formattedResult = `Failed to apply rename edits.`;
						}
					}
				} else if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
					const calls = result as (vscode.CallHierarchyIncomingCall | vscode.CallHierarchyOutgoingCall)[];
					if (!calls || calls.length === 0) {
						formattedResult = 'No calls found.';
					} else {
						formattedResult = calls.map(c => {
							const item = 'from' in c ? c.from : (c as vscode.CallHierarchyOutgoingCall).to;
							const fsPath = item.uri.fsPath || item.uri.toString();
							return `- ${item.name} (${item.detail || ''}) in ${fsPath}:${item.range.start.line + 1}`;
						}).join('\n');
					}
				} else {
					// Fallback for calls structure or unknowns
					const replacer = () => {
						const seen = new WeakSet();
						return (key: string, value: unknown) => {
							if (typeof value === 'object' && value !== null) {
								if (seen.has(value)) {
									return '[Circular]';
								}
								seen.add(value);
							}
							if (Array.isArray(value) && value.length > 50) {
								return [...value.slice(0, 50), `... ${value.length - 50} more items`];
							}
							return value;
						};
					};
					formattedResult = JSON.stringify(result, replacer(), 2) ?? 'No results found.';
				}

				const explanation = `These are the results of executing ${operation} ${uri ? `on ${uri}` : ''}${(line !== undefined && character !== undefined) ? ` at line ${line}, character ${character}` : ''}${query ? ` with query "${query}"` : ''}${newName ? ` to new name "${newName}"` : ''}.`;

				if (formattedResult.length > MAX_RESULT_LENGTH) {
					const truncated = formattedResult.slice(0, MAX_RESULT_LENGTH);
					logger.trace(`Truncating result for LSP query ${operation} due to size`);
					return makeTextResult(`${explanation}\n\nThe result is very long (${formattedResult.length} characters) and has been truncated to the first ${MAX_RESULT_LENGTH} characters:\n\n${truncated}\n\n... (truncated)`);
				}

				logger.trace(`Returning result for LSP query ${operation}`);
				return makeTextResult(`${explanation}\n\n${formattedResult}`);
			} catch (error) {
				logger.error(`Error executing LSP query ${operation}: ${error}`);
				return makeTextResult(`Error executing ${operation}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	);
}
