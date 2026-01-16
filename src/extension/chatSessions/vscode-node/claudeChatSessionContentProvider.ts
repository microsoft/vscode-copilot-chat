/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ChatRequestTurn2 } from '../../../vscodeTypes';
import { createFormattedToolInvocation } from '../../agents/claude/common/toolInvocationFormatter';
import { IClaudeCodeModels } from '../../agents/claude/node/claudeCodeModels';
import { IClaudeCodeSession, IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';
import { ClaudeSessionUri } from './claudeChatSessionItemProvider';

const MODELS_OPTION_ID = 'model';

interface ToolContext {
	unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>;
	pendingToolInvocations: Map<string, vscode.ChatToolInvocationPart>;
}

export class ClaudeChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;

	/**
	 * Track session models - when we start new sessions, we don't have the real session id yet.
	 * We also need this when we open a session and later run it.
	 * Instance-level to allow cleanup on dispose.
	 */
	private readonly _sessionModels = new Map<string, string | undefined>();

	constructor(
		@IClaudeCodeSessionService private readonly sessionService: IClaudeCodeSessionService,
		@IClaudeCodeModels private readonly claudeCodeModels: IClaudeCodeModels,
	) {
		super();
	}

	public override dispose(): void {
		this._sessionModels.clear();
		super.dispose();
	}

	/**
	 * Gets the model ID for a session, checking in-memory cache first, then stored preference
	 */
	public async getModelIdForSession(sessionId: string): Promise<string | undefined> {
		// Check in-memory cache first
		if (this._sessionModels.has(sessionId)) {
			return this._sessionModels.get(sessionId);
		}

		// Fall back to default model
		return this.claudeCodeModels.getDefaultModel();
	}

	/**
	 * Sets the model ID for a session
	 */
	public setModelIdForSession(sessionId: string, modelId: string | undefined): void {
		this._sessionModels.set(sessionId, modelId);
	}

	public notifySessionOptionsChange(resource: vscode.Uri, updates: ReadonlyArray<{ optionId: string; value: string | vscode.ChatSessionProviderOptionItem }>): void {
		this._onDidChangeChatSessionOptions.fire({ resource, updates });
	}

	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		const models = await this.claudeCodeModels.getModels();
		const modelItems: vscode.ChatSessionProviderOptionItem[] = models.map(model => ({
			id: model.id,
			name: model.name,
			description: model.multiplier !== undefined ? `${model.multiplier}x` : undefined,
		}));

		return {
			optionGroups: [
				{
					id: MODELS_OPTION_ID,
					name: l10n.t('Model'),
					description: l10n.t('Pick Model'),
					items: modelItems,
				}
			]
		};
	}

	async provideHandleOptionsChange(resource: vscode.Uri, updates: ReadonlyArray<vscode.ChatSessionOptionUpdate>, _token: vscode.CancellationToken): Promise<void> {
		const sessionId = ClaudeSessionUri.getId(resource);
		for (const update of updates) {
			if (update.optionId === MODELS_OPTION_ID) {
				void this.claudeCodeModels.setDefaultModel(update.value);
				this._sessionModels.set(sessionId, update.value);
			}
		}
	}

	async provideChatSessionContent(sessionResource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const sessionId = ClaudeSessionUri.getId(sessionResource);
		const existingSession = await this.sessionService.getSession(sessionResource, token);
		const toolContext = this._createToolContext();
		const history = existingSession ?
			this._buildChatHistory(existingSession, toolContext) :
			[];

		// Get model for session
		const [defaultModel, model] = await Promise.all([
			this.claudeCodeModels.getDefaultModel(),
			this.getModelIdForSession(sessionId)
		]);

		const options: Record<string, string> = {};
		const selectedModel = model ?? defaultModel;
		if (selectedModel) {
			options[MODELS_OPTION_ID] = selectedModel;
			// Keep track of model in memory
			this._sessionModels.set(sessionId, selectedModel);
		}

		return {
			history,
			activeResponseCallback: undefined,
			requestHandler: undefined,
			options,
		};
	}

	private _userMessageToRequest(message: Anthropic.MessageParam, toolContext: ToolContext): vscode.ChatRequestTurn2 | undefined {
		const textContent = this._extractTextContent(message.content);
		this._processToolResults(message.content, toolContext);

		// If the user message only contains tool results and no visible text, don't create a request turn
		if (!textContent.trim()) {
			return;
		}

		// If the message indicates it was interrupted, skip it
		// TODO: I think there's another message that is shown when
		// the user cancels a tool call... I saw it once, so this may
		// need another check.
		if (textContent === '[Request interrupted by user]') {
			return;
		}

		return new ChatRequestTurn2(textContent, undefined, [], '', [], undefined, undefined);
	}

	private _assistantMessageToResponse(message: SDKAssistantMessage['message'], toolContext: ToolContext): vscode.ChatResponseTurn2 {
		const responseParts = coalesce(message.content.map(block => {
			if (block.type === 'text') {
				return new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(block.text));
			} else if (block.type === 'thinking') {
				return new vscode.ChatResponseThinkingProgressPart(block.thinking);
			} else if (block.type === 'tool_use') {
				toolContext.unprocessedToolCalls.set(block.id, block);
				const toolInvocation = createFormattedToolInvocation(block);
				if (toolInvocation) {
					toolContext.pendingToolInvocations.set(block.id, toolInvocation);
				}
				return toolInvocation;
			}
		}));

		return new vscode.ChatResponseTurn2(responseParts, {}, '');
	}

	private _createToolContext(): ToolContext {
		return {
			unprocessedToolCalls: new Map(),
			pendingToolInvocations: new Map()
		};
	}

	private _buildChatHistory(existingSession: IClaudeCodeSession | undefined, toolContext: ToolContext): (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] {
		if (!existingSession) {
			return [];
		}

		return coalesce(existingSession.messages.map((m: SDKMessage) => {
			if (m.type === 'user') {
				return this._userMessageToRequest(m.message, toolContext);
			} else if (m.type === 'assistant') {
				return this._assistantMessageToResponse(m.message, toolContext);
			}
		}));
	}

	private _extractTextContent(content: string | Anthropic.ContentBlockParam[]): string {
		if (typeof content === 'string') {
			return content;
		}

		return content
			.filter((block): block is Anthropic.TextBlockParam => block.type === 'text')
			.map(block => block.text)
			.join('');
	}

	private _processToolResults(content: string | Anthropic.ContentBlockParam[], toolContext: ToolContext): void {
		if (typeof content === 'string') {
			return;
		}

		for (const block of content) {
			if (block.type === 'tool_result') {
				const toolResultBlock = block as Anthropic.ToolResultBlockParam;
				const toolUse = toolContext.unprocessedToolCalls.get(toolResultBlock.tool_use_id);
				if (toolUse) {
					toolContext.unprocessedToolCalls.delete(toolResultBlock.tool_use_id);
					const pendingInvocation = toolContext.pendingToolInvocations.get(toolResultBlock.tool_use_id);
					if (pendingInvocation) {
						pendingInvocation.isConfirmed = true;
						pendingInvocation.isError = toolResultBlock.is_error;
						toolContext.pendingToolInvocations.delete(toolResultBlock.tool_use_id);
					}
				}
			}
		}
	}

}