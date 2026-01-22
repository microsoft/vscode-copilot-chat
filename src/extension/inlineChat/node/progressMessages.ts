/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IEnvService } from '../../../platform/env/common/envService';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { ProgressMessageScenario, ProgressMessagesPrompt, ProgressMessagesPromptProps } from '../../prompts/node/inline/progressMessages';

const MESSAGES_PER_FETCH = 10;
const REFETCH_THRESHOLD = 3;

interface MessageCache {
	readonly messages: string[];
	readonly fetchInProgress: boolean;
}

/**
 * Provides catchy progress messages for inline chat operations.
 * Pre-fetches messages and automatically replenishes when running low.
 */
export class InlineChatProgressMessages {

	private readonly _caches = new Map<ProgressMessageScenario, MessageCache>();
	private readonly _pendingFetches = new Map<ProgressMessageScenario, Promise<void>>();

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IEnvService private readonly _envService: IEnvService,
	) {
		// Initialize caches with fallback messages
		this._caches.set('generate', { messages: [...InlineChatProgressMessages._FALLBACK_GENERATE], fetchInProgress: false });
		this._caches.set('edit', { messages: [...InlineChatProgressMessages._FALLBACK_EDIT], fetchInProgress: false });

		this.prewarm();
	}

	private static readonly _FALLBACK_GENERATE: readonly string[] = [
		'Working...',
	];

	private static readonly _FALLBACK_EDIT: readonly string[] = [
		'Working...',
	];

	/**
	 * Gets the next progress message for the given scenario.
	 * Automatically triggers a background fetch when running low on messages.
	 */
	getNextMessage(scenario: ProgressMessageScenario): string {
		const cache = this._caches.get(scenario);
		if (!cache || cache.messages.length === 0) {
			// Should never happen, but use fallback
			const fallbacks = scenario === 'generate'
				? InlineChatProgressMessages._FALLBACK_GENERATE
				: InlineChatProgressMessages._FALLBACK_EDIT;
			return fallbacks[Math.floor(Math.random() * fallbacks.length)];
		}

		// Get a random message and remove it from the cache
		const index = Math.floor(Math.random() * cache.messages.length);
		const message = cache.messages[index];
		const newMessages = [...cache.messages];
		newMessages.splice(index, 1);

		this._caches.set(scenario, { messages: newMessages, fetchInProgress: cache.fetchInProgress });

		// Trigger background fetch if running low
		if (newMessages.length < REFETCH_THRESHOLD && !cache.fetchInProgress) {
			this._triggerBackgroundFetch(scenario);
		}

		return message;
	}

	/**
	 * Pre-warms the cache by fetching messages for both scenarios.
	 * Can be called during extension activation.
	 */
	prewarm(): void {
		this._triggerBackgroundFetch('generate');
		this._triggerBackgroundFetch('edit');
	}

	private _triggerBackgroundFetch(scenario: ProgressMessageScenario): void {
		if (this._pendingFetches.has(scenario)) {
			return;
		}

		if (this._envService.isSimulation()) {
			return;
		}

		const currentCache = this._caches.get(scenario);
		if (currentCache) {
			this._caches.set(scenario, { messages: currentCache.messages, fetchInProgress: true });
		}

		const fetchPromise = this._fetchMessages(scenario).finally(() => {
			this._pendingFetches.delete(scenario);
			const cache = this._caches.get(scenario);
			if (cache) {
				this._caches.set(scenario, { messages: cache.messages, fetchInProgress: false });
			}
		});

		this._pendingFetches.set(scenario, fetchPromise);
	}

	private async _fetchMessages(scenario: ProgressMessageScenario): Promise<void> {
		try {
			const endpoint = await this._endpointProvider.getChatEndpoint('copilot-fast');

			const props: ProgressMessagesPromptProps = { scenario, count: MESSAGES_PER_FETCH };
			const { messages: promptMessages } = await renderPromptElement(
				this._instantiationService,
				endpoint,
				ProgressMessagesPrompt,
				props
			);

			const response = await endpoint.makeChatRequest2({
				debugName: 'progressMessages',
				messages: promptMessages,
				finishedCb: undefined,
				location: ChatLocation.Editor,
				userInitiatedRequest: false,
				isConversationRequest: false,
			}, CancellationToken.None);

			if (response.type === ChatFetchResponseType.Success) {
				const newMessages = this._parseMessages(response.value);
				if (newMessages.length > 0) {
					const currentCache = this._caches.get(scenario);
					const existingMessages = currentCache?.messages ?? [];
					this._caches.set(scenario, {
						messages: [...existingMessages, ...newMessages],
						fetchInProgress: false
					});
					this._logService.trace(`[InlineChatProgressMessages] Fetched ${newMessages.length} messages for ${scenario}`);
				}
			} else {
				this._logService.warn(`[InlineChatProgressMessages] Failed to fetch messages for ${scenario}: ${response.reason}`);
			}
		} catch (err) {
			this._logService.error(`[InlineChatProgressMessages] Error fetching messages for ${scenario}`, err);
		}
	}

	private _parseMessages(responseText: string): string[] {
		try {
			// Try to extract JSON array from the response
			const trimmed = responseText.trim();
			let jsonStr = trimmed;

			// Handle markdown code blocks
			const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
			if (jsonMatch) {
				jsonStr = jsonMatch[1].trim();
			}

			const parsed = JSON.parse(jsonStr);
			if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
				return parsed.filter(msg => msg.length > 0 && msg.length < 50);
			}
		} catch (err) {
			this._logService.error('[InlineChatProgressMessages] Failed to parse response as JSON', err);
		}

		return [];
	}
}
