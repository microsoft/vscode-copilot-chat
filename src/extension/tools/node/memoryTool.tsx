/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { createDirectoryIfNotExists, IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../platform/filesystem/common/fileTypes';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { IAgentMemoryService, RepoMemoryEntry } from '../common/agentMemoryService';
import { IMemoryCleanupService } from '../common/memoryCleanupService';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

const MEMORY_BASE_DIR = 'memory-tool/memories';
const REPO_PATH_PREFIX = '/memories/repo';
const SESSION_PATH_PREFIX = '/memories/session';

type MemoryScope = 'user' | 'session';

interface IViewParams {
	command: 'view';
	path: string;
	view_range?: [number, number];
}

interface ICreateParams {
	command: 'create';
	path: string;
	file_text: string;
}

interface IStrReplaceParams {
	command: 'str_replace';
	path: string;
	old_str: string;
	new_str: string;
}

interface IInsertParams {
	command: 'insert';
	path: string;
	insert_line: number;
	insert_text?: string;
	/** Models sometimes send `new_str` instead of `insert_text` */
	new_str?: string;
}

interface IDeleteParams {
	command: 'delete';
	path: string;
}

interface IRenameParams {
	command: 'rename';
	old_path?: string;
	new_path: string;
	/** Models sometimes send `path` instead of `old_path` */
	path?: string;
}

type MemoryToolParams = IViewParams | ICreateParams | IStrReplaceParams | IInsertParams | IDeleteParams | IRenameParams;

function normalizePath(path: string): string {
	return path.endsWith('/') ? path : path + '/';
}

function isMemoriesRoot(path: string): boolean {
	return normalizePath(path) === '/memories/';
}

function validatePath(path: string): string | undefined {
	if (!normalizePath(path).startsWith('/memories/')) {
		return 'Error: All memory paths must start with /memories/';
	}
	if (path.includes('..')) {
		return 'Error: Path traversal is not allowed';
	}
	// Reject paths with empty segments (e.g. /memories//etc) or that resolve outside the base
	const segments = path.split('/').filter(s => s.length > 0);
	if (segments.some(s => s === '.')) {
		return 'Error: Path traversal is not allowed';
	}
	// After splitting, first segment must be "memories"
	if (segments[0] !== 'memories') {
		return 'Error: All memory paths must start with /memories/';
	}
	return undefined;
}

function isRepoPath(path: string): boolean {
	return path === REPO_PATH_PREFIX || path.startsWith(REPO_PATH_PREFIX + '/');
}

function isSessionPath(path: string): boolean {
	return path === SESSION_PATH_PREFIX || path.startsWith(SESSION_PATH_PREFIX + '/');
}

/**
 * Extracts a safe directory name from a chatSessionResource URI string.
 * The URI is typically like `vscode-chat-session://local/<sessionId>`.
 */
export function extractSessionId(sessionResource: string): string {
	const parsed = URI.parse(sessionResource);
	// Extract the last path segment as the session ID
	const segments = parsed.path.replace(/^\//, '').split('/');
	const raw = segments[segments.length - 1] || parsed.authority || 'unknown';
	// Sanitize to only safe characters for a directory name
	return raw.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function formatLineNumber(line: number): string {
	return String(line).padStart(6, ' ');
}

function formatFileContent(path: string, content: string): string {
	const lines = content.split('\n');
	const numbered = lines.map((line, i) => `${formatLineNumber(i + 1)}\t${line}`);
	return `Here's the content of ${path} with line numbers:\n${numbered.join('\n')}`;
}

function makeSnippet(fileContent: string, editLine: number, path: string): string {
	const lines = fileContent.split('\n');
	const snippetRadius = 4;
	const start = Math.max(0, editLine - 1 - snippetRadius);
	const end = Math.min(lines.length, editLine - 1 + snippetRadius + 1);
	const snippet = lines.slice(start, end);
	const numbered = snippet.map((line, i) => `${formatLineNumber(start + i + 1)}\t${line}`);
	return `The memory file has been edited. Here's the result of running \`cat -n\` on a snippet of ${path}:\n${numbered.join('\n')}`;
}

// --- Tool implementation ---

export class MemoryTool implements ICopilotTool<MemoryToolParams> {
	public static readonly toolName = ToolName.Memory;

	constructor(
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IAgentMemoryService private readonly agentMemoryService: IAgentMemoryService,
		@IMemoryCleanupService private readonly memoryCleanupService: IMemoryCleanupService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) {
		if (this.configurationService.getExperimentBasedConfig(ConfigKey.MemoryToolEnabled, this.experimentationService)) {
			this.memoryCleanupService.start();
		}
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<MemoryToolParams>, _token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const command = options.input.command;
		const path = command === 'rename' ? (options.input as IRenameParams).old_path ?? (options.input as IRenameParams).path : options.input.path;
		const fileName = path ? path.split('/').pop() || path : undefined;
		const suffix = fileName && !isRepoPath(path!) ? ` ${fileName}` : '';
		switch (command) {
			case 'view':
				return { invocationMessage: l10n.t('Reading memory{0}', suffix), pastTenseMessage: l10n.t('Read memory{0}', suffix) };
			case 'create':
				return { invocationMessage: l10n.t('Creating memory file{0}', suffix), pastTenseMessage: l10n.t('Created memory file{0}', suffix) };
			case 'str_replace':
				return { invocationMessage: l10n.t('Updating memory file{0}', suffix), pastTenseMessage: l10n.t('Updated memory file{0}', suffix) };
			case 'insert':
				return { invocationMessage: l10n.t('Inserting into memory file{0}', suffix), pastTenseMessage: l10n.t('Inserted into memory file{0}', suffix) };
			case 'delete':
				return { invocationMessage: l10n.t('Deleting memory{0}', suffix), pastTenseMessage: l10n.t('Deleted memory{0}', suffix) };
			case 'rename':
				return { invocationMessage: l10n.t('Renaming memory{0}', suffix), pastTenseMessage: l10n.t('Renamed memory{0}', suffix) };
			default:
				return { invocationMessage: l10n.t`Updating memory`, pastTenseMessage: l10n.t`Updated memory` };
		}
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<MemoryToolParams>, _token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const params = options.input;
		const sessionResource = options.chatSessionResource?.toString();
		const resultText = await this._dispatch(params, sessionResource);
		return new LanguageModelToolResult([new LanguageModelTextPart(resultText)]);
	}


	private async _dispatch(params: MemoryToolParams, sessionResource?: string): Promise<string> {
		const path = params.command === 'rename' ? (params.old_path ?? params.path) : params.path;
		if (!path) {
			return 'Error: Missing required path parameter.';
		}
		const pathError = validatePath(path);
		if (pathError) {
			return pathError;
		}

		// Route /memories/repo/* to CAPI (only create is supported)
		if (isRepoPath(path)) {
			return this._dispatchRepo(params, path);
		}

		// Route /memories/session/* to session-scoped local storage
		// Everything else under /memories/* goes to user-scoped storage
		const scope: MemoryScope = isSessionPath(path) ? 'session' : 'user';
		return this._dispatchLocal(params, scope, sessionResource);
	}

	private async _dispatchRepo(params: MemoryToolParams, path: string): Promise<string> {
		switch (params.command) {
			case 'create':
				return this._repoCreate(params);
			default:
				return `Error: The '${params.command}' operation is not supported for repository memories at ${path}. Only 'create' is allowed for /memories/repo/.`;
		}
	}

	private async _repoCreate(params: ICreateParams): Promise<string> {
		try {
			const isEnabled = await this.agentMemoryService.checkMemoryEnabled();
			if (!isEnabled) {
				return 'Error: Copilot Memory is not enabled. Repository memory operations require Copilot Memory to be enabled.';
			}

			// Derive subject/category hint from the path (e.g. /memories/repo/testing.json → "testing")
			const filename = params.path.split('/').pop() || 'memory';
			const pathHint = filename.replace(/\.\w+$/, '');

			// Parse the file_text as a memory entry.
			// Accept either a JSON-formatted entry or a plain text fact.
			let entry: RepoMemoryEntry;
			try {
				const parsed = JSON.parse(params.file_text);
				entry = {
					subject: parsed.subject || pathHint,
					fact: parsed.fact || '',
					citations: parsed.citations || '',
					reason: parsed.reason || '',
					category: parsed.category || pathHint,
				};
			} catch {
				// Plain text: treat the whole content as a fact, use path as subject
				entry = {
					subject: pathHint,
					fact: params.file_text,
					citations: '',
					reason: 'Stored from memory tool create command.',
					category: pathHint,
				};
			}

			const success = await this.agentMemoryService.storeRepoMemory(entry);
			if (success) {
				return `File created successfully at: ${params.path}`;
			} else {
				return 'Error: Failed to store repository memory entry.';
			}
		} catch (error) {
			this.logService.error('[MemoryTool] Error creating repo memory:', error);
			return `Error: Cannot create repository memory: ${error.message}`;
		}
	}

	private _resolveUri(memoryPath: string, scope: MemoryScope, sessionResource?: string): URI {
		// Validate path format and extract relative path components safely
		const pathError = validatePath(memoryPath);
		if (pathError) {
			throw new Error(pathError);
		}

		// Extract path components by splitting, skipping empty and special segments
		const segments = memoryPath.split('/').filter(s => s.length > 0);
		// segments[0] is 'memories', segments[1] might be 'session', rest are file path components
		let relativeSegments: string[];

		if (scope === 'session') {
			const storageUri = this.extensionContext.storageUri;
			if (!storageUri) {
				throw new Error('No workspace storage available. Session memory operations require an active workspace.');
			}
			// For session paths: /memories/session/foo.md → ['memories', 'session', 'foo.md']
			// Skip 'memories' and 'session', keep rest
			relativeSegments = segments.slice(2);

			const baseUri = URI.from(storageUri);
			let resolved: URI;
			if (sessionResource) {
				const sessionId = extractSessionId(sessionResource);
				resolved = relativeSegments.length > 0
					? URI.joinPath(baseUri, MEMORY_BASE_DIR, sessionId, ...relativeSegments)
					: URI.joinPath(baseUri, MEMORY_BASE_DIR, sessionId);
			} else {
				resolved = relativeSegments.length > 0
					? URI.joinPath(baseUri, MEMORY_BASE_DIR, ...relativeSegments)
					: URI.joinPath(baseUri, MEMORY_BASE_DIR);
			}
			if (!this.memoryCleanupService.isMemoryUri(resolved)) {
				throw new Error('Resolved path escapes the memory storage directory.');
			}
			return resolved;
		}

		// User scope: /memories/foo.md → ['memories', 'foo.md']
		// Skip 'memories', keep rest
		relativeSegments = segments.slice(1);

		const globalStorageUri = this.extensionContext.globalStorageUri;
		if (!globalStorageUri) {
			throw new Error('No global storage available. User memory operations require global storage.');
		}
		const resolved = relativeSegments.length > 0
			? URI.joinPath(globalStorageUri, MEMORY_BASE_DIR, ...relativeSegments)
			: URI.joinPath(globalStorageUri, MEMORY_BASE_DIR);
		return resolved;
	}

	private async _dispatchLocal(params: MemoryToolParams, scope: MemoryScope, sessionResource?: string): Promise<string> {
		try {
			switch (params.command) {
				case 'view':
					return this._localView(params.path, params.view_range, scope, sessionResource);
				case 'create':
					return this._localCreate(params, scope, sessionResource);
				case 'str_replace':
					return this._localStrReplace(params, scope, sessionResource);
				case 'insert':
					return this._localInsert(params, scope, sessionResource);
				case 'delete':
					return this._localDelete(params.path, scope, sessionResource);
				case 'rename':
					return this._localRename(params, scope, sessionResource);
				default:
					return `Error: Unknown command '${(params as MemoryToolParams).command}'.`;
			}
		} catch (error) {
			this.logService.error('[MemoryTool] Local operation error:', error);
			return `Error: ${error.message}`;
		}
	}

	private async _localView(path: string, viewRange?: [number, number], scope: MemoryScope = 'user', sessionResource?: string): Promise<string> {
		// When viewing the top-level /memories/ directory with user scope, merge user + session contents
		if (scope === 'user' && isMemoriesRoot(path)) {
			return this._localViewMergedRoot(path, sessionResource);
		}

		const uri = this._resolveUri(path, scope, sessionResource);
		if (scope === 'session') {
			this.memoryCleanupService.markAccessed(uri);
		}

		let fileStat: vscode.FileStat;
		try {
			fileStat = await this.fileSystemService.stat(uri);
		} catch {
			this.logService.debug(`[MemoryTool] Failed to stat ${path}`);
			if (isMemoriesRoot(path)) {
				return 'No memories found.';
			}
			return `No memories found in ${path}.`;
		}

		if (fileStat.type === FileType.Directory) {
			return this._listDirectory(path, uri);
		}

		// Read file contents with line numbers
		const content = await this.fileSystemService.readFile(uri);
		const text = new TextDecoder().decode(content);
		this.logService.debug(`[MemoryTool] Viewed memory file: ${path}`);

		if (viewRange) {
			const lines = text.split('\n');
			const [start, end] = viewRange;
			if (start < 1 || start > lines.length) {
				return `Error: Invalid view_range: start line ${start} is out of range [1, ${lines.length}].`;
			}
			if (end < start || end > lines.length) {
				return `Error: Invalid view_range: end line ${end} is out of range [${start}, ${lines.length}].`;
			}
			const sliced = lines.slice(start - 1, end);
			const numbered = sliced.map((line, i) => `${formatLineNumber(start + i)}\t${line}`);
			return `Here's the content of ${path} (lines ${start}-${end}) with line numbers:\n${numbered.join('\n')}`;
		}

		return formatFileContent(path, text);
	}

	private async _localViewMergedRoot(path: string, sessionResource?: string): Promise<string> {
		const lines: string[] = [];

		// List user-scoped files
		try {
			const userUri = this._resolveUri('/memories/', 'user');
			const userEntries = await this.fileSystemService.readDirectory(userUri);
			for (const [name, type] of userEntries) {
				if (name.startsWith('.')) {
					continue;
				}
				if (type === FileType.Directory) {
					lines.push(`/memories/${name}/`);
				} else {
					lines.push(`/memories/${name}`);
				}
			}
		} catch {
			// User storage may not exist yet
		}

		// List current session's files under session/
		if (sessionResource) {
			try {
				const sessionUri = this._resolveUri('/memories/session/', 'session', sessionResource);
				const sessionEntries = await this.fileSystemService.readDirectory(sessionUri);
				const sessionFiles: string[] = [];
				for (const [name, type] of sessionEntries) {
					if (name.startsWith('.')) {
						continue;
					}
					if (type === FileType.File) {
						sessionFiles.push(`/memories/session/${name}`);
					}
				}
				// Add session/ header if there are files
				if (sessionFiles.length > 0) {
					lines.push('/memories/session/');
					lines.push(...sessionFiles);
				} else {
					// Add session/ entry even if empty, to show it exists
					lines.push('/memories/session/');
				}
			} catch {
				// Session storage may not exist yet, but still mention it
				lines.push('/memories/session/');
			}
		} else {
			// No session resource, still mention session directory exists
			lines.push('/memories/session/');
		}

		if (lines.length === 0 || (lines.length === 1 && lines[0] === '/memories/session/')) {
			return 'No memories found.';
		}

		return `Here are the files and directories in ${path}:\n${lines.join('\n')}`;
	}

	private async _listDirectory(path: string, uri: URI, maxDepth: number = 2, currentDepth: number = 0): Promise<string> {
		if (currentDepth >= maxDepth) {
			return '';
		}

		const entries = await this.fileSystemService.readDirectory(uri);
		const lines: string[] = [];

		// Sort: directories first, then files. Exclude hidden items and the repo directory (CAPI-backed).
		const sorted = entries
			.filter(([name]) => !name.startsWith('.') && name !== 'repo')
			.sort(([, a], [, b]) => {
				if (a === FileType.Directory && b !== FileType.Directory) {
					return -1;
				}
				if (a !== FileType.Directory && b === FileType.Directory) {
					return 1;
				}
				return 0;
			});

		for (const [name, type] of sorted) {
			const childUri = URI.joinPath(uri, name);
			const childPath = path.endsWith('/') ? `${path}${name}` : `${path}/${name}`;
			const prefix = '  '.repeat(currentDepth);

			if (type === FileType.Directory) {
				lines.push(`${prefix}${name}/`);
				const subLines = await this._listDirectory(childPath, childUri, maxDepth, currentDepth + 1);
				if (subLines) {
					lines.push(subLines);
				}
			} else {
				try {
					const stat = await this.fileSystemService.stat(childUri);
					lines.push(`${prefix}${stat.size}\t${childPath}`);
				} catch {
					lines.push(`${prefix}${name}`);
				}
			}
		}

		if (currentDepth === 0) {
			return `Here are the files and directories up to 2 levels deep in ${path}, excluding hidden items:\n${lines.join('\n')}`;
		}
		return lines.join('\n');
	}

	private async _localCreate(params: ICreateParams, scope: MemoryScope, sessionResource?: string): Promise<string> {
		const uri = this._resolveUri(params.path, scope, sessionResource);

		// Check if file exists
		try {
			await this.fileSystemService.stat(uri);
			this.logService.debug(`[MemoryTool] Create failed - file already exists: ${params.path}`);
			return `Error: File ${params.path} already exists`;
		} catch {
			// File doesn't exist — good
		}

		try {
			// Ensure parent directory exists
			const parentUri = URI.joinPath(uri, '..');
			await createDirectoryIfNotExists(this.fileSystemService, parentUri);

			const content = new TextEncoder().encode(params.file_text);
			await this.fileSystemService.writeFile(uri, content);
			if (scope === 'session') {
				this.memoryCleanupService.markAccessed(uri);
			}
			this.logService.debug(`[MemoryTool] Created memory file: ${params.path}`);
			return `File created successfully at: ${params.path}`;
		} catch (error) {
			this.logService.error(`[MemoryTool] Failed to create file ${params.path}:`, error);
			throw error;
		}
	}

	private async _localStrReplace(params: IStrReplaceParams, scope: MemoryScope, sessionResource?: string): Promise<string> {
		const uri = this._resolveUri(params.path, scope, sessionResource);
		if (scope === 'session') {
			this.memoryCleanupService.markAccessed(uri);
		}

		let content: string;
		try {
			const buffer = await this.fileSystemService.readFile(uri);
			content = new TextDecoder().decode(buffer);
		} catch {
			this.logService.debug(`[MemoryTool] str_replace failed - file not found: ${params.path}`);
			return `The path ${params.path} does not exist. Please provide a valid path.`;
		}

		const occurrences: number[] = [];
		let searchStart = 0;
		while (true) {
			const idx = content.indexOf(params.old_str, searchStart);
			if (idx === -1) {
				break;
			}
			const lineNumber = content.substring(0, idx).split('\n').length;
			occurrences.push(lineNumber);
			searchStart = idx + 1;
		}

		if (occurrences.length === 0) {
			this.logService.debug(`[MemoryTool] str_replace failed - pattern not found in ${params.path}`);
			return `No replacement was performed, old_str \`${params.old_str}\` did not appear verbatim in ${params.path}.`;
		}

		if (occurrences.length > 1) {
			this.logService.debug(`[MemoryTool] str_replace failed - multiple matches in ${params.path}`);
			return `No replacement was performed. Multiple occurrences of old_str \`${params.old_str}\` in lines: ${occurrences.join(', ')}. Please ensure it is unique.`;
		}

		const newContent = content.replace(params.old_str, params.new_str);
		await this.fileSystemService.writeFile(uri, new TextEncoder().encode(newContent));
		this.logService.debug(`[MemoryTool] Updated memory file: ${params.path}`);
		return makeSnippet(newContent, occurrences[0], params.path);
	}

	private async _localInsert(params: IInsertParams, scope: MemoryScope, sessionResource?: string): Promise<string> {
		const uri = this._resolveUri(params.path, scope, sessionResource);
		if (scope === 'session') {
			this.memoryCleanupService.markAccessed(uri);
		}

		// The model may send `new_str` instead of `insert_text`
		const insertText = params.insert_text ?? params.new_str;
		if (!insertText) {
			this.logService.debug(`[MemoryTool] insert failed - missing insert_text for ${params.path}`);
			return 'Error: Missing required insert_text parameter for insert.';
		}

		let content: string;
		try {
			const buffer = await this.fileSystemService.readFile(uri);
			content = new TextDecoder().decode(buffer);
		} catch {
			this.logService.debug(`[MemoryTool] insert failed - file not found: ${params.path}`);
			return `Error: The path ${params.path} does not exist`;
		}

		const lines = content.split('\n');
		const nLines = lines.length;

		if (params.insert_line < 0 || params.insert_line > nLines) {
			this.logService.debug(`[MemoryTool] insert failed - invalid line number ${params.insert_line} for file with ${nLines} lines`);
			return `Error: Invalid \`insert_line\` parameter: ${params.insert_line}. It should be within the range of lines of the file: [0, ${nLines}].`;
		}

		const newLines = insertText.split('\n');
		lines.splice(params.insert_line, 0, ...newLines);

		const newContent = lines.join('\n');
		await this.fileSystemService.writeFile(uri, new TextEncoder().encode(newContent));
		this.logService.debug(`[MemoryTool] Inserted into memory file: ${params.path}`);
		return makeSnippet(newContent, params.insert_line + 1, params.path);
	}

	private async _localDelete(path: string, scope: MemoryScope, sessionResource?: string): Promise<string> {
		const uri = this._resolveUri(path, scope, sessionResource);

		try {
			await this.fileSystemService.stat(uri);
		} catch {
			this.logService.debug(`[MemoryTool] delete failed - path not found: ${path}`);
			return `Error: The path ${path} does not exist`;
		}

		await this.fileSystemService.delete(uri, { recursive: true });
		this.logService.debug(`[MemoryTool] Deleted memory file: ${path}`);
		return `Successfully deleted ${path}`;
	}

	private async _localRename(params: IRenameParams, scope: MemoryScope, sessionResource?: string): Promise<string> {
		// The model may send `path` instead of `old_path`
		const oldPath = params.old_path ?? params.path;
		if (!oldPath) {
			this.logService.debug(`[MemoryTool] rename failed - missing old_path`);
			return 'Error: Missing required old_path parameter for rename.';
		}

		const newPathError = validatePath(params.new_path);
		if (newPathError) {
			return newPathError;
		}

		// Prevent renaming across different scopes
		const newScope: MemoryScope = isSessionPath(params.new_path) ? 'session' : 'user';
		if (scope !== newScope) {
			return 'Error: Cannot rename across different memory scopes (user vs session).';
		}

		const srcUri = this._resolveUri(oldPath, scope, sessionResource);
		const destUri = this._resolveUri(params.new_path, scope, sessionResource);

		try {
			await this.fileSystemService.stat(srcUri);
		} catch {
			this.logService.debug(`[MemoryTool] rename failed - source not found: ${oldPath}`);
			return `Error: The path ${oldPath} does not exist`;
		}

		try {
			await this.fileSystemService.stat(destUri);
			this.logService.debug(`[MemoryTool] rename failed - destination exists: ${params.new_path}`);
			return `Error: The destination ${params.new_path} already exists`;
		} catch {
			// Destination doesn't exist — good
		}

		// Ensure parent directory of destination exists
		const destParent = URI.joinPath(destUri, '..');
		await createDirectoryIfNotExists(this.fileSystemService, destParent);

		await this.fileSystemService.rename(srcUri, destUri);
		if (scope === 'session') {
			this.memoryCleanupService.markAccessed(destUri);
		}
		this.logService.debug(`[MemoryTool] Renamed memory file: ${oldPath} → ${params.new_path}`);
		return `Successfully renamed ${oldPath} to ${params.new_path}`;
	}
}

ToolRegistry.registerTool(MemoryTool);