/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { FileType } from '../../../../platform/filesystem/common/fileTypes';
import { IAgentTrajectory } from '../../../../platform/trajectory/common/trajectoryTypes';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../../vscodeTypes';
import { ChatReplayExport, ExportedPrompt } from '../../../replay/common/chatReplayTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../../tools/common/toolsRegistry';
import { IDebugContextService } from '../../common/debugContextService';
import { DebugSession } from '../../common/debugTypes';
import { buildSessionFromChatReplay, buildSessionFromTrajectory, buildSessionFromTranscript } from '../../node/debugSessionService';

interface ILoadSessionFileParams {
	/** Path to a session file or folder containing debug files */
	filePath: string;
}

/**
 * Tool to load a debug session from a file or folder for offline analysis.
 * Supports:
 * - Single files: .chatreplay.json, .trajectory.json, or .jsonl
 * - Folders: Automatically loads all debug files found
 */
class LoadSessionFileTool implements ICopilotTool<ILoadSessionFileParams> {
	public static readonly toolName = ToolName.DebugLoadSessionFile;

	constructor(
		@IFileSystemService private readonly fileSystem: IFileSystemService,
		@IDebugContextService private readonly debugContext: IDebugContextService,
	) { }

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ILoadSessionFileParams>,
		_token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const { filePath } = options.input;

		try {
			const uri = URI.file(filePath);

			// Check if path exists and determine if it's a file or folder
			let stat;
			try {
				stat = await this.fileSystem.stat(uri);
			} catch {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Path not found: ${filePath}\n\nPlease provide a valid path to a session file or folder.`)
				]);
			}

			// Handle folder
			if (stat.type === FileType.Directory) {
				return this.loadFolder(uri, filePath);
			}

			// Handle single file
			return this.loadSingleFile(uri, filePath);

		} catch (error) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`Failed to load: ${error instanceof Error ? error.message : String(error)}`)
			]);
		}
	}

	/**
	 * Load all debug files from a folder
	 */
	private async loadFolder(folderUri: URI, folderPath: string): Promise<vscode.LanguageModelToolResult> {
		const folderName = folderPath.split(/[/\\]/).pop() || 'folder';

		// Read directory contents
		const entries = await this.fileSystem.readDirectory(folderUri);

		// Categorize files
		const chatReplayFiles: URI[] = [];
		const trajectoryFiles: URI[] = [];
		const transcriptFiles: URI[] = [];

		for (const [name, type] of entries) {
			if (type !== FileType.File) {
				continue;
			}

			const fileUri = URI.joinPath(folderUri, name);
			const lowerName = name.toLowerCase();

			if (lowerName.endsWith('.chatreplay.json')) {
				chatReplayFiles.push(fileUri);
			} else if (lowerName.endsWith('.trajectory.json') || (lowerName.endsWith('.json') && lowerName.includes('trajectory'))) {
				trajectoryFiles.push(fileUri);
			} else if (lowerName.endsWith('.jsonl')) {
				transcriptFiles.push(fileUri);
			} else if (lowerName.endsWith('.json')) {
				// Try to detect file type by peeking at content
				try {
					const content = await this.fileSystem.readFile(fileUri);
					const text = new TextDecoder().decode(content);
					const data = JSON.parse(text);
					if (this.isATIFTrajectory(data)) {
						trajectoryFiles.push(fileUri);
					} else if (this.isChatReplayExport(data) || this.isSinglePromptExport(data)) {
						chatReplayFiles.push(fileUri);
					}
				} catch {
					// Skip invalid files
				}
			}
		}

		if (chatReplayFiles.length === 0 && trajectoryFiles.length === 0 && transcriptFiles.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`No debug files found in ${folderName}.\n\nExpected .chatreplay.json, .trajectory.json, or .jsonl files.`)
			]);
		}

		// Clear existing data
		this.debugContext.clearTrajectories();
		this.debugContext.clearLoadedSession();

		// Load trajectories first (for hierarchy analysis)
		let trajectoriesLoaded = 0;
		for (const fileUri of trajectoryFiles) {
			try {
				const content = await this.fileSystem.readFile(fileUri);
				const text = new TextDecoder().decode(content);
				const data = JSON.parse(text) as IAgentTrajectory;
				this.debugContext.addTrajectory(data);
				trajectoriesLoaded++;
			} catch {
				// Skip invalid trajectory files
			}
		}

		// Load the main session (prefer chatreplay, then transcript, then trajectory)
		let session: DebugSession | undefined;
		let sessionSource = '';

		if (chatReplayFiles.length > 0) {
			try {
				const fileUri = chatReplayFiles[0];
				const filename = fileUri.path.split(/[/\\]/).pop() || 'chatreplay.json';
				const content = await this.fileSystem.readFile(fileUri);
				const text = new TextDecoder().decode(content);
				const data = JSON.parse(text);

				// Handle both full export and single prompt formats
				let exportData: ChatReplayExport;
				if (this.isChatReplayExport(data)) {
					exportData = data as ChatReplayExport;
				} else if (this.isSinglePromptExport(data)) {
					// Single ExportedPrompt - wrap it
					exportData = {
						exportedAt: new Date().toISOString(),
						totalPrompts: 1,
						totalLogEntries: (data as ExportedPrompt).logs.length,
						prompts: [data as ExportedPrompt]
					};
				} else {
					throw new Error('Invalid chatreplay format');
				}

				session = buildSessionFromChatReplay(exportData, filename);
				this.debugContext.loadSession(session, folderPath);
				sessionSource = 'chatreplay';
			} catch {
				// Fall through to try other sources
			}
		}

		if (!session && transcriptFiles.length > 0) {
			try {
				const fileUri = transcriptFiles[0];
				const filename = fileUri.path.split(/[/\\]/).pop() || 'transcript.jsonl';
				const content = await this.fileSystem.readFile(fileUri);
				const text = new TextDecoder().decode(content);
				session = buildSessionFromTranscript(text, filename);
				this.debugContext.loadSession(session, folderPath);
				sessionSource = 'transcript';
			} catch {
				// Fall through to try trajectory
			}
		}

		if (!session && trajectoryFiles.length > 0) {
			try {
				const fileUri = trajectoryFiles[0];
				const filename = fileUri.path.split(/[/\\]/).pop() || 'trajectory.json';
				const content = await this.fileSystem.readFile(fileUri);
				const text = new TextDecoder().decode(content);
				const data = JSON.parse(text) as IAgentTrajectory;
				session = buildSessionFromTrajectory(data, filename);
				this.debugContext.loadSession(session, folderPath);
				sessionSource = 'trajectory';
			} catch {
				// No session could be loaded
			}
		}

		// Build summary
		const lines: string[] = [];
		lines.push(`## Folder Loaded: ${folderName}\n`);

		lines.push('### Files Found');
		if (chatReplayFiles.length > 0) {
			lines.push(`- ${chatReplayFiles.length} chat replay file(s)`);
		}
		if (trajectoryFiles.length > 0) {
			lines.push(`- ${trajectoryFiles.length} trajectory file(s)`);
		}
		if (transcriptFiles.length > 0) {
			lines.push(`- ${transcriptFiles.length} transcript file(s)`);
		}

		lines.push('');
		lines.push('### Loaded Data');
		if (session) {
			lines.push(`- **Session:** ${sessionSource} (${session.metrics.totalTurns} turns, ${session.metrics.totalToolCalls} tool calls)`);
			if (session.metrics.failedToolCalls && session.metrics.failedToolCalls > 0) {
				lines.push(`- **Failed Tool Calls:** ${session.metrics.failedToolCalls} ⚠️`);
			}
		}
		if (trajectoriesLoaded > 0) {
			lines.push(`- **Trajectories:** ${trajectoriesLoaded} loaded`);
			const hierarchy = this.debugContext.buildHierarchy();
			if (hierarchy.length > 0) {
				lines.push(`- **Hierarchy roots:** ${hierarchy.length}`);
			}
			const failures = this.debugContext.findFailures();
			if (failures.length > 0) {
				lines.push(`- **Failures detected:** ${failures.length} ⚠️`);
			}
		}

		lines.push('');
		lines.push('### Available Tools');
		lines.push('- `debug_getCurrentSession` - Session overview and metrics');
		lines.push('- `debug_getSessionHistory` - Conversation timeline');
		lines.push('- `debug_analyzeLatestRequest` - Deep dive on specific turn');
		if (trajectoriesLoaded > 0) {
			lines.push('- `debug_getHierarchy` - Sub-agent hierarchy');
			lines.push('- `debug_getFailures` - Failure analysis');
			lines.push('- `debug_getToolCalls` - Tool call analysis');
		}

		return new LanguageModelToolResult([new LanguageModelTextPart(lines.join('\n'))]);
	}

	/**
	 * Load a single session file
	 */
	private async loadSingleFile(uri: URI, filePath: string): Promise<vscode.LanguageModelToolResult> {
		const fileName = filePath.split(/[/\\]/).pop() || 'file';

		// Read file content
		const content = await this.fileSystem.readFile(uri);
		const textContent = new TextDecoder().decode(content);

		// Detect file format and parse
		const lowerFileName = fileName.toLowerCase();

		// Try JSONL transcript first (line-delimited JSON)
		if (lowerFileName.endsWith('.jsonl')) {
			try {
				const session = buildSessionFromTranscript(textContent, fileName);
				this.debugContext.loadSession(session, filePath);
				return this.buildSuccessResponse(session, 'transcript', fileName);
			} catch (error) {
				return new LanguageModelToolResult([
					new LanguageModelTextPart(`Failed to parse JSONL transcript: ${error instanceof Error ? error.message : String(error)}`)
				]);
			}
		}

		// Parse as JSON
		let data: unknown;
		try {
			data = JSON.parse(textContent);
		} catch (parseError) {
			// Could be malformed JSONL
			if (textContent.includes('\n')) {
				try {
					const session = buildSessionFromTranscript(textContent, fileName);
					this.debugContext.loadSession(session, filePath);
					return this.buildSuccessResponse(session, 'transcript', fileName);
				} catch {
					// Fall through to show parse error
				}
			}
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`Failed to parse file as JSON: ${parseError}\n\nMake sure the file is a valid JSON or JSONL file.`)
			]);
		}

		// Detect format based on structure
		if (this.isChatReplayExport(data)) {
			// Chat replay format (full export)
			const session = buildSessionFromChatReplay(data as ChatReplayExport, fileName);
			this.debugContext.loadSession(session, filePath);
			return this.buildSuccessResponse(session, 'chatreplay', fileName);
		} else if (this.isSinglePromptExport(data)) {
			// Single prompt format - wrap it in a ChatReplayExport
			const wrappedExport: ChatReplayExport = {
				exportedAt: new Date().toISOString(),
				totalPrompts: 1,
				totalLogEntries: (data as ExportedPrompt).logs.length,
				prompts: [data as ExportedPrompt]
			};
			const session = buildSessionFromChatReplay(wrappedExport, fileName);
			this.debugContext.loadSession(session, filePath);
			return this.buildSuccessResponse(session, 'chatreplay', fileName);
		} else if (this.isATIFTrajectory(data)) {
			// ATIF trajectory format
			const session = buildSessionFromTrajectory(data as IAgentTrajectory, fileName);
			this.debugContext.loadSession(session, filePath);
			// Also add to trajectory store for hierarchy analysis
			this.debugContext.addTrajectory(data as IAgentTrajectory);
			return this.buildSuccessResponse(session, 'trajectory', fileName);
		} else {
			// Unknown format
			const preview = textContent.substring(0, 300);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`Unknown file format. Expected one of:\n` +
					`- **Chat replay** (.chatreplay.json): with 'prompts' and 'totalPrompts' fields\n` +
					`- **ATIF trajectory** (.trajectory.json): with 'session_id', 'agent', and 'steps' fields\n` +
					`- **JSONL transcript** (.jsonl): line-delimited JSON entries\n\n` +
					`File preview:\n\`\`\`\n${preview}...\n\`\`\``)
			]);
		}
	}

	private isChatReplayExport(data: unknown): boolean {
		return (
			data !== null &&
			typeof data === 'object' &&
			'prompts' in data &&
			'totalPrompts' in data &&
			Array.isArray((data as ChatReplayExport).prompts)
		);
	}

	private isSinglePromptExport(data: unknown): boolean {
		return (
			data !== null &&
			typeof data === 'object' &&
			'prompt' in data &&
			'logs' in data &&
			Array.isArray((data as ExportedPrompt).logs)
		);
	}

	private isATIFTrajectory(data: unknown): boolean {
		return (
			data !== null &&
			typeof data === 'object' &&
			'session_id' in data &&
			'steps' in data &&
			Array.isArray((data as IAgentTrajectory).steps)
		);
	}

	private buildSuccessResponse(
		session: { sessionId: string; turns: unknown[]; toolCalls: unknown[]; metrics: { totalTurns: number; totalToolCalls: number; totalSubAgents: number; failedToolCalls?: number } },
		format: string,
		fileName: string
	): vscode.LanguageModelToolResult {
		const lines: string[] = [];
		lines.push(`## Session Loaded: ${fileName}\n`);
		lines.push(`**Format:** ${format}`);
		lines.push(`**Session ID:** \`${session.sessionId}\``);
		lines.push('');
		lines.push('### Summary');
		lines.push(`- **Turns:** ${session.metrics.totalTurns}`);
		lines.push(`- **Tool Calls:** ${session.metrics.totalToolCalls}`);
		if (session.metrics.failedToolCalls && session.metrics.failedToolCalls > 0) {
			lines.push(`- **Failed Tool Calls:** ${session.metrics.failedToolCalls} ⚠️`);
		}
		lines.push(`- **Sub-agents:** ${session.metrics.totalSubAgents}`);
		lines.push('');
		lines.push('### Available Commands');
		lines.push('Now that the session is loaded, you can use these tools:');
		lines.push('- `debug_getCurrentSession` - Get session overview and metrics');
		lines.push('- `debug_getSessionHistory` - View conversation timeline');
		lines.push('- `debug_analyzeLatestRequest` - Deep dive on specific turn');
		lines.push('');
		lines.push('*Note: The loaded session replaces live session data until cleared.*');

		return new LanguageModelToolResult([new LanguageModelTextPart(lines.join('\n'))]);
	}

	prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ILoadSessionFileParams>,
		_token: CancellationToken
	): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const pathName = options.input.filePath.split(/[/\\]/).pop() || 'path';
		return {
			invocationMessage: new MarkdownString(l10n.t`Loading debug data from ${pathName}...`),
			pastTenseMessage: new MarkdownString(l10n.t`Loaded debug data from ${pathName}`),
		};
	}
}

ToolRegistry.registerTool(LoadSessionFileTool);
