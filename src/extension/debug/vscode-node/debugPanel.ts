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
import { ChatReplayExport } from '../../replay/common/chatReplayTypes';
import { IDebugContextService } from '../common/debugContextService';
import { DebugQueryType, DebugSession } from '../common/debugTypes';
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
	type: 'query' | 'load' | 'ready' | 'aiQuery';
	command?: string;
	query?: string;
}

/**
 * Messages sent from extension to webview
 */
interface ExtensionToWebviewMessage {
	type: 'result' | 'sessionInfo' | 'error';
	title?: string;
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

		// Handle panel disposal
		this._disposables.add(this._panel.onDidDispose(() => {
			this._panel = undefined;
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
			this._refreshLiveSession();
			this._sendToWebview({
				type: 'result',
				title: 'Refreshed',
				markdown: '*Session data refreshed from live session.*'
			});
			this._sendSessionInfo();
			return;
		}

		const result = executeQuery(query, this._session);

		this._sendToWebview({
			type: 'result',
			title: result.title,
			markdown: result.markdown,
			mermaid: result.mermaid,
			error: result.error
		});
	}

	/**
	 * Execute an AI-powered query directly without showing in chat UI
	 */
	private async _executeAiQuery(query: string): Promise<void> {
		// Notify webview that query is being processed
		this._sendToWebview({
			type: 'result',
			title: 'Processing',
			markdown: `**Query:** ${query}\n\n*Analyzing with AI... Please wait.*`
		});

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
	 * Load a session file
	 */
	private async _loadFile(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: {
				'Session Files': ['json', 'chatreplay.json', 'trajectory.json', 'jsonl'],
				'All Files': ['*']
			},
			title: 'Load Debug Session'
		});

		if (!uris || uris.length === 0) {
			return;
		}

		const uri = uris[0];
		const filename = uri.fsPath.split(/[/\\]/).pop() || 'unknown';

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
							this._sendSessionInfo();

							const session = this._session;
							if (session) {
								this._sendToWebview({
									type: 'result',
									title: 'Transcript Loaded',
									markdown: `Loaded **${filename}** (JSONL Transcript)\n\n- ${session.metrics.totalTurns} turns\n- ${session.metrics.totalToolCalls} tool calls\n- ${session.transcriptEvents?.length || 0} transcript events\n\n*Use \`/transcript\` to view raw events, \`/thinking\` for reasoning content.*`
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

			// Detect file type
			if ('prompts' in data && 'totalPrompts' in data) {
				// ChatReplayExport
				this._session = buildSessionFromChatReplay(data as ChatReplayExport, filename);
			} else if ('schema_version' in data && 'steps' in data) {
				// ATIF trajectory
				this._session = buildSessionFromTrajectory(data as IAgentTrajectory, filename);
			} else {
				throw new Error('Unknown file format. Expected .chatreplay.json, .trajectory.json, or .jsonl transcript');
			}

			this._loadedFromFile = true;
			this._sendSessionInfo();

			const session = this._session;
			if (session) {
				this._sendToWebview({
					type: 'result',
					title: 'Session Loaded',
					markdown: `Loaded **${filename}**\n\n- ${session.metrics.totalTurns} turns\n- ${session.metrics.totalToolCalls} tool calls\n- ${session.metrics.totalSubAgents} sub-agents`
				});
			}

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
}
