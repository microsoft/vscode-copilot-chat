/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { toTextParts } from '../../chat/common/globalStringUtils';
import { ILogService } from '../../log/common/logService';
import { ITelemetryService, multiplexProperties } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { APIJsonData, CAPIChatMessage, ChatCompletion, rawMessageToCAPI } from '../common/openai';
import { FinishedCompletion, convertToAPIJsonData } from './stream';

// TODO @lramos15 - Find a better file for this, since this file is for the chat stream and should not be telemetry related
export function sendEngineMessagesLengthTelemetry(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, isOutput: boolean, logService?: ILogService) {
	const messageType = isOutput ? 'output' : 'input';

	// Get the unique model call ID - it should already be set in the base telemetryData
	const modelCallId = telemetryData.properties.modelCallId as string;
	if (!modelCallId) {
		// This shouldn't happen if the ID was properly generated at request start
		logService?.warn('[TELEMETRY] modelCallId not found in telemetryData, input/output messages cannot be linked');
		return;
	}

	// Create messages with content and tool_calls arguments replaced by length
	const messagesWithLength = messages.map(msg => {
		const processedMsg: any = {
			...msg, // This preserves ALL existing fields including tool_calls, tool_call_id, copilot_references, etc.
			content: typeof msg.content === 'string'
				? msg.content.length
				: Array.isArray(msg.content)
					? msg.content.reduce((total: number, part: any) => {
						if (typeof part === 'string') {
							return total + part.length;
						}
						if (part.type === 'text') {
							return total + (part.text?.length || 0);
						}
						return total;
					}, 0)
					: 0,
		};

		// Process tool_calls if present
		if ('tool_calls' in msg && msg.tool_calls && Array.isArray(msg.tool_calls)) {
			processedMsg.tool_calls = msg.tool_calls.map((toolCall: any) => ({
				...toolCall,
				function: toolCall.function ? {
					...toolCall.function,
					arguments: typeof toolCall.function.arguments === 'string'
						? toolCall.function.arguments.length
						: toolCall.function.arguments
				} : toolCall.function
			}));
		}

		return processedMsg;
	});

	const telemetryDataWithPrompt = telemetryData.extendedBy({
		messagesJson: JSON.stringify(messagesWithLength),
		message_direction: messageType,
		modelCallId: modelCallId, // Include at telemetry event level too
	});

	telemetryService.sendEnhancedGHTelemetryEvent('engine.messages.length', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
	telemetryService.sendInternalMSFTTelemetryEvent('engine.messages.length', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
}

export function sendEngineMessagesTelemetry(telemetryService: ITelemetryService, messages: CAPIChatMessage[], telemetryData: TelemetryData, isOutput: boolean, logService?: ILogService) {
	const telemetryDataWithPrompt = telemetryData.extendedBy({
		messagesJson: JSON.stringify(messages),
	});
	telemetryService.sendEnhancedGHTelemetryEvent('engine.messages', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);
	telemetryService.sendInternalMSFTTelemetryEvent('engine.messages', multiplexProperties(telemetryDataWithPrompt.properties), telemetryDataWithPrompt.measurements);

	// Also send length-only telemetry
	sendEngineMessagesLengthTelemetry(telemetryService, messages, telemetryData, isOutput, logService);
}

export function prepareChatCompletionForReturn(
	telemetryService: ITelemetryService,
	logService: ILogService,
	c: FinishedCompletion,
	telemetryData: TelemetryData
): ChatCompletion {
	let messageContent = c.solution.text.join('');

	let blockFinished = false;
	if (c.finishOffset !== undefined) {
		// Trim solution to finishOffset returned by finishedCb
		logService.debug(`message ${c.index}: early finish at offset ${c.finishOffset}`);
		messageContent = messageContent.substring(0, c.finishOffset);
		blockFinished = true;
	}

	logService.info(`message ${c.index} returned. finish reason: [${c.reason}]`);
	logService.debug(
		`message ${c.index} details: finishOffset: [${c.finishOffset}] completionId: [{${c.requestId.completionId}}] created: [{${c.requestId.created}}]`
	);
	const jsonData: APIJsonData = convertToAPIJsonData(c.solution);
	const message: Raw.ChatMessage = {
		role: Raw.ChatRole.Assistant,
		content: toTextParts(messageContent),
	};

	// Create enhanced message for telemetry with usage information
	const telemetryMessage = rawMessageToCAPI(message);

	// Add request metadata to telemetry data
	telemetryData.extendWithRequestId(c.requestId);

	// Add usage information to telemetryData if available
	let telemetryDataWithUsage = telemetryData;
	if (c.usage) {
		telemetryDataWithUsage = telemetryData.extendedBy({}, {
			promptTokens: c.usage.prompt_tokens,
			completionTokens: c.usage.completion_tokens,
			totalTokens: c.usage.total_tokens
		});
	}

	sendEngineMessagesTelemetry(telemetryService, [telemetryMessage], telemetryDataWithUsage, true, logService);
	return {
		message: message,
		choiceIndex: c.index,
		requestId: c.requestId,
		blockFinished: blockFinished,
		finishReason: c.reason,
		filterReason: c.filterReason,
		error: c.error,
		tokens: jsonData.tokens,
		usage: c.usage,
		telemetryData: telemetryDataWithUsage,
	};
}
