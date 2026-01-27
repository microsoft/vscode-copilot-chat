/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PermissionMode, SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ChatRequestTurn2 } from '../../../vscodeTypes';
import { createFormattedToolInvocation } from '../../agents/claude/common/toolInvocationFormatter';
import { IClaudeCodeModels } from '../../agents/claude/node/claudeCodeModels';
import { IClaudeCodeSession, IClaudeCodeSessionService } from '../../agents/claude/node/claudeCodeSessionService';
import { IClaudeSessionStateService } from '../../agents/claude/node/claudeSessionStateService';
import { ClaudeSessionUri } from './claudeChatSessionItemProvider';

const MODELS_OPTION_ID = 'model';
const PERMISSION_MODE_OPTION_ID = 'permissionMode';

interface ToolContext {
	unprocessedToolCalls: Map<string, Anthropic.ToolUseBlock>;
	pendingToolInvocations: Map<string, vscode.ChatToolInvocationPart>;
}

export class ClaudeChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;

	private readonly _onDidChangeChatSessionProviderOptions = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionProviderOptions = this._onDidChangeChatSessionProviderOptions.event;

	// Track the last known option values for each session to detect actual changes
	private readonly _lastKnownOptions = new Map<string, { modelId?: string; permissionMode?: PermissionMode }>();

	private _sessionIdResolver: ((resource: vscode.Uri) => string | undefined) | undefined;

	constructor(
		@IClaudeCodeSessionService private readonly sessionService: IClaudeCodeSessionService,
		@IClaudeCodeModels private readonly claudeCodeModels: IClaudeCodeModels,
		@IClaudeSessionStateService private readonly sessionStateService: IClaudeSessionStateService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// Listen for configuration changes to update available options
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.ClaudeAgentAllowDangerouslySkipPermissions.fullyQualifiedId)) {
				this._onDidChangeChatSessionProviderOptions.fire();
			}
		}));

		// Listen for state changes and notify UI only if value actually changed
		this._register(this.sessionStateService.onDidChangeSessionState(e => {
			const lastKnown = this._lastKnownOptions.get(e.sessionId);
			const updates: { optionId: string; value: string }[] = [];

			if (e.modelId !== undefined && e.modelId !== lastKnown?.modelId) {
				updates.push({ optionId: MODELS_OPTION_ID, value: e.modelId });
				this._updateLastKnown(e.sessionId, { modelId: e.modelId });
			}
			if (e.permissionMode !== undefined && e.permissionMode !== lastKnown?.permissionMode) {
				updates.push({ optionId: PERMISSION_MODE_OPTION_ID, value: e.permissionMode });
				this._updateLastKnown(e.sessionId, { permissionMode: e.permissionMode });
			}

			if (updates.length > 0) {
				const resource = ClaudeSessionUri.forSessionId(e.sessionId);
				this._onDidChangeChatSessionOptions.fire({ resource, updates });
			}
		}));
	}

	private _updateLastKnown(sessionId: string, update: { modelId?: string; permissionMode?: PermissionMode }): void {
		const existing = this._lastKnownOptions.get(sessionId) ?? {};
		this._lastKnownOptions.set(sessionId, { ...existing, ...update });
	}

	public override dispose(): void {
		this._lastKnownOptions.clear();
		super.dispose();
	}

	/**
	 * Sets the resolver function for mapping resources to Claude session IDs.
	 * This is needed to handle overridden resources (e.g., untitled sessions).
	 */
	public setSessionIdResolver(resolver: (resource: vscode.Uri) => string | undefined): void {
		this._sessionIdResolver = resolver;
	}

	/**
	 * Resolves a resource to a Claude session ID.
	 * Uses the custom resolver if set, otherwise falls back to ClaudeSessionUri.getId.
	 */
	private _resolveSessionId(resource: vscode.Uri): string | undefined {
		if (this._sessionIdResolver) {
			return this._sessionIdResolver(resource);
		}
		// Fallback to direct URI parsing
		try {
			return ClaudeSessionUri.getId(resource);
		} catch {
			return undefined;
		}
	}

	/**
	 * Gets the model ID for a session, delegating to state service
	 */
	public async getModelIdForSession(sessionId: string): Promise<string | undefined> {
		return this.sessionStateService.getModelIdForSession(sessionId);
	}

	/**
	 * Gets the permission mode for a session
	 */
	public getPermissionModeForSession(sessionId: string): PermissionMode {
		return this.sessionStateService.getPermissionModeForSession(sessionId);
	}

	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		const models = await this.claudeCodeModels.getModels();
		const modelItems: vscode.ChatSessionProviderOptionItem[] = models.map(model => ({
			id: model.id,
			name: model.name,
			description: model.multiplier !== undefined ? `${model.multiplier}x` : undefined,
		}));

		const permissionModeItems: vscode.ChatSessionProviderOptionItem[] = [
			{ id: 'default', name: l10n.t('Ask before edits') },
			{ id: 'acceptEdits', name: l10n.t('Edit automatically') },
			{ id: 'plan', name: l10n.t('Plan mode') },
		];

		// Add bypass permissions option if enabled via setting
		if (this.configurationService.getConfig(ConfigKey.ClaudeAgentAllowDangerouslySkipPermissions)) {
			permissionModeItems.push({ id: 'bypassPermissions', name: l10n.t('Bypass all permissions') });
		}

		return {
			optionGroups: [
				{
					id: PERMISSION_MODE_OPTION_ID,
					name: l10n.t('Permission Mode'),
					description: l10n.t('Pick Permission Mode'),
					items: permissionModeItems,
				},
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
		const sessionId = this._resolveSessionId(resource);
		if (!sessionId) {
			return;
		}
		for (const update of updates) {
			if (update.optionId === MODELS_OPTION_ID) {
				// Update last known first so the event listener won't fire back to UI
				this._updateLastKnown(sessionId, { modelId: update.value });
				void this.claudeCodeModels.setDefaultModel(update.value);
				this.sessionStateService.setModelIdForSession(sessionId, update.value);
			} else if (update.optionId === PERMISSION_MODE_OPTION_ID) {
				// Update last known first so the event listener won't fire back to UI
				this._updateLastKnown(sessionId, { permissionMode: update.value as PermissionMode });
				this.sessionStateService.setPermissionModeForSession(sessionId, update.value as PermissionMode);
			}
		}
	}

	async provideChatSessionContent(sessionResource: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.ChatSession> {
		const sessionId = this._resolveSessionId(sessionResource);
		const existingSession = await this.sessionService.getSession(sessionResource, token);
		const toolContext = this._createToolContext();
		const history = existingSession ?
			this._buildChatHistory(existingSession, toolContext) :
			[];

		// Get model and permission mode from state service (queries session if active)
		const model = sessionId ? await this.sessionStateService.getModelIdForSession(sessionId) : undefined;
		const permissionMode = sessionId ? this.sessionStateService.getPermissionModeForSession(sessionId) : 'default';

		const options: Record<string, string> = {};
		if (model) {
			options[MODELS_OPTION_ID] = model;
		}
		options[PERMISSION_MODE_OPTION_ID] = permissionMode;

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