/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import * as extpath from '../../../util/vs/base/common/extpath';
import { isEqualOrParent, normalizePath } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { MEMORY_DIR_NAME } from '../common/agentMemoryService';
import { ICopilotModelSpecificTool, ToolRegistry } from '../common/toolsRegistry';

interface IMemoryParams {
	command: 'view' | 'create' | 'str_replace' | 'insert' | 'delete' | 'rename';
	path?: string;
	view_range?: [number, number];
	file_text?: string;
	old_str?: string;
	new_str?: string;
	insert_line?: number;
	insert_text?: string;
	old_path?: string;
	new_path?: string;
}

interface MemoryResult {
	success?: string;
	error?: string;
}

/**
 * All memory operations are confined to the /memories directory within the extension's
 * workspace-specific storage location. Each workspace maintains its own isolated memory.
 */
class MemoryTool implements ICopilotModelSpecificTool<IMemoryParams> {
	private static readonly SESSION_PATH_PREFIX = '/memories/session';

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystem: IFileSystemService
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IMemoryParams>, _token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const params = options.input;
		const sessionResource = (options.toolInvocationToken as any)?.sessionResource;
		const sessionId = this.extractSessionId(sessionResource);
		const result = await this.execute(params, sessionId);

		const resultText = result.error
			? `Error: ${result.error}`
			: result.success || '';

		return new LanguageModelToolResult([
			new LanguageModelTextPart(resultText)
		]);
	}

	private extractSessionId(chatSessionResource: vscode.Uri | undefined): string | undefined {
		if (!chatSessionResource) {
			return undefined;
		}
		const path = chatSessionResource.path;
		const pathSegments = path.split('/').filter(s => s.length > 0);
		return pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : undefined;
	}

	private async execute(params: IMemoryParams, sessionId: string | undefined): Promise<MemoryResult> {
		const command = params.command;

		try {
			switch (command) {
				case 'view':
					return await this._view(params, sessionId);
				case 'create':
					return await this._create(params, sessionId);
				case 'str_replace':
					return await this._strReplace(params, sessionId);
				case 'insert':
					return await this._insert(params, sessionId);
				case 'delete':
					return await this._delete(params, sessionId);
				case 'rename':
					return await this._rename(params, sessionId);
				default:
					return {
						error: `Unknown command: ${command}. ` +
							'Supported commands: view, create, str_replace, insert, delete, rename'
					};
			}
		} catch (error) {
			if (error.message) {
				return { error: error.message };
			}
			return { error: `Unexpected error executing ${command}: ${error}` };
		}
	}

	/**
	 * Translate /memories/session paths to use the actual session ID.
	 * Paths like /memories/session/prefs.md become /memories/sessions/<sessionId>/prefs.md
	 */
	private translateSessionPath(memoryPath: string, sessionId: string | undefined): string {
		const normalizedPath = extpath.toPosixPath(memoryPath);

		// Check if path starts with /memories/session
		if (normalizedPath === MemoryTool.SESSION_PATH_PREFIX ||
			normalizedPath.startsWith(MemoryTool.SESSION_PATH_PREFIX + '/')) {

			if (!sessionId) {
				throw new Error('Session ID is not available. Session memory operations require an active chat session.');
			}

			// Replace /memories/session with /memories/sessions/<sessionId>
			const suffix = normalizedPath.substring(MemoryTool.SESSION_PATH_PREFIX.length);
			return `/memories/sessions/${sessionId}${suffix}`;
		}

		return memoryPath;
	}

	/**
	 * Validate and resolve memory paths to prevent directory traversal attacks.
	 */
	private validatePath(memoryPath: string, sessionId: string | undefined): URI {

		const storageUri = this.extensionContext.storageUri;
		if (!storageUri) {
			// TODO @bhavya disable tool when no workspace open
			throw new Error('No workspace is currently open. Memory operations require an active workspace.');
		}

		// Translate session paths to use actual session ID
		const translatedPath = this.translateSessionPath(memoryPath, sessionId);
		const normalizedPath = extpath.toPosixPath(translatedPath);

		// Validate that path starts with /memories as required by spec
		if (!normalizedPath.startsWith('/memories')) {
			throw new Error(
				`Path must start with /memories, got: ${memoryPath}. ` +
				'All memory operations must be confined to the /memories directory.'
			);
		}

		// Extract relative path after /memories
		const relativePath = normalizedPath.substring('/memories'.length).replace(/^\/+/, '');
		const memoryRoot = URI.joinPath(storageUri, MEMORY_DIR_NAME);
		const pathSegments = relativePath ? relativePath.split('/').filter(s => s.length > 0) : [];
		const fullPath = pathSegments.length > 0
			? URI.joinPath(memoryRoot, ...pathSegments)
			: memoryRoot;

		const normalizedFullPath = normalizePath(fullPath);
		const normalizedMemoryRoot = normalizePath(memoryRoot);
		if (!isEqualOrParent(normalizedFullPath, normalizedMemoryRoot)) {
			throw new Error(
				`Path '${memoryPath}' would escape /memories directory. ` +
				'Directory traversal attempts are not allowed.'
			);
		}
		return normalizedFullPath;
	}

	private async _view(params: IMemoryParams, sessionId: string | undefined): Promise<MemoryResult> {
		const memoryPath = params.path;
		const viewRange = params.view_range;

		if (!memoryPath) {
			return { error: 'Missing required parameter: path' };
		}

		const fullPath = this.validatePath(memoryPath, sessionId);
		try {
			const stat = await this.fileSystem.stat(fullPath);

			if (stat.type === 2 /* Directory */) {
				try {
					const entries = await this.fileSystem.readDirectory(fullPath);
					const items = entries
						.filter(([name]) => !name.startsWith('.'))
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([name, type]) => type === 2 ? `${name}/` : name);

					if (items.length === 0) {
						return { success: `Directory: ${memoryPath}\n(empty)` };
					}

					return {
						success: `Directory: ${memoryPath}\n${items.map(item => `- ${item}`).join('\n')}`
					};
				} catch (error) {
					return { error: `Cannot read directory ${memoryPath}: ${error.message}` };
				}
			}

			if (stat.type === 1 /* File */) {
				try {
					const content = await this.fileSystem.readFile(fullPath);
					const text = new TextDecoder('utf-8').decode(content);
					const lines = text.split('\n');

					// Apply view range if specified
					let displayLines = lines;
					let startNum = 1;

					if (viewRange) {
						const startLine = Math.max(1, viewRange[0]) - 1; // Convert to 0-indexed
						const endLine = viewRange[1] === -1 ? lines.length : viewRange[1];
						displayLines = lines.slice(startLine, endLine);
						startNum = startLine + 1;

						// Format with line numbers when using view_range
						const numberedLines = displayLines.map((line, i) =>
							`${String(i + startNum).padStart(4, ' ')}: ${line}`
						);
						return { success: numberedLines.join('\n') };
					}

					// Return raw content when no view_range specified
					return { success: text };
				} catch (error) {
					if (error.message?.includes('decode')) {
						return { error: `Cannot read ${memoryPath}: File is not valid UTF-8 text` };
					}
					return { error: `Cannot read file ${memoryPath}: ${error.message}` };
				}
			}
			return { error: `Path not found: ${memoryPath}` };
		} catch {
			return { error: `Path not found: ${memoryPath}` };
		}
	}

	/**
	 * Create or overwrite a file.
	 */
	private async _create(params: IMemoryParams, sessionId: string | undefined): Promise<MemoryResult> {
		const memoryPath = params.path;
		const fileText = params.file_text ?? '';

		if (!memoryPath) {
			return { error: 'Missing required parameter: path' };
		}

		const fullPath = this.validatePath(memoryPath, sessionId);
		try {
			const parentDir = URI.joinPath(fullPath, '..');
			await this.fileSystem.createDirectory(parentDir);

			const content = new TextEncoder().encode(fileText);
			await this.fileSystem.writeFile(fullPath, content);

			return { success: `File created successfully at ${memoryPath}` };
		} catch (error) {
			return { error: `Cannot create file ${memoryPath}: ${error.message}` };
		}
	}

	/**
	 * Replace text in a file.
	 */
	private async _strReplace(params: IMemoryParams, sessionId: string | undefined): Promise<MemoryResult> {
		const memoryPath = params.path;
		const oldStr = params.old_str;
		const newStr = params.new_str ?? '';

		if (!memoryPath || oldStr === undefined) {
			return { error: 'Missing required parameters: path, old_str' };
		}

		const fullPath = this.validatePath(memoryPath, sessionId);
		try {
			const stat = await this.fileSystem.stat(fullPath);
			if (stat.type !== 1 /* File */) {
				return { error: `Not a file: ${memoryPath}` };
			}

			const contentBytes = await this.fileSystem.readFile(fullPath);
			const content = new TextDecoder('utf-8').decode(contentBytes);

			// Count occurrences using exact literal matching
			const matchPositions: number[] = [];
			for (let searchIdx = 0; ;) {
				const idx = content.indexOf(oldStr, searchIdx);
				if (idx === -1) { break; }
				matchPositions.push(idx);
				searchIdx = idx + oldStr.length;
			}
			const count = matchPositions.length;
			if (count === 0) {
				return {
					error: `String not found in ${memoryPath}. ` +
						'The old_str must exist in the file.'
				};
			}
			if (count > 1) {
				return {
					error: `String appears ${count} times in ${memoryPath}. ` +
						'The string must be unique. Use more specific context.'
				};
			}

			const matchIdx = matchPositions[0];
			const newContent = content.slice(0, matchIdx) + newStr + content.slice(matchIdx + oldStr.length);
			const newContentBytes = new TextEncoder().encode(newContent);
			await this.fileSystem.writeFile(fullPath, newContentBytes);

			return { success: `File ${memoryPath} has been edited successfully` };
		} catch (error) {
			return { error: `Cannot edit file ${memoryPath}: ${error.message}` };
		}
	}

	/**
	 * Insert text at a specific line.
	 */
	private async _insert(params: IMemoryParams, sessionId: string | undefined): Promise<MemoryResult> {
		const memoryPath = params.path;
		const insertLine = params.insert_line;
		const insertText = params.insert_text ?? '';

		if (!memoryPath || insertLine === undefined) {
			return { error: 'Missing required parameters: path, insert_line' };
		}

		const fullPath = this.validatePath(memoryPath, sessionId);
		try {
			const stat = await this.fileSystem.stat(fullPath);
			if (stat.type !== 1 /* File */) {
				return { error: `Not a file: ${memoryPath}` };
			}

			const contentBytes = await this.fileSystem.readFile(fullPath);
			const content = new TextDecoder('utf-8').decode(contentBytes);
			const lines = content.split('\n');

			if (insertLine < 0 || insertLine > lines.length) {
				return {
					error: `Invalid line number ${insertLine}. File has ${lines.length} lines. ` +
						'insert_line must be between 0 and file length (0 = before first line).'
				};
			}

			// Insert the text
			lines.splice(insertLine, 0, insertText);
			const newContent = lines.join('\n');
			const newContentBytes = new TextEncoder().encode(newContent);
			await this.fileSystem.writeFile(fullPath, newContentBytes);

			return { success: `Text inserted at line ${insertLine} in ${memoryPath}` };
		} catch (error) {
			return { error: `Cannot insert into file ${memoryPath}: ${error.message}` };
		}
	}

	/**
	 * Delete a file or directory.
	 */
	private async _delete(params: IMemoryParams, sessionId: string | undefined): Promise<MemoryResult> {
		const memoryPath = params.path;

		if (!memoryPath) {
			return { error: 'Missing required parameter: path' };
		}

		const fullPath = this.validatePath(memoryPath, sessionId);
		try {
			const stat = await this.fileSystem.stat(fullPath);

			if (stat.type === 1 /* File */) {
				await this.fileSystem.delete(fullPath);
				return { success: `File deleted: ${memoryPath}` };
			} else if (stat.type === 2 /* Directory */) {
				await this.fileSystem.delete(fullPath, { recursive: true });
				return { success: `Directory deleted: ${memoryPath}` };
			}
			return { error: `Path not found: ${memoryPath}` };
		} catch {
			return { error: `Path not found: ${memoryPath}` };
		}
	}

	/**
	 * Rename or move a file/directory.
	 */
	private async _rename(params: IMemoryParams, sessionId: string | undefined): Promise<MemoryResult> {
		const oldPath = params.old_path;
		const newPath = params.new_path;

		if (!oldPath || !newPath) {
			return { error: 'Missing required parameters: old_path, new_path' };
		}

		const oldFullPath = this.validatePath(oldPath, sessionId);
		const newFullPath = this.validatePath(newPath, sessionId);

		try {
			const newParentDir = URI.joinPath(newFullPath, '..');
			try {
				await this.fileSystem.stat(newParentDir);
			} catch {
				await this.fileSystem.createDirectory(newParentDir);
			}

			await this.fileSystem.rename(oldFullPath, newFullPath, { overwrite: false });
			return { success: `Successfully moved/renamed: ${oldPath} -> ${newPath}` };
		} catch (error) {
			return { error: `Cannot rename: ${error.message}` };
		}
	}
}

ToolRegistry.registerModelSpecificTool(
	{
		name: 'copilot_memory',
		toolReferenceName: 'memory',
		displayName: 'Memory',
		description: 'Manage persistent memory across conversations. This tool allows you to create, view, update, and delete memory files that persist between chat sessions. Use this to remember important information about the user, their preferences, project context, or anything that should be recalled in future conversations. Available commands: view (list/read memories), create (new memory file), str_replace (edit content), insert (add content), delete (remove memory), rename (change filename).',
		userDescription: 'Manage persistent memory files across conversations',
		source: undefined,
		tags: [],
		models: [
			{ id: 'claude-opus-4.5' },
			{ id: 'claude-sonnet-4.5' },
			{ id: 'claude-haiku-4.5' },
		],
		toolSet: 'vscode',
		inputSchema: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
					description: 'The memory operation to perform:\n- view: Show directory contents or file contents (optional line ranges)\n- create: Create or overwrite a file\n- str_replace: Replace text in a file\n- insert: Insert text at a specific line\n- delete: Delete a file or directory\n- rename: Rename or move a file or directory'
				},
				path: {
					type: 'string',
					description: 'Path to the memory file or directory. Must start with /memories.\n- For view: /memories or /memories/file.md\n- For create/str_replace/insert/delete: /memories/file.md\n- Not used for rename (use old_path/new_path instead)'
				},
				view_range: {
					type: 'array',
					items: { type: 'number' },
					minItems: 2,
					maxItems: 2,
					description: '[view only] Optional line range [start, end] to view specific lines. Example: [1, 10]'
				},
				file_text: {
					type: 'string',
					description: '[create only] Content to write to the file. Required for create command.'
				},
				old_str: {
					type: 'string',
					description: '[str_replace only] The exact literal text to find and replace. Must be unique in the file. Required for str_replace command.'
				},
				new_str: {
					type: 'string',
					description: '[str_replace only] The exact literal text to replace old_str with. Can be empty string. Required for str_replace command.'
				},
				insert_line: {
					type: 'number',
					description: '[insert only] Line number at which to insert text (0-indexed, 0 = before first line). Required for insert command.'
				},
				insert_text: {
					type: 'string',
					description: '[insert only] Text to insert at the specified line. Required for insert command.'
				},
				old_path: {
					type: 'string',
					description: '[rename only] Current path of the file or directory. Must start with /memories. Required for rename command.'
				},
				new_path: {
					type: 'string',
					description: '[rename only] New path for the file or directory. Must start with /memories. Required for rename command.'
				}
			},
			required: ['command']
		}
	},
	MemoryTool
);
