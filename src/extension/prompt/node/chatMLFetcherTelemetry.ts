/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatFetchError } from '../../../platform/chat/common/commonTypes';
import { isAutoModel } from '../../../platform/endpoint/node/autoChatEndpoint';
import { IChatEndpoint, IEndpointBody } from '../../../platform/networking/common/networking';
import { ChatCompletion } from '../../../platform/networking/common/openai';
import { ITelemetryService, TelemetryProperties } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { isBYOKModel } from '../../byok/node/openAIEndpoint';

export interface IChatMLFetcherSuccessfulData {
	requestId: string;
	chatCompletion: ChatCompletion;
	baseTelemetry: TelemetryData | undefined;
	userInitiatedRequest: boolean | undefined;
	chatEndpointInfo: IChatEndpoint | undefined;
	requestBody: IEndpointBody;
	maxResponseTokens: number;
	promptTokenCount: number;
	timeToFirstToken: number;
	timeToFirstTokenEmitted: number;
	hasImageMessages: boolean;
}

export interface IChatMLFetcherCancellationProperties {
	source: string;
	requestId: string;
	model: string;
	apiType: string | undefined;
	associatedRequestId?: string;
}

export interface IChatMLFetcherCancellationMeasures {
	totalTokenMax: number;
	promptTokenCount: number;
	tokenCountMax: number;
	timeToFirstToken: number | undefined;
	timeToFirstTokenEmitted?: number;
	timeToCancelled: number;
	isVisionRequest: number;
	isBYOK: number;
	isAuto: number;
}

export class ChatMLFetcherTelemetrySender {

	public static sendSuccessTelemetry(
		telemetryService: ITelemetryService,
		{
			requestId,
			chatCompletion,
			baseTelemetry,
			userInitiatedRequest,
			chatEndpointInfo,
			requestBody,
			maxResponseTokens,
			promptTokenCount,
			timeToFirstToken,
			timeToFirstTokenEmitted,
			hasImageMessages
		}: IChatMLFetcherSuccessfulData,
	) {
		/* __GDPR__
			"response.success" : {
				"owner": "digitarald",
				"comment": "Report quality details for a successful service response.",
				"reason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reason for why a response finished" },
				"filterReason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reason for why a response was filtered" },
				"source": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Source of the initial request" },
				"initiatorType": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was initiated by a user or an agent" },
				"model": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Model selection for the response" },
				"modelInvoked": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Actual model invoked for the response" },
				"apiType": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "API type for the response- chat completions or responses" },
				"requestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the current turn request" },
				"associatedRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Another request ID that this request is associated with (eg, the originating request of a summarization request)." },
				"reasoningEffort": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reasoning effort level" },
				"reasoningSummary": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reasoning summary level" },
				"totalTokenMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum total token window", "isMeasurement": true },
				"clientPromptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens, locally counted", "isMeasurement": true },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens, server side counted", "isMeasurement": true },
				"promptCacheTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens hitting cache as reported by server", "isMeasurement": true },
				"tokenCountMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum generated tokens", "isMeasurement": true },
				"tokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of generated tokens", "isMeasurement": true },
				"reasoningTokens": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of reasoning tokens", "isMeasurement": true },
				"acceptedPredictionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the prediction that appeared in the completion", "isMeasurement": true },
				"rejectedPredictionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the prediction that appeared in the completion", "isMeasurement": true },
				"completionTokens": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Number of tokens in the output", "isMeasurement": true },
				"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
				"timeToFirstTokenEmitted": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token emitted (visible text)", "isMeasurement": true },
				"timeToComplete": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to complete the request", "isMeasurement": true },
				"isVisionRequest": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the request was for a vision model", "isMeasurement": true },
				"isBYOK": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for a BYOK model", "isMeasurement": true },
				"isAuto": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for an Auto model", "isMeasurement": true },
				"retryAfterErrorCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response failed and this is a retry attempt, this contains the error category." },
				"retryAfterFilterCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response was filtered and this is a retry attempt, this contains the original filtered content category." }
			}
		*/
		telemetryService.sendTelemetryEvent('response.success', { github: true, microsoft: true }, {
			reason: chatCompletion.finishReason,
			filterReason: chatCompletion.filterReason,
			source: baseTelemetry?.properties.messageSource ?? 'unknown',
			initiatorType: userInitiatedRequest ? 'user' : 'agent',
			model: chatEndpointInfo?.model,
			modelInvoked: chatCompletion.model,
			apiType: chatEndpointInfo?.apiType,
			requestId,
			associatedRequestId: baseTelemetry?.properties.associatedRequestId,
			reasoningEffort: requestBody.reasoning?.effort,
			reasoningSummary: requestBody.reasoning?.summary,
			...(baseTelemetry?.properties.retryAfterErrorCategory ? { retryAfterErrorCategory: baseTelemetry.properties.retryAfterErrorCategory } : {}),
			...(baseTelemetry?.properties.retryAfterFilterCategory ? { retryAfterFilterCategory: baseTelemetry.properties.retryAfterFilterCategory } : {}),
		}, {
			totalTokenMax: chatEndpointInfo?.modelMaxPromptTokens ?? -1,
			tokenCountMax: maxResponseTokens,
			promptTokenCount: chatCompletion.usage?.prompt_tokens,
			promptCacheTokenCount: chatCompletion.usage?.prompt_tokens_details?.cached_tokens,
			clientPromptTokenCount: promptTokenCount,
			tokenCount: chatCompletion.usage?.total_tokens,
			reasoningTokens: chatCompletion.usage?.completion_tokens_details?.reasoning_tokens,
			acceptedPredictionTokens: chatCompletion.usage?.completion_tokens_details?.accepted_prediction_tokens,
			rejectedPredictionTokens: chatCompletion.usage?.completion_tokens_details?.rejected_prediction_tokens,
			completionTokens: chatCompletion.usage?.completion_tokens,
			timeToFirstToken,
			timeToFirstTokenEmitted,
			timeToComplete: baseTelemetry ? Date.now() - baseTelemetry.issuedTime : -1,
			isVisionRequest: hasImageMessages ? 1 : -1,
			isBYOK: isBYOKModel(chatEndpointInfo),
			isAuto: isAutoModel(chatEndpointInfo)
		});
	}

	public static sendCancellationTelemetry(
		telemetryService: ITelemetryService,
		{
			source,
			requestId,
			model,
			apiType,
			associatedRequestId
		}: IChatMLFetcherCancellationProperties,
		{
			totalTokenMax,
			promptTokenCount,
			tokenCountMax,
			timeToFirstToken,
			timeToFirstTokenEmitted,
			timeToCancelled,
			isVisionRequest,
			isBYOK,
			isAuto
		}: IChatMLFetcherCancellationMeasures
	) {
		/* __GDPR__
			"response.cancelled" : {
				"owner": "digitarald",
				"comment": "Report canceled service responses for quality.",
				"model": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Model selection for the response" },
				"apiType": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "API type for the response- chat completions or responses" },
				"source": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Source for why the request was made" },
				"requestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the request" },
				"associatedRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Another request ID that this request is associated with (eg, the originating request of a summarization request)." },
				"totalTokenMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum total token window", "isMeasurement": true },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens", "isMeasurement": true },
				"tokenCountMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum generated tokens", "isMeasurement": true },
				"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
				"timeToFirstTokenEmitted": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token emitted (visible text)", "isMeasurement": true },
				"timeToCancelled": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
				"isVisionRequest": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the request was for a vision model", "isMeasurement": true },
				"isBYOK": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for a BYOK model", "isMeasurement": true },
				"isAuto": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for an Auto model", "isMeasurement": true },
				"retryAfterErrorCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response failed and this is a retry attempt, this contains the error category." },
				"retryAfterFilterCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response was filtered and this is a retry attempt, this contains the original filtered content category." }
			}
		*/
		telemetryService.sendTelemetryEvent('response.cancelled', { github: true, microsoft: true }, {
			apiType,
			source,
			requestId,
			model,
			associatedRequestId,
		}, {
			totalTokenMax,
			promptTokenCount,
			tokenCountMax,
			timeToFirstToken,
			timeToFirstTokenEmitted,
			timeToCancelled,
			isVisionRequest,
			isBYOK,
			isAuto
		});
	}

	public static sendResponseErrorTelemetry(
		telemetryService: ITelemetryService,
		processed: ChatFetchError,
		telemetryProperties: TelemetryProperties | undefined,
		ourRequestId: string,
		chatEndpointInfo: IChatEndpoint,
		requestBody: IEndpointBody,
		tokenCount: number,
		maxResponseTokens: number,
		timeToFirstToken: number,
		isVisionRequest: boolean,
	) {
		/* __GDPR__
			"response.error" : {
				"owner": "digitarald",
				"comment": "Report quality issue for when a service response failed.",
				"type": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Type of issue" },
				"reason": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reason of issue" },
				"model": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Model selection for the response" },
				"apiType": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "API type for the response- chat completions or responses" },
				"source": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Source for why the request was made" },
				"requestId": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Id of the request" },
				"associatedRequestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Another request ID that this request is associated with (eg, the originating request of a summarization request)." },
				"reasoningEffort": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reasoning effort level" },
				"reasoningSummary": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Reasoning summary level" },
				"totalTokenMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum total token window", "isMeasurement": true },
				"promptTokenCount": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of prompt tokens", "isMeasurement": true },
				"tokenCountMax": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Maximum generated tokens", "isMeasurement": true },
				"timeToFirstToken": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token", "isMeasurement": true },
				"timeToFirstTokenEmitted": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Time to first token emitted (visible text)", "isMeasurement": true },
				"isVisionRequest": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether the request was for a vision model", "isMeasurement": true },
				"isBYOK": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for a BYOK model", "isMeasurement": true },
				"isAuto": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the request was for an Auto model", "isMeasurement": true },
				"retryAfterErrorCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response failed and this is a retry attempt, this contains the error category." },
				"retryAfterFilterCategory": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "If the response was filtered and this is a retry attempt, this contains the original filtered content category." }
			}
		*/
		telemetryService.sendTelemetryEvent('response.error', { github: true, microsoft: true }, {
			type: processed.type,
			reason: processed.reasonDetail || processed.reason,
			source: telemetryProperties?.messageSource ?? 'unknown',
			requestId: ourRequestId,
			model: chatEndpointInfo.model,
			apiType: chatEndpointInfo.apiType,
			reasoningEffort: requestBody.reasoning?.effort,
			reasoningSummary: requestBody.reasoning?.summary,
			associatedRequestId: telemetryProperties?.associatedRequestId,
			...(telemetryProperties?.retryAfterErrorCategory ? { retryAfterErrorCategory: telemetryProperties.retryAfterErrorCategory } : {}),
			...(telemetryProperties?.retryAfterFilterCategory ? { retryAfterFilterCategory: telemetryProperties.retryAfterFilterCategory } : {})
		}, {
			totalTokenMax: chatEndpointInfo.modelMaxPromptTokens ?? -1,
			promptTokenCount: tokenCount,
			tokenCountMax: maxResponseTokens,
			timeToFirstToken,
			isVisionRequest: isVisionRequest ? 1 : -1,
			isBYOK: isBYOKModel(chatEndpointInfo),
			isAuto: isAutoModel(chatEndpointInfo)
		});
	}
}
