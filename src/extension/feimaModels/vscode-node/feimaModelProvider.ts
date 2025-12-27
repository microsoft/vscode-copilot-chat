/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';

/**
 * Dummy authentication provider ID - must match the ID used in DummyAuthProvider
 */
const FEIMA_AUTH_PROVIDER_ID = 'feima-authentication';

/**
 * Dummy language model provider that returns mock responses.
 * This is for PoC purposes to test chat functionality without real AI models.
 */
export class FeimaModelProvider implements vscode.LanguageModelChatProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(
		private readonly qwen3Endpoint: IChatEndpoint | undefined,
		private readonly lmWrapper: CopilotLanguageModelWrapper | undefined
	) { }

	/**
	 * Fire a change event to notify VS Code that model information has changed
	 */
	public fireChangeEvent(): void {
		this._onDidChange.fire();
	}

	/**
	 * Provide available dummy models
	 */
	async provideLanguageModelChatInformation(
		_options: { silent: boolean },
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		console.log('[FeimaModelProvider] provideLanguageModelChatInformation called');

		// Check if user is authenticated with feima auth
		const session = await vscode.authentication.getSession(
			FEIMA_AUTH_PROVIDER_ID,
			[],
			{ createIfNone: false, silent: true }
		);

		if (!session) {
			console.log('[FeimaModelProvider] No feima auth session found - returning empty models');
			return [];
		}

		console.log('[FeimaModelProvider] Dummy auth session found - returning models');
		const models: vscode.LanguageModelChatInformation[] = [
			{
				id: 'feima-fast',
				name: 'Feima Fast Model',
				family: 'feima-fast',
				tooltip: 'A fast dummy model for testing (requires feima auth)',
				detail: '1x',
				maxInputTokens: 100000,
				maxOutputTokens: 4096,
				version: '1.0.0',
				isUserSelectable: true,
				capabilities: {
					toolCalling: true
				}
				// Note: No authProviderId - makes this model universally accessible
			},
			{
				id: 'feima-smart',
				name: 'Feima Smart Model',
				family: 'feima-smart',
				tooltip: 'A smarter dummy model for testing (requires feima auth)',
				detail: '2x',
				maxInputTokens: 200000,
				maxOutputTokens: 8192,
				version: '1.0.0',
				isUserSelectable: true,
				capabilities: {
					toolCalling: true
				}
				// Note: Authentication is checked in provideLanguageModelChatInformation()
			},
		];

		// Add Qwen3 Coder model if endpoint is configured
		if (this.qwen3Endpoint) {
			console.log('[FeimaModelProvider] Adding Qwen3 Coder model to list');
			models.push({
				id: 'qwen3-coder-plus',
				name: 'Qwen3 Coder',
				family: 'qwen3',
				tooltip: 'Real Qwen3 Coder LLM (OpenAI-compatible API)',
				detail: 'Real LLM',
				maxInputTokens: this.qwen3Endpoint.modelMaxPromptTokens,
				maxOutputTokens: this.qwen3Endpoint.maxOutputTokens,
				version: '1.0.0',
				isUserSelectable: true,
				capabilities: {
					toolCalling: this.qwen3Endpoint.supportsToolCalls
				}
			});
		} else {
			console.log('[FeimaModelProvider] Qwen3 endpoint NOT configured - model will not be available');
		}
		console.log('[FeimaModelProvider] Returning', models.length, 'models:', models.map(m => m.id).join(', '));
		return models;
	}

	/**
	 * Provide chat responses - returns dummy text with simulated delay
	 */
	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: vscode.LanguageModelChatMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {

		// Use real Qwen3 LLM for qwen3-coder-plus model
		if (model.id === 'qwen3-coder-plus' && this.qwen3Endpoint && this.lmWrapper) {
			console.log('[FeimaModelProvider] Using real Qwen3 LLM for qwen3-coder-plus');
			return this.lmWrapper.provideLanguageModelResponse(
				this.qwen3Endpoint,
				messages,
				options,
				'GitHub.copilot-chat', // extensionId - must be the actual extension ID from package.json
				progress,
				token
			);
		}

		console.log('[FeimaModelProvider] Using feima response for model:', model.id);

		// For other models, use feima responses
		// Check for cancellation
		if (token.isCancellationRequested) {
			return;
		}

		// Simulate processing delay
		await new Promise(resolve => setTimeout(resolve, 500));

		if (token.isCancellationRequested) {
			return;
		}

		// Get the last user message
		const lastMessage = messages[messages.length - 1];
		const userMessageText = typeof lastMessage.content === 'string'
			? lastMessage.content
			: lastMessage.content.map(part =>
				part instanceof vscode.LanguageModelTextPart ? part.value : '[non-text]'
			).join('');

		// Generate feima response
		const responseText = this.generateDummyResponse(model, userMessageText, messages.length);

		// Stream the response word by word for realistic effect
		const words = responseText.split(' ');
		for (let i = 0; i < words.length; i++) {
			if (token.isCancellationRequested) {
				return;
			}

			const word = i === 0 ? words[i] : ' ' + words[i];
			progress.report(new vscode.LanguageModelTextPart(word));

			// Small delay between words for streaming effect
			await new Promise(resolve => setTimeout(resolve, 30));
		}
	}

	/**
	 * Provide token count estimation
	 */
	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		// Simple estimation: ~4 characters per token
		if (typeof text === 'string') {
			return Math.ceil(text.length / 4);
		}

		// For messages, count all text content
		const content = text.content;

		// Sum up all text parts
		let totalLength = 0;
		for (const part of content) {
			// Check if it's a LanguageModelTextPart by checking for value property
			if ('value' in part && typeof part.value === 'string') {
				totalLength += part.value.length;
			}
		}
		return Math.ceil(totalLength / 4);
	}

	/**
	 * Generate a feima response based on the model and input
	 */
	private generateDummyResponse(
		model: vscode.LanguageModelChatInformation,
		userMessage: string,
		messageCount: number
	): string {
		const responses = [
			`Hello! I'm the ${model.name}, a dummy AI model for testing. You said: "${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}"`,
			`This is a simulated response from ${model.name}. I received ${messageCount} message(s) in this conversation.`,
			`I'm ${model.name}, processing your request about "${userMessage.substring(0, 40)}${userMessage.length > 40 ? '...' : ''}". This is a mock response for PoC purposes.`,
			`${model.name} here! I understand you're asking about "${userMessage.substring(0, 30)}${userMessage.length > 30 ? '...' : ''}". Let me provide a feima response for testing.`
		];

		// Pick a response based on message length
		const index = userMessage.length % responses.length;
		return responses[index];
	}
}
