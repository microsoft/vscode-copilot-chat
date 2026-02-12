/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IAgentTrajectory } from '../../../platform/trajectory/common/trajectoryTypes';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatReplayExport, ExportedPrompt } from '../../replay/common/chatReplayTypes';
import { IDebugContextService } from '../common/debugContextService';
import { DebugItemStatus, DebugQueryType, DebugSession, DebugSubAgent, DebugToolCall } from '../common/debugTypes';
import { executeQuery, parseQuery } from '../node/debugQueryHandler';
import {
	buildSessionFromChatReplay,
	buildSessionFromRequestLogger,
	buildSessionFromTrajectory,
	buildSessionFromTranscript
} from '../node/debugSessionService';
import { DebugSubagentInvoker } from './debugSubagentInvoker';
import { getDebugPanelHtml } from './panelHtml';

/**
 * Messages sent from webview to extension
 */
interface WebviewToExtensionMessage {
	type: 'query' | 'load' | 'ready' | 'aiQuery' | 'export';
	command?: string;
	query?: string;
}

/**
 * Messages sent from extension to webview
 */
interface ExtensionToWebviewMessage {
	type: 'result' | 'sessionInfo' | 'error' | 'separator';
	title?: string;
	subtitle?: string;
	markdown?: string;
	mermaid?: string;
	error?: string;
	sessionSource?: string;
	sessionFile?: string;
	/** True if this is an AI-generated response */
	isAiResponse?: boolean;
}

/**
 * Manager for the debug panel webview
 */
export class DebugPanelManager extends Disposable {
	private _panel: vscode.WebviewPanel | undefined;
	private _session: DebugSession | undefined;
	private _loadedFromFile = false;
	private readonly _disposables = this._register(new DisposableStore());
	private readonly _subagentInvoker: DebugSubagentInvoker;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
		@IDebugContextService private readonly _debugContextService: IDebugContextService
	) {
		super();

		this._subagentInvoker = new DebugSubagentInvoker(instantiationService, this._debugContextService, this._requestLogger);

		// Subscribe to request logger changes for live updates
		this._disposables.add(this._requestLogger.onDidChangeRequests(() => {
			if (!this._loadedFromFile && this._panel?.visible) {
				this._refreshLiveSession();
			}
		}));

		// Subscribe to debug subagent responses to show in panel
		this._disposables.add(this._debugContextService.onDebugSubagentResponse((response) => {
			if (this._panel?.visible) {
				this._sendToWebview({
					type: 'result',
					title: response.success ? 'AI Analysis' : 'AI Analysis (Failed)',
					markdown: response.response,
					isAiResponse: true
				});
			}
		}));
	}

	/**
	 * Show the debug panel (creates it if needed)
	 */
	public show(): void {
		if (this._panel) {
			this._panel.reveal(vscode.ViewColumn.One);
			return;
		}

		this._panel = vscode.window.createWebviewPanel(
			'copilot.debugPanel',
			'Debug Panel',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(this._extensionContext.extensionUri, 'dist')
				]
			}
		);

		// Set initial HTML
		this._panel.webview.html = getDebugPanelHtml(this._panel.webview, this._extensionContext.extensionUri);

		// Handle messages from webview
		this._disposables.add(this._panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
			this._handleWebviewMessage(message);
		}));

		// Handle panel disposal - reset to live mode
		this._disposables.add(this._panel.onDidDispose(() => {
			this._panel = undefined;
			this._loadedFromFile = false;
			this._session = undefined;
			this._debugContextService.clearLoadedSession();
		}));

		// Load initial live session
		this._refreshLiveSession();
	}

	/**
	 * Handle messages from the webview
	 */
	private async _handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				// Webview is ready, send initial data
				this._sendSessionInfo();
				break;

			case 'query':
				if (message.command) {
					this._executeQuery(message.command);
				}
				break;

			case 'aiQuery':
				if (message.query) {
					await this._executeAiQuery(message.query);
				}
				break;

			case 'export':
				await this._exportSession();
				break;

			case 'load':
				await this._loadFile();
				break;
		}
	}

	/**
	 * Execute a query and send results to webview
	 */
	private _executeQuery(command: string): void {
		const query = parseQuery(command);

		// Handle special cases
		if (query.type === DebugQueryType.Load) {
			void this._loadFile();
			return;
		}

		if (query.type === DebugQueryType.Refresh) {
			this._loadedFromFile = false;
			// Clear loaded session from context service so tools use live data
			this._debugContextService.clearLoadedSession();
			this._refreshLiveSession();
			this._sendToWebview({
				type: 'result',
				title: 'Refreshed',
				markdown: '*Session data refreshed from live session.*'
			});
			this._sendSessionInfo();
			return;
		}

		if (query.type === DebugQueryType.Export) {
			void this._exportSession();
			return;
		}

		try {
			const result = executeQuery(query, this._session);

			this._sendToWebview({
				type: 'result',
				title: result.title,
				markdown: result.markdown,
				mermaid: result.mermaid,
				error: result.error
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this._sendToWebview({
				type: 'result',
				title: 'Error',
				markdown: `*Data not available or could not be processed.*\n\n**Details:** ${errorMsg}\n\nTry loading a different file or use \`/refresh\` to reload live session data.`
			});
		}
	}

	/**
	 * Execute an AI-powered query directly without showing in chat UI
	 */
	private async _executeAiQuery(query: string): Promise<void> {
		// Webview already shows loading indicator - no need for placeholder message
		try {
			// Execute directly without going through chat
			await this._subagentInvoker.executeQuery(query);
			// Response will arrive via the onDebugSubagentResponse event subscription
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this._sendToWebview({
				type: 'error',
				error: `Failed to execute AI query: ${errorMsg}`
			});
		}
	}

	/**
	 * Export the current session to a .debugsession.json file
	 */
	private async _exportSession(): Promise<void> {
		if (!this._session) {
			this._sendToWebview({
				type: 'error',
				error: 'No session data to export. Load or start a session first.'
			});
			return;
		}

		// Generate a default filename based on session info
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const defaultName = `debug-session-${timestamp}.debugsession.json`;

		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(defaultName),
			filters: {
				'Debug Session': ['debugsession.json', 'json'],
				'All Files': ['*']
			},
			title: 'Export Debug Session'
		});

		if (!uri) {
			return;
		}

		try {
			// Prepare session for export (convert Maps to objects for JSON serialization)
			const exportData = {
				exportedAt: new Date().toISOString(),
				version: 1,
				session: {
					...this._session,
					// Override source to 'archive' when re-imported
					source: 'archive',
					metrics: {
						...this._session.metrics,
						// Convert Maps to plain objects for JSON
						toolCallsByName: Object.fromEntries(this._session.metrics.toolCallsByName),
						errorTypes: Object.fromEntries(this._session.metrics.errorTypes)
					}
				}
			};

			const content = JSON.stringify(exportData, null, 2);
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));

			const filename = uri.fsPath.split(/[/\\]/).pop() || 'session';
			this._sendToWebview({
				type: 'result',
				title: 'Session Exported',
				markdown: `Session exported to **${filename}**\n\n- ${this._session.metrics.totalTurns} turns\n- ${this._session.metrics.totalToolCalls} tool calls\n\n*You can reload this session later using \`/load\` command.*`
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this._sendToWebview({
				type: 'error',
				error: `Failed to export session: ${errorMsg}`
			});
		}
	}

	/**
	 * Load a session file or folder
	 */
	private async _loadFile(): Promise<void> {
		// Show quick pick to choose between file or folder
		const choice = await vscode.window.showQuickPick([
			{ label: '$(file) Load File', description: 'Load a single .chatreplay.json, .trajectory.json, or .jsonl file', value: 'file' },
			{ label: '$(folder) Load Folder', description: 'Load all debug files from a folder', value: 'folder' }
		], {
			title: 'Load Debug Session',
			placeHolder: 'Choose how to load debug data'
		});

		if (!choice) {
			return;
		}

		if (choice.value === 'folder') {
			await this._loadFolder();
		} else {
			await this._loadSingleFile();
		}
	}

	/**
	 * Load all debug files from a folder
	 */
	private async _loadFolder(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: 'Select Debug Logs Folder'
		});

		if (!uris || uris.length === 0) {
			return;
		}

		const folderUri = uris[0];
		const folderPath = folderUri.fsPath;
		const folderName = folderPath.split(/[/\\]/).pop() || 'folder';

		try {
			// Read directory contents
			const entries = await vscode.workspace.fs.readDirectory(folderUri);

			// Categorize files
			const chatReplayFiles: vscode.Uri[] = [];
			const trajectoryFiles: vscode.Uri[] = [];
			const transcriptFiles: vscode.Uri[] = [];

			for (const [name, type] of entries) {
				if (type !== vscode.FileType.File) {
					continue;
				}

				const fileUri = vscode.Uri.joinPath(folderUri, name);
				const lowerName = name.toLowerCase();

				if (lowerName.endsWith('.chatreplay.json')) {
					chatReplayFiles.push(fileUri);
				} else if (lowerName.endsWith('.trajectory.json') || (lowerName.endsWith('.json') && lowerName.includes('trajectory'))) {
					trajectoryFiles.push(fileUri);
				} else if (lowerName.endsWith('.jsonl')) {
					transcriptFiles.push(fileUri);
				} else if (lowerName.endsWith('.json')) {
					// Try to detect ATIF trajectory by peeking at content
					try {
						const content = await vscode.workspace.fs.readFile(fileUri);
						const text = new TextDecoder().decode(content);
						const data = JSON.parse(text);
						if (data && typeof data === 'object' && 'session_id' in data && 'steps' in data) {
							trajectoryFiles.push(fileUri);
						} else if (data && typeof data === 'object' && (('prompts' in data && 'totalPrompts' in data) || ('prompt' in data && 'logs' in data))) {
							// Both full ChatReplayExport and single ExportedPrompt formats
							chatReplayFiles.push(fileUri);
						}
					} catch {
						// Skip invalid files
					}
				}
			}

			if (chatReplayFiles.length === 0 && trajectoryFiles.length === 0 && transcriptFiles.length === 0) {
				this._sendToWebview({
					type: 'error',
					error: `No debug files found in ${folderName}. Expected .chatreplay.json, .trajectory.json, or .jsonl files.`
				});
				return;
			}

			// Add visual separator before loading new session
			this._sendToWebview({
				type: 'separator',
				title: 'Loading New Session',
				subtitle: folderName
			});

			// Clear existing data and session
			this._session = undefined;
			this._loadedFromFile = false;
			this._debugContextService.clearTrajectories();
			this._debugContextService.clearLoadedSession();
			this._sendSessionInfo(); // Update badge to show "No Session" while loading

			// Load trajectories first (for hierarchy analysis)
			let trajectoriesLoaded = 0;
			const loadedTrajectories: IAgentTrajectory[] = [];
			for (const fileUri of trajectoryFiles) {
				try {
					const content = await vscode.workspace.fs.readFile(fileUri);
					const text = new TextDecoder().decode(content);
					const data = JSON.parse(text) as IAgentTrajectory;
					this._debugContextService.addTrajectory(data);
					loadedTrajectories.push(data);
					trajectoriesLoaded++;
				} catch {
					// Skip invalid trajectory files
				}
			}

			// Load the main session (prefer chatreplay, then transcript, then trajectory)
			let sessionLoaded = false;
			let sessionSource = '';

			if (chatReplayFiles.length > 0) {
				try {
					const fileUri = chatReplayFiles[0];
					const filename = fileUri.fsPath.split(/[/\\]/).pop() || 'chatreplay.json';
					const content = await vscode.workspace.fs.readFile(fileUri);
					const text = new TextDecoder().decode(content);
					const data = JSON.parse(text);

					// Handle both full export and single prompt formats
					let exportData: ChatReplayExport;
					if ('prompts' in data && 'totalPrompts' in data) {
						exportData = data as ChatReplayExport;
					} else if ('prompt' in data && 'logs' in data) {
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

					this._session = buildSessionFromChatReplay(exportData, filename);
					this._debugContextService.loadSession(this._session, folderPath);
					sessionLoaded = true;
					sessionSource = 'chatreplay';
				} catch {
					// Fall through to try other sources
				}
			}

			if (!sessionLoaded && transcriptFiles.length > 0) {
				try {
					const fileUri = transcriptFiles[0];
					const filename = fileUri.fsPath.split(/[/\\]/).pop() || 'transcript.jsonl';
					const content = await vscode.workspace.fs.readFile(fileUri);
					const text = new TextDecoder().decode(content);
					this._session = buildSessionFromTranscript(text, filename);
					this._debugContextService.loadSession(this._session, folderPath);
					sessionLoaded = true;
					sessionSource = 'transcript';
				} catch {
					// Fall through to try trajectory
				}
			}

			if (!sessionLoaded && trajectoryFiles.length > 0) {
				// Use first trajectory as session source
				try {
					const fileUri = trajectoryFiles[0];
					const filename = fileUri.fsPath.split(/[/\\]/).pop() || 'trajectory.json';
					const content = await vscode.workspace.fs.readFile(fileUri);
					const text = new TextDecoder().decode(content);
					const data = JSON.parse(text) as IAgentTrajectory;
					this._session = buildSessionFromTrajectory(data, filename);
					this._debugContextService.loadSession(this._session, folderPath);
					sessionLoaded = true;
					sessionSource = 'trajectory';
				} catch {
					// No session could be loaded
				}
			}

			// Merge subagent tool data from linked trajectory files
			if (sessionLoaded && loadedTrajectories.length > 0) {
				this._mergeSubagentTrajectoryData(loadedTrajectories);
			}

			this._loadedFromFile = sessionLoaded;
			this._sendSessionInfo();

			// Build summary
			const lines: string[] = [];
			lines.push(`Loaded folder **${folderName}**\n`);
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
			if (sessionLoaded && this._session) {
				lines.push(`- **Session:** ${sessionSource} (${this._session.metrics.totalTurns} turns, ${this._session.metrics.totalToolCalls} tool calls)`);
			}
			if (trajectoriesLoaded > 0) {
				lines.push(`- **Trajectories:** ${trajectoriesLoaded} loaded (for hierarchy/failure analysis)`);
				const hierarchy = this._debugContextService.buildHierarchy();
				if (hierarchy.length > 0) {
					lines.push(`- **Hierarchy roots:** ${hierarchy.length}`);
				}
				const failures = this._debugContextService.findFailures();
				if (failures.length > 0) {
					lines.push(`- **Failures detected:** ${failures.length} ⚠️`);
				}
			}

			lines.push('');
			lines.push('*All data is now available for AI analysis. Use "Ask AI" or type a question.*');

			this._sendToWebview({
				type: 'result',
				title: 'Folder Loaded',
				markdown: lines.join('\n')
			});

		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this._sendToWebview({
				type: 'error',
				error: `Failed to load folder: ${errorMsg}`
			});
		}
	}

	/**
	 * Load a single session file
	 */
	private async _loadSingleFile(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: {
				'Session Files': ['json', 'chatreplay.json', 'trajectory.json', 'debugsession.json', 'jsonl'],
				'All Files': ['*']
			},
			title: 'Load Debug Session'
		});

		if (!uris || uris.length === 0) {
			return;
		}

		const uri = uris[0];
		const filename = uri.fsPath.split(/[/\\]/).pop() || 'unknown';

		// Add visual separator before loading new session
		this._sendToWebview({
			type: 'separator',
			title: 'Loading New Session',
			subtitle: filename
		});

		// Clear existing data and session
		this._session = undefined;
		this._loadedFromFile = false;
		this._debugContextService.clearTrajectories();
		this._debugContextService.clearLoadedSession();
		this._sendSessionInfo(); // Update badge to show "No Session" while loading

		try {
			const content = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder().decode(content);

			// Check if it's a JSONL file (transcript format)
			if (filename.endsWith('.jsonl') || text.trim().startsWith('{') && text.includes('\n{')) {
				// Try to parse as JSONL transcript
				const firstLine = text.split('\n')[0].trim();
				if (firstLine) {
					try {
						const firstEntry = JSON.parse(firstLine);
						if (firstEntry.type && firstEntry.id && firstEntry.timestamp) {
							// It's a transcript JSONL
							this._session = buildSessionFromTranscript(text, filename);
							this._loadedFromFile = true;
							// Also store in context service so tools can access it
							this._debugContextService.loadSession(this._session, uri.fsPath);
							this._sendSessionInfo();

							const session = this._session;
							if (session) {
								this._sendToWebview({
									type: 'result',
									title: 'Transcript Loaded',
									markdown: `Loaded **${filename}** (JSONL Transcript)\n\n- ${session.metrics.totalTurns} turns\n- ${session.metrics.totalToolCalls} tool calls\n- ${session.transcriptEvents?.length || 0} transcript events\n\n*Session data is now available for AI analysis. Use "Ask AI" or type a question.*`
								});
							}
							return;
						}
					} catch {
						// Not valid JSONL, fall through to JSON parsing
					}
				}
			}

			// Parse as JSON
			const data = JSON.parse(text);

			// Detect file type and build session
			let session: DebugSession;
			if ('version' in data && 'session' in data && data.session) {
				// Exported debug session archive
				const sessionData = data.session;
				// Reconstruct Maps from plain objects
				const metrics = {
					...sessionData.metrics,
					toolCallsByName: new Map(Object.entries(sessionData.metrics.toolCallsByName || {})),
					errorTypes: new Map(Object.entries(sessionData.metrics.errorTypes || {}))
				};
				session = {
					...sessionData,
					source: 'archive' as const,
					metrics
				};
			} else if ('prompts' in data && 'totalPrompts' in data) {
				// ChatReplayExport (full export with multiple prompts)
				session = buildSessionFromChatReplay(data as ChatReplayExport, filename);
			} else if ('prompt' in data && 'logs' in data) {
				// Single ExportedPrompt - wrap it in a ChatReplayExport structure
				const wrappedExport: ChatReplayExport = {
					exportedAt: new Date().toISOString(),
					totalPrompts: 1,
					totalLogEntries: (data as ExportedPrompt).logs.length,
					prompts: [data as ExportedPrompt]
				};
				session = buildSessionFromChatReplay(wrappedExport, filename);
			} else if ('schema_version' in data && 'steps' in data) {
				// ATIF trajectory
				session = buildSessionFromTrajectory(data as IAgentTrajectory, filename);
			} else {
				throw new Error('Unknown file format. Expected .debugsession.json, .chatreplay.json, .trajectory.json, or .jsonl transcript');
			}

			this._session = session;
			this._loadedFromFile = true;
			// Also store in context service so tools can access it
			this._debugContextService.loadSession(session, uri.fsPath);
			this._sendSessionInfo();

			this._sendToWebview({
				type: 'result',
				title: session.source === 'archive' ? 'Archived Session Loaded' : 'Session Loaded',
				markdown: `Loaded **${filename}**${session.source === 'archive' ? ' (📦 Archive)' : ''}\n\n- ${session.metrics.totalTurns} turns\n- ${session.metrics.totalToolCalls} tool calls\n- ${session.metrics.totalSubAgents} sub-agents\n\n*Session data is now available for AI analysis. Use "Ask AI" or type a question.*`
			});

		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			this._sendToWebview({
				type: 'error',
				error: `Failed to load file: ${errorMsg}`
			});
		}
	}

	/**
	 * Refresh session data from live IRequestLogger
	 */
	private _refreshLiveSession(): void {
		if (this._loadedFromFile) {
			return;
		}

		// Exclude debug subagent's own calls from the session data
		this._session = buildSessionFromRequestLogger(this._requestLogger, 'live', {
			excludeDebugSubagent: true
		});
	}

	/**
	 * Send session info to webview
	 */
	private _sendSessionInfo(): void {
		this._sendToWebview({
			type: 'sessionInfo',
			sessionSource: this._session?.source || 'none',
			sessionFile: this._session?.sourceFile
		});
	}

	/**
	 * Send a message to the webview
	 */
	private _sendToWebview(message: ExtensionToWebviewMessage): void {
		if (this._panel) {
			void this._panel.webview.postMessage(message);
		}
	}

	/**
	 * Dispose the panel
	 */
	public override dispose(): void {
		this._panel?.dispose();
		super.dispose();
	}

	/**
	 * Merge subagent tool data from linked trajectory files into the session
	 * This links subagent trajectories to DebugSubAgent entries based on session_id matching
	 */
	private _mergeSubagentTrajectoryData(trajectories: IAgentTrajectory[]): void {
		if (!this._session || this._session.subAgents.length === 0) {
			return;
		}

		// Build a map of session_id -> trajectory
		const trajectoryMap = new Map<string, IAgentTrajectory>();
		for (const traj of trajectories) {
			trajectoryMap.set(traj.session_id, traj);
		}

		// Update each subagent with data from its trajectory
		const updatedSubAgents: DebugSubAgent[] = [];
		for (const subAgent of this._session.subAgents) {
			const trajectory = trajectoryMap.get(subAgent.sessionId);
			if (trajectory) {
				// Extract tool calls from trajectory steps
				const toolCalls: DebugToolCall[] = [];
				let promptTokens = 0;
				let completionTokens = 0;
				let internalTurns = 0;

				for (const step of trajectory.steps) {
					if (step.source === 'agent') {
						internalTurns++;

						// Extract tool calls
						if (step.tool_calls) {
							for (const tc of step.tool_calls) {
								toolCalls.push({
									id: tc.tool_call_id,
									name: tc.function_name,
									args: tc.arguments,
									status: DebugItemStatus.Success, // Trajectory doesn't track individual tool status
									turnId: `subagent-${subAgent.sessionId}`,
									durationMs: step.metrics?.duration_ms
								});
							}
						}

						// Extract metrics
						if (step.metrics) {
							promptTokens += step.metrics.prompt_tokens || 0;
							completionTokens += step.metrics.completion_tokens || 0;
						}
					}
				}

				// Calculate duration from final metrics or sum of steps
				let durationMs: number | undefined;
				if (trajectory.steps.length > 0) {
					const durations = trajectory.steps
						.filter(s => s.metrics?.duration_ms)
						.map(s => s.metrics!.duration_ms!);
					if (durations.length > 0) {
						durationMs = durations.reduce((a, b) => a + b, 0);
					}
				}

				// Create updated subagent with merged data
				updatedSubAgents.push({
					...subAgent,
					toolCalls,
					internalTurns: internalTurns || undefined,
					promptTokens: promptTokens || undefined,
					completionTokens: completionTokens || undefined,
					durationMs
				});
			} else {
				// Keep original if no matching trajectory
				updatedSubAgents.push(subAgent);
			}
		}

		// Replace session with updated subagents
		// Since DebugSession is readonly, we need to recreate it
		this._session = {
			...this._session,
			subAgents: updatedSubAgents
		};
	}
}
