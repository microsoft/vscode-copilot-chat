/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ChatRequestTurn2 } from '../../../vscodeTypes';
import { completeToolInvocation, createFormattedToolInvocation } from '../../agents/claude/common/toolInvocationFormatter';
import { IClaudeCodeModels, NoClaudeModelsAvailableError } from '../../agents/claude/node/claudeCodeModels';
import { IClaudeSessionStateService } from '../../agents/claude/node/claudeSessionStateService';
import { IClaudeCodeSessionService } from '../../agents/claude/node/sessionParser/claudeCodeSessionService';
import { AssistantMessageContent, ContentBlock, IClaudeCodeSession, TextBlock, ThinkingBlock, ToolResultBlock, ToolUseBlock } from '../../agents/claude/node/sessionParser/claudeSessionSchema';
import { ClaudeSessionUri } from './claudeChatSessionItemProvider';

const MODELS_OPTION_ID = 'model';
const PERMISSION_MODE_OPTION_ID = 'permissionMode';

/** Sentinel value indicating no Claude models with Messages API are available */
export const UNAVAILABLE_MODEL_ID = '__unavailable__';

interface ToolContext {
	unprocessedToolCalls: Map<string, ContentBlock>;
	pendingToolInvocations: Map<string, vscode.ChatToolInvocationPart>;
}

// #region Helpers

/**
 * Checks if a text block contains a system-reminder tag.
 * System-reminders are stored in separate content blocks and should not be rendered.
 */
function isSystemReminderBlock(text: string): boolean {
	return text.includes('<system-reminder>');
}

/**
 * Strips <system-reminder> tags and their content from a string.
 * Used for backwards compatibility with legacy sessions where system-reminders
 * were concatenated with user text in a single string.
 *
 * TODO: Remove this function after a few releases (added in 0.38.x) once legacy
 * sessions with concatenated system-reminders are no longer common.
 */
function stripSystemReminders(text: string): string {
	return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '');
}

// #endregion

// #region Type Guards
function isTextBlock(block: ContentBlock): block is TextBlock {
	return block.type === 'text';
}

function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
	return block.type === 'thinking';
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
	return block.type === 'tool_use';
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
	return block.type === 'tool_result';
}
// #endregion

export class ClaudeChatSessionContentProvider extends Disposable implements vscode.ChatSessionContentProvider {
	private readonly _onDidChangeChatSessionOptions = this._register(new Emitter<vscode.ChatSessionOptionChangeEvent>());
	readonly onDidChangeChatSessionOptions = this._onDidChangeChatSessionOptions.event;

	private readonly _onDidChangeChatSessionProviderOptions = this._register(new Emitter<void>());
	readonly onDidChangeChatSessionProviderOptions = this._onDidChangeChatSessionProviderOptions.event;

	// Track the last known option values for each session to detect actual changes
	private readonly _lastKnownOptions = new Map<string, { modelId?: string; permissionMode?: PermissionMode }>();

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
	 * Gets the model ID for a session, delegating to state service.
	 * @throws {NoClaudeModelsAvailableError} if no Claude models with Messages API are available
	 */
	public async getModelIdForSession(sessionId: string): Promise<string> {
		const availableModels = await this.claudeCodeModels.getModels();
		if (availableModels.length === 0) {
			throw new NoClaudeModelsAvailableError();
		}

		// Load the session to extract SDK model if needed
		const sessionUri = ClaudeSessionUri.forSessionId(sessionId);
		const session = await this.sessionService.getSession(sessionUri, CancellationToken.None);

		const resolvedModel = await this._resolveModelForSession(session);
		return resolvedModel;
	}

	/**
	 * Gets the permission mode for a session
	 */
	public getPermissionModeForSession(sessionId: string): PermissionMode {
		return this.sessionStateService.getPermissionModeForSession(sessionId);
	}

	async provideChatSessionProviderOptions(): Promise<vscode.ChatSessionProviderOptions> {
		const models = await this.claudeCodeModels.getModels();
		let modelItems: vscode.ChatSessionProviderOptionItem[];

		if (models.length === 0) {
			// No Claude models with Messages API available - show unavailable placeholder
			modelItems = [{
				id: UNAVAILABLE_MODEL_ID,
				name: l10n.t('Unavailable'),
				description: l10n.t('No Claude models with Messages API found'),
			}];
		} else {
			modelItems = models.map(model => ({
				id: model.id,
				name: model.name,
				description: model.multiplier !== undefined ? `${model.multiplier}x` : undefined,
			}));
		}

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
		const sessionId = ClaudeSessionUri.getId(resource);
		for (const update of updates) {
			if (update.optionId === MODELS_OPTION_ID) {
				// Ignore the unavailable placeholder - it's not a real model
				if (update.value === UNAVAILABLE_MODEL_ID) {
					continue;
				}
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
		const sessionId = ClaudeSessionUri.getId(sessionResource);
		const existingSession = await this.sessionService.getSession(sessionResource, token);
		const toolContext = this._createToolContext();
		const history = existingSession ?
			this._buildChatHistory(existingSession, toolContext) :
			[];

		let model: string | undefined;
		try {
			model = await this._resolveModelForSession(existingSession);
		} catch (e) {
			if (e instanceof NoClaudeModelsAvailableError) {
				model = UNAVAILABLE_MODEL_ID;
			} else {
				throw e;
			}
		}

		const permissionMode = this.sessionStateService.getPermissionModeForSession(sessionId);

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

	private _buildChatHistory(existingSession: IClaudeCodeSession | undefined, toolContext: ToolContext): (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] {
		if (!existingSession) {
			return [];
		}

		// Group consecutive messages of the same type into single turns.
		// The JSONL format stores each API turn as multiple lines, but VS Code's
		// chat API expects alternating request/response turns.
		const result: (vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2)[] = [];
		let i = 0;
		const messages = existingSession.messages;

		while (i < messages.length) {
			const currentType = messages[i].type;

			if (currentType === 'user') {
				// Collect all consecutive user messages
				const userContents: (string | ContentBlock[])[] = [];
				while (i < messages.length && messages[i].type === 'user' && messages[i].message.role === 'user') {
					userContents.push(messages[i].message.content as string | ContentBlock[]);
					i++;
				}
				const requestTurn = this._userMessagesToRequest(userContents, toolContext);
				if (requestTurn) {
					result.push(requestTurn);
				}
			} else if (currentType === 'assistant') {
				// Collect all consecutive assistant messages
				const assistantMessages: AssistantMessageContent[] = [];
				while (i < messages.length && messages[i].type === 'assistant' && messages[i].message.role === 'assistant') {
					assistantMessages.push(messages[i].message as AssistantMessageContent);
					i++;
				}
				const responseTurn = this._assistantMessagesToResponse(assistantMessages, toolContext);
				result.push(responseTurn);
			} else {
				// Skip unknown message types
				i++;
			}
		}

		return result;
	}

	/**
	 * Converts multiple consecutive user messages into a single request turn.
	 */
	private _userMessagesToRequest(contents: (string | ContentBlock[])[], toolContext: ToolContext): vscode.ChatRequestTurn2 | undefined {
		// Process tool results from all messages
		for (const content of contents) {
			this._processToolResults(content, toolContext);
		}

		// Extract and combine text content from all messages
		const textParts: string[] = [];
		for (const content of contents) {
			const text = this._extractTextContent(content);
			if (text.trim()) {
				textParts.push(text);
			}
		}

		const combinedText = textParts.join('\n\n');

		// If no visible text, don't create a request turn
		if (!combinedText.trim()) {
			return;
		}

		// If the message indicates it was interrupted, skip it
		if (combinedText === '[Request interrupted by user]') {
			return;
		}

		return new ChatRequestTurn2(combinedText, undefined, [], '', [], undefined);
	}

	/**
	 * Converts multiple consecutive assistant messages into a single response turn.
	 */
	private _assistantMessagesToResponse(messages: AssistantMessageContent[], toolContext: ToolContext): vscode.ChatResponseTurn2 {
		const allParts: (vscode.ChatResponseMarkdownPart | vscode.ChatResponseThinkingProgressPart | vscode.ChatToolInvocationPart)[] = [];

		for (const message of messages) {
			const parts = coalesce(message.content.map(block => {
				if (isTextBlock(block)) {
					return new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(block.text));
				} else if (isThinkingBlock(block)) {
					return new vscode.ChatResponseThinkingProgressPart(block.thinking);
				} else if (isToolUseBlock(block)) {
					toolContext.unprocessedToolCalls.set(block.id, block);
					const toolInvocation = createFormattedToolInvocation(block);
					if (toolInvocation) {
						toolContext.pendingToolInvocations.set(block.id, toolInvocation);
					}
					return toolInvocation;
				}
			}));
			allParts.push(...parts);
		}

		return new vscode.ChatResponseTurn2(allParts, {}, '');
	}

	private _createToolContext(): ToolContext {
		return {
			unprocessedToolCalls: new Map(),
			pendingToolInvocations: new Map()
		};
	}

	private _extractTextContent(content: string | ContentBlock[]): string {
		if (typeof content === 'string') {
			// TODO: Remove this branch when stripSystemReminders is removed (legacy compat)
			return stripSystemReminders(content);
		}

		// For array content (new format), filter out entire blocks that are system-reminders
		return content
			.filter(isTextBlock)
			.filter(block => !isSystemReminderBlock(block.text))
			.map(block => block.text)
			.join('');
	}

	private _processToolResults(content: string | ContentBlock[], toolContext: ToolContext): void {
		if (typeof content === 'string') {
			return;
		}

		for (const block of content) {
			if (isToolResultBlock(block)) {
				const toolUse = toolContext.unprocessedToolCalls.get(block.tool_use_id);
				if (toolUse && isToolUseBlock(toolUse)) {
					toolContext.unprocessedToolCalls.delete(block.tool_use_id);
					const pendingInvocation = toolContext.pendingToolInvocations.get(block.tool_use_id);
					if (pendingInvocation) {
						pendingInvocation.isComplete = true;
						pendingInvocation.isConfirmed = true;
						pendingInvocation.isError = block.is_error;
						// Populate tool output for display in chat UI
						completeToolInvocation(toolUse, block, pendingInvocation);
						toolContext.pendingToolInvocations.delete(block.tool_use_id);
					}
				}
			}
		}
	}

	/**
	 * Resolves the model to use for a session with fallback logic:
	 * 1. Stored session state (user's explicit selection)
	 * 2. SDK model from session messages (mapped to endpoint model)
	 * 3. Default model
	 *
	 * Caches the result in session state if resolved from fallback logic.
	 */
	private async _resolveModelForSession(session: IClaudeCodeSession | undefined): Promise<string> {
		// 1. Check stored session state (user's explicit selection or cached value)
		if (session) {
			const cachedModel = await this.sessionStateService.getModelIdForSession(session.id);
			if (cachedModel) {
				// Keep the global default in sync with user's selection
				await this.claudeCodeModels.setDefaultModel(cachedModel);
				return cachedModel;
			}
		}

		// 2. Try SDK model from session messages
		if (session) {
			const sdkModel = this._extractModelFromSession(session);
			if (sdkModel) {
				const model = await this.claudeCodeModels.mapSdkModelToEndpointModel(sdkModel);
				if (model) {
					// Cache the resolved model in session state for future retrieval
					this.sessionStateService.setModelIdForSession(session.id, model);
					// Keep the global default in sync with user's selection
					await this.claudeCodeModels.setDefaultModel(model);
					return model;
				}
			}
		}

		// 3. Fall back to default
		return await this.claudeCodeModels.getDefaultModel();
	}

	/**
	 * Extract the SDK model ID from the session's last assistant message.
	 * Returns the raw model ID from the Anthropic API (e.g., 'claude-opus-4-5-20251101').
	 */
	private _extractModelFromSession(session: IClaudeCodeSession): string | undefined {
		// Iterate backwards to find the most recent assistant message with a model
		for (let i = session.messages.length - 1; i >= 0; i--) {
			const msg = session.messages[i];
			if (
				msg.type === 'assistant' &&
				msg.message.role === 'assistant'
			) {
				return msg.message.model;
			}
		}
		return undefined;
	}

}
