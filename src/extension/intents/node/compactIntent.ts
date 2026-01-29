/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { isCancellationError } from '../../../util/vs/base/common/errors';
import { Event } from '../../../util/vs/base/common/event';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Intent } from '../../common/constants';
import { ChatVariablesCollection } from '../../prompt/common/chatVariablesCollection';
import { Conversation, IResultMetadata, normalizeSummariesOnRounds, TurnStatus } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent, IIntentInvocation, IIntentInvocationContext, IIntentSlashCommandInfo, NullIntentInvocation } from '../../prompt/node/intents';
import { ConversationHistorySummarizationPrompt, ConversationHistorySummarizationPromptProps, SummarizedAgentHistoryProps, SummarizedConversationHistoryPropsBuilder } from '../../prompts/node/agent/summarizedConversationHistory';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { normalizeToolSchema } from '../../tools/common/toolSchemaNormalizer';
import { addCacheBreakpoints } from './cacheBreakpoints';
import { ToolCallingLoop } from './toolCallingLoop';

export class CompactIntent implements IIntent {

	static readonly ID = Intent.Compact;

	readonly id = CompactIntent.ID;
	readonly locations = [ChatLocation.Panel, ChatLocation.Agent];
	readonly description = l10n.t('Summarize the conversation history to reduce context size');
	readonly commandInfo: IIntentSlashCommandInfo = { allowsEmptyArgs: true };
	readonly isListedCapability = false;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) { }

	async handleRequest(
		conversation: Conversation,
		request: vscode.ChatRequest,
		stream: vscode.ChatResponseStream,
		token: CancellationToken,
		_documentContext: IDocumentContext | undefined,
		_agentName: string,
		location: ChatLocation,
		_chatTelemetry: ChatTelemetryBuilder,
		_onPaused: Event<boolean>,
	): Promise<vscode.ChatResult> {
		const summarizationId = generateUuid();
		const stopwatch = new StopWatch(true);

		// Get history from conversation turns, excluding the current /compact request
		const allTurns = [...conversation.turns];
		// The current turn (the /compact request) is the last one, so get all previous turns
		const turns = allTurns.slice(0, -1);
		normalizeSummariesOnRounds(turns);

		const successfulTurns = turns.filter(t => t.responseStatus === TurnStatus.Success);
		if (successfulTurns.length === 0) {
			stream.markdown(l10n.t('There is no conversation history to summarize.'));
			this.sendTelemetry(summarizationId, 'no_history', '', stopwatch.elapsed());
			return {};
		}

		// Get endpoint for summarization
		const forceGpt41 = this.configurationService.getExperimentBasedConfig(ConfigKey.Advanced.AgentHistorySummarizationForceGpt41, this.experimentationService);
		const baseEndpoint = await this.endpointProvider.getChatEndpoint(request);
		const gpt41Endpoint = await this.endpointProvider.getChatEndpoint('gpt-4.1');
		const endpoint = forceGpt41 && (gpt41Endpoint.modelMaxPromptTokens >= baseEndpoint.modelMaxPromptTokens) ?
			gpt41Endpoint :
			baseEndpoint;

		// Build prompt context for summarization
		const promptContext: IBuildPromptContext = {
			requestId: `compact-${summarizationId}`,
			query: '',
			history: turns,
			chatVariables: new ChatVariablesCollection(),
			isContinuation: false,
			toolCallRounds: undefined,
			toolCallResults: undefined,
			conversation,
		};

		// Get the props for summarization (determines which round to summarize from)
		let propsInfo;
		try {
			propsInfo = this.instantiationService.createInstance(SummarizedConversationHistoryPropsBuilder).getProps({
				priority: 0,
				endpoint,
				location,
				promptContext,
				maxToolResultLength: 2000,
			});
		} catch (e) {
			this.logService.error(`[CompactIntent] Failed to get summarization props: ${e.message}`);
			stream.markdown(l10n.t('There is no conversation history to summarize.'));
			this.sendTelemetry(summarizationId, 'no_history', '', stopwatch.elapsed());
			return {};
		}

		stream.progress(l10n.t('Summarizing conversation history...'));

		try {
			const summary = await this.getSummary(endpoint, propsInfo.props, token);

			// Apply summary to the appropriate round in history
			this.applySummaryToHistory(turns, summary, propsInfo.summarizedToolCallRoundId);

			stream.markdown(l10n.t('Conversation history has been summarized. The summary will be used in place of the full history for subsequent messages.'));

			this.sendTelemetry(summarizationId, 'success', endpoint.model, stopwatch.elapsed());

			// Return result with summary metadata so it's persisted
			return {
				metadata: {
					summary: {
						toolCallRoundId: propsInfo.summarizedToolCallRoundId,
						text: summary,
					}
				} satisfies Partial<IResultMetadata>
			};
		} catch (e) {
			if (isCancellationError(e)) {
				this.sendTelemetry(summarizationId, 'cancelled', endpoint.model, stopwatch.elapsed());
				throw e;
			}

			this.logService.error(`[CompactIntent] Summarization failed: ${e.message}`);
			stream.markdown(l10n.t('Failed to summarize conversation history. Please try again.'));
			this.sendTelemetry(summarizationId, 'error', endpoint.model, stopwatch.elapsed(), e.message);
			return {};
		}
	}

	private async getSummary(
		endpoint: IChatEndpoint,
		props: SummarizedAgentHistoryProps,
		token: CancellationToken
	): Promise<string> {
		// Try full mode first, fall back to simple mode
		const forceMode = this.configurationService.getConfig<string | undefined>(ConfigKey.Advanced.AgentHistorySummarizationMode);

		if (forceMode === 'simple') {
			return this.getSummaryWithMode(endpoint, props, token, true);
		}

		try {
			return await this.getSummaryWithMode(endpoint, props, token, false);
		} catch (e) {
			if (isCancellationError(e)) {
				throw e;
			}
			this.logService.warn(`[CompactIntent] Full mode summarization failed, falling back to simple mode: ${e.message}`);
			return this.getSummaryWithMode(endpoint, props, token, true);
		}
	}

	private async getSummaryWithMode(
		endpoint: IChatEndpoint,
		props: SummarizedAgentHistoryProps,
		token: CancellationToken,
		simpleMode: boolean
	): Promise<string> {
		const summarizationProps: ConversationHistorySummarizationPromptProps = {
			...props,
			simpleMode
		};
		const rendered = await renderPromptElement(
			this.instantiationService,
			endpoint,
			ConversationHistorySummarizationPrompt,
			summarizationProps,
			undefined,
			token
		);

		const promptCacheMode = this.configurationService.getExperimentBasedConfig(ConfigKey.Advanced.AgentHistorySummarizationWithPromptCache, this.experimentationService);
		if (promptCacheMode) {
			addCacheBreakpoints(rendered.messages);
		}

		const toolOpts = !simpleMode ? {
			tool_choice: 'none' as const,
			tools: normalizeToolSchema(
				endpoint.family,
				undefined,
				(tool, rule) => {
					this.logService.warn(`Tool ${tool} failed validation: ${rule}`);
				},
			),
		} : undefined;

		const response = await endpoint.makeChatRequest2({
			debugName: `compact-${simpleMode ? 'simple' : 'full'}`,
			messages: ToolCallingLoop.stripInternalToolCallIds(rendered.messages),
			finishedCb: undefined,
			location: ChatLocation.Other,
			requestOptions: {
				temperature: 0,
				stream: false,
				...toolOpts
			},
			enableRetryOnFilter: true
		}, token);

		if (response.type !== ChatFetchResponseType.Success) {
			throw new Error(`Summarization request failed: ${response.reason ?? response.type}`);
		}

		return response.value;
	}

	private applySummaryToHistory(turns: readonly import('../../prompt/common/conversation').Turn[], summary: string, toolCallRoundId: string): void {
		for (const turn of [...turns].reverse()) {
			const round = turn.rounds.find(r => r.id === toolCallRoundId);
			if (round) {
				round.summary = summary;
				return;
			}
		}
	}

	private sendTelemetry(summarizationId: string, outcome: string, model: string, duration: number, errorMessage?: string): void {
		/* __GDPR__
			"compactCommand" : {
				"owner": "lramos15",
				"comment": "Tracks when /compact command is used for manual conversation summarization",
				"summarizationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "An ID to identify this summarization task." },
				"outcome": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The success state or failure reason of the summarization." },
				"model": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model ID used for the summarization." },
				"duration": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "The duration of the summarization in ms." },
				"errorMessage": { "classification": "CallstackOrException", "purpose": "PerformanceAndHealth", "comment": "Error message if summarization failed." }
			}
		*/
		this.telemetryService.sendMSFTTelemetryEvent('compactCommand', {
			summarizationId,
			outcome,
			model,
			errorMessage
		}, {
			duration
		});
	}

	async invoke(invocationContext: IIntentInvocationContext): Promise<IIntentInvocation> {
		// handleRequest is used instead, but we need to return something
		const endpoint = await this.endpointProvider.getChatEndpoint(invocationContext.request);
		return new NullIntentInvocation(this, invocationContext.location, endpoint);
	}
}
