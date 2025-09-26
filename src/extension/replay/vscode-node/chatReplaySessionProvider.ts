/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import { CancellationToken, ChatRequestTurn, ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponseStream, ChatResponseTurn2, ChatSession, ChatSessionContentProvider, ChatSessionItem, ChatSessionItemProvider, ChatToolInvocationPart, Event, EventEmitter, MarkdownString, ProviderResult } from 'vscode';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ChatStep } from '../common/chatReplayResponses';
import { EditHelper } from './editHelper';

export class ChatReplaySessionProvider extends Disposable implements ChatSessionItemProvider, ChatSessionContentProvider {
	private _onDidChangeChatSessionItems = this._register(new EventEmitter<void>());
	readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly editHelper: EditHelper;

	private _sessions = new Map<string, ChatReplaySessionData>();
	private _activeReplays = new Map<string, ChatReplayState>();
	private _activeStreams = new Map<string, ChatResponseStream>();

	constructor(IWorkspaceService: IWorkspaceService) {
		super();
		this.editHelper = new EditHelper(IWorkspaceService);
	}

	provideChatSessionItems(token: CancellationToken): ProviderResult<ChatSessionItem[]> {
		return [];
	}

	// ChatSessionContentProvider implementation
	provideChatSessionContent(sessionId: string, token: CancellationToken): ChatSession {
		// Check if this is a debug session based on session ID prefix
		const isDebugSession = sessionId.startsWith('debug:');
		const actualSessionId = isDebugSession ? sessionId.substring(6) : sessionId; // Remove 'debug:' prefix

		if (isDebugSession) {
			// For debug sessions, initialize debugging and return debug-mode session
			// Pass the ORIGINAL sessionId (with debug: prefix) to maintain consistency
			return this.startReplayDebugging(sessionId);
		} else {
			// For normal sessions, return regular content
			return this.provideChatSessionContentInternal(actualSessionId, token, false);
		}
	}

	// Method to provide chat session content in debug mode
	provideChatSessionContentForDebug(sessionId: string, token: CancellationToken): ChatSession {
		// Handle debug session ID prefix - use actual session ID for data, debug ID for replay state
		const actualSessionId = sessionId.startsWith('debug:') ? sessionId.substring(6) : sessionId;
		const debugSessionId = sessionId.startsWith('debug:') ? sessionId : `debug:${sessionId}`;

		return this.provideChatSessionContentInternal(actualSessionId, token, true, debugSessionId);
	}

	private provideChatSessionContentInternal(sessionId: string, token: CancellationToken, isDebugMode: boolean, debugSessionId?: string): ChatSession {
		let sessionData = this._sessions.get(sessionId);

		if (!sessionData) {
			// Parse the replay file
			const filePath = this.getFilePathFromSessionId(sessionId);
			if (!filePath || !fs.existsSync(filePath)) {
				throw new Error(`Replay file not found for session ${sessionId}`);
			}

			try {
				const content = fs.readFileSync(filePath, 'utf8');
				const chatSteps = this.parseReplay(content);

				sessionData = {
					filePath,
					chatSteps,
					history: [] // Will be populated based on debug mode
				};
				this._sessions.set(sessionId, sessionData);
			} catch (error) {
				throw new Error(`Failed to parse replay file ${filePath}: ${error}`);
			}
		}

		// Generate history based on debug mode
		const history = this.convertStepsToHistory(sessionData.chatSteps, isDebugMode);
		sessionData.history = history;

		// In debug mode, check if we have response steps to stream
		let hasActiveResponse = false;
		if (isDebugMode) {
			// Use debugSessionId for replay state lookup, fallback to sessionId
			const replayStateId = debugSessionId || sessionId;
			const replayState = this._activeReplays.get(replayStateId);
			hasActiveResponse = replayState !== undefined && replayState.currentStepIndex < replayState.responseSteps.length;
		}

		return {
			history: history,
			// Provide active response callback when debugging
			activeResponseCallback: hasActiveResponse
				? (stream, token) => this.handleActiveResponse(debugSessionId || sessionId, stream, token)
				: undefined,
			requestHandler: undefined // This will be read-only for replay
		};
	}

	private getFilePathFromSessionId(sessionId: string): string | undefined {
		try {
			// Handle debug session IDs by removing the debug prefix
			const actualSessionId = sessionId.startsWith('debug:') ? sessionId.substring(6) : sessionId;
			return Buffer.from(actualSessionId, 'base64').toString('utf8');
		} catch {
			return undefined;
		}
	}

	private convertStepsToHistory(chatSteps: ChatStep[], debugMode: boolean = false): ReadonlyArray<ChatRequestTurn | ChatResponseTurn2> {
		const history: (ChatRequestTurn | ChatResponseTurn2)[] = [];
		let currentResponseSteps: ChatStep[] = [];

		for (const step of chatSteps) {
			if (step.kind === 'userQuery') {
				// In debug mode, only include completed response turns
				if (!debugMode && currentResponseSteps.length > 0) {
					history.push(this.createResponseTurn(currentResponseSteps));
					currentResponseSteps = [];
				}

				// Always create request turn for user query
				history.push(this.createRequestTurn(step));
			} else if (step.kind === 'request' || step.kind === 'toolCall') {
				// In debug mode, don't add response steps to history - they'll be streamed
				if (!debugMode) {
					currentResponseSteps.push(step);
				}
			}
		}

		// Complete any remaining response turn (only in non-debug mode)
		if (!debugMode && currentResponseSteps.length > 0) {
			history.push(this.createResponseTurn(currentResponseSteps));
		}

		return history;
	}

	private createRequestTurn(step: ChatStep & { kind: 'userQuery' }): ChatRequestTurn2 {
		return new ChatRequestTurn2(step.query, undefined, [], 'copilot', [], undefined);
	}

	private createResponseTurn(responseSteps: ChatStep[]): ChatResponseTurn2 {
		const parts: ChatResponseMarkdownPart[] = responseSteps.map(step => {
			let content = '';
			if (step.kind === 'request') {
				content = Array.isArray(step.result) ? step.result.join('') : (step.result || '');
			} else if (step.kind === 'toolCall') {
				content = `**Tool Call: ${step.toolName}**\n\nArguments:\n\`\`\`json\n${JSON.stringify(step.args, null, 2)}\n\`\`\`\n\nResults:\n${step.results.join('\n')}`;
			}
			return {
				value: new MarkdownString(content),
				vulnerabilities: []
			};
		});

		return new ChatResponseTurn2(
			parts,
			{}, // result
			'copilot' // participant
		);
	}

	private async handleActiveResponse(sessionId: string, stream: ChatResponseStream, token: CancellationToken): Promise<void> {
		const replayState = this._activeReplays.get(sessionId);
		if (!replayState) {
			return;
		}

		// Check if this is a debug session that should wait for stepping
		const isDebugSession = sessionId.startsWith('debug:');

		if (isDebugSession) {
			// Store stream reference for debug stepping
			this._activeStreams.set(sessionId, stream);

			// In debug mode, only stream the current step if we're at the beginning
			// Further steps will be streamed via stepNext() calls
			if (replayState.currentStepIndex === 0 && replayState.responseSteps.length > 0) {
				await this.streamCurrentStep(sessionId, stream);
				replayState.currentStepIndex++;
			}
		} else {
			// In normal mode, stream all steps automatically
			while (replayState.currentStepIndex < replayState.responseSteps.length && !token.isCancellationRequested) {
				const step = replayState.responseSteps[replayState.currentStepIndex];

				if (step.kind === 'request') {
					const result = Array.isArray(step.result) ? step.result.join('') : (step.result || '');
					stream.markdown(result);
				} else if (step.kind === 'toolCall') {
					const toolPart = new ChatToolInvocationPart(step.toolName, step.id);
					toolPart.isComplete = true;
					toolPart.isError = false;
					toolPart.isConfirmed = true;

					stream.push(toolPart);
				}

				replayState.currentStepIndex++;

				// Add a delay between steps for better UX
				if (replayState.currentStepIndex < replayState.responseSteps.length) {
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
			}
			// Clean up stream reference for normal mode
			this._activeStreams.delete(sessionId);
		}
	}

	// Method to start debugging/stepping through a replay session
	public startReplayDebugging(sessionId: string): ChatSession {
		// Handle debug session ID prefix
		const actualSessionId = sessionId.startsWith('debug:') ? sessionId.substring(6) : sessionId;
		const debugSessionId = sessionId.startsWith('debug:') ? sessionId : `debug:${sessionId}`;

		const sessionData = this._sessions.get(actualSessionId);
		if (!sessionData) {
			// If session data doesn't exist, we need to parse it first
			const dummyToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { } }) } as CancellationToken;
			this.provideChatSessionContentInternal(actualSessionId, dummyToken, false);
			const updatedSessionData = this._sessions.get(actualSessionId);
			if (!updatedSessionData) {
				throw new Error(`Failed to load session data for ${actualSessionId}`);
			}
		}

		const finalSessionData = this._sessions.get(actualSessionId)!;

		// Find all response steps (toolCall and request) for the entire session
		const responseSteps: ChatStep[] = [];
		for (const step of finalSessionData.chatSteps) {
			if (step.kind === 'request' || step.kind === 'toolCall') {
				responseSteps.push(step);
			}
		}

		// Store debug state using the DEBUG session ID (with prefix)
		this._activeReplays.set(debugSessionId, {
			responseSteps,
			currentStepIndex: 0
		});

		// Return the chat session with debug mode enabled
		const dummyToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { } }) } as CancellationToken;
		return this.provideChatSessionContentForDebug(debugSessionId, dummyToken);
	}

	// Method to step to next item (called by debug session)
	public async stepNext(sessionId: string) {
		const replayState = this._activeReplays.get(sessionId);
		const stream = this._activeStreams.get(sessionId);

		if (replayState && stream && replayState.currentStepIndex < replayState.responseSteps.length) {
			// Stream the current step
			await this.streamCurrentStep(sessionId, stream);
			// Advance to next step
			replayState.currentStepIndex++;

			// Clean up if we've reached the end
			if (replayState.currentStepIndex >= replayState.responseSteps.length) {
				this._activeStreams.delete(sessionId);
			}
		}
	}

	private async streamCurrentStep(sessionId: string, stream: ChatResponseStream) {
		const replayState = this._activeReplays.get(sessionId);
		if (!replayState || replayState.currentStepIndex >= replayState.responseSteps.length) {
			return;
		}

		const step = replayState.responseSteps[replayState.currentStepIndex];

		if (step.kind === 'request') {
			const result = Array.isArray(step.result) ? step.result.join('') : (step.result || '');
			stream.markdown(result);
		} else if (step.kind === 'toolCall') {
			const toolPart = new ChatToolInvocationPart(step.toolName, step.id);
			toolPart.isComplete = true;
			toolPart.isError = false;
			toolPart.isConfirmed = true;

			stream.push(toolPart);
			if (step.edits && step.edits.length > 0) {
				await Promise.all(step.edits.map(edit => this.editHelper.makeEdit(edit, stream)));
			}
			// const toolContent = `**Tool Call: ${step.toolName}**\n\nArguments:\n\`\`\`json\n${JSON.stringify(step.args, null, 2)}\n\`\`\`\n\nResults:\n${step.results.join('\n')}`;
			// stream.markdown(toolContent);
		}
	}

	private parseReplay(content: string): ChatStep[] {
		const parsed = JSON.parse(content);
		const prompts = (parsed.prompts && Array.isArray(parsed.prompts) ? parsed.prompts : [parsed]) as { [key: string]: any }[];

		if (prompts.filter(p => !p.prompt).length) {
			throw new Error('Invalid replay content: expected a prompt object or an array of prompts in the base JSON structure.');
		}

		const steps: ChatStep[] = [];
		for (const prompt of prompts) {
			steps.push(...this.parsePrompt(prompt));
		}

		return steps;
	}

	private parsePrompt(prompt: { [key: string]: any }): ChatStep[] {
		const steps: ChatStep[] = [];
		steps.push({
			kind: 'userQuery',
			query: prompt.prompt,
			line: 0,
		});

		for (const log of prompt.logs) {
			if (log.kind === 'toolCall') {
				steps.push({
					kind: 'toolCall',
					id: log.id,
					line: 0,
					toolName: log.tool,
					args: JSON.parse(log.args),
					edits: log.edits,
					results: log.response
				});
			} else if (log.kind === 'request') {
				steps.push({
					kind: 'request',
					id: log.id,
					line: 0,
					prompt: log.messages,
					result: log.response.message
				});
			}
		}

		return steps;
	}

	fireSessionsChanged(): void {
		this._onDidChangeChatSessionItems.fire();
	}
}

interface ChatReplaySessionData {
	filePath: string;
	chatSteps: ChatStep[];
	history: ReadonlyArray<ChatRequestTurn2 | ChatResponseTurn2>;
}

interface ChatReplayState {
	responseSteps: ChatStep[];
	currentStepIndex: number;
}