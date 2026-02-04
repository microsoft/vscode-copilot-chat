/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ICopilotTokenStore } from '../../../platform/authentication/common/copilotTokenStore';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { ICopilotToolCall } from '../../../platform/networking/common/fetch';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { createServiceIdentifier } from '../../../util/common/services';
import { CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { PromptCategorizationPrompt } from '../../prompts/node/panel/promptCategorization';
import { CATEGORIZE_PROMPT_TOOL_NAME, CATEGORIZE_PROMPT_TOOL_SCHEMA, isValidDomain, isValidIntent, isValidScope, PromptClassification } from '../common/promptCategorizationTaxonomy';

/** Experiment flag to enable prompt categorization */
const EXP_FLAG_PROMPT_CATEGORIZATION = 'copilotchat.promptCategorization';

export const IPromptCategorizerService = createServiceIdentifier<IPromptCategorizerService>('IPromptCategorizerService');

export interface IPromptCategorizerService {
	readonly _serviceBrand: undefined;

	/**
	 * Categorizes the first user prompt in a chat session.
	 * This runs as a fire-and-forget operation and sends results to telemetry.
	 * Only runs for panel location, first attempt, non-subagent requests.
	 * Requires telemetry to be enabled and experiment flag to be set.
	 */
	categorizePrompt(request: vscode.ChatRequest, context: vscode.ChatContext): void;
}

// ISO 8601 duration regex: PT followed by at least one of hours (H), minutes (M), seconds (S)
const ISO_8601_DURATION_REGEX = /^PT(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;

function isValidIsoDuration(duration: string): boolean {
	return ISO_8601_DURATION_REGEX.test(duration);
}

function isValidClassification(obj: unknown): obj is PromptClassification {
	if (typeof obj !== 'object' || obj === null) {
		return false;
	}

	const classification = obj as Record<string, unknown>;

	return (
		typeof classification.intent === 'string' && isValidIntent(classification.intent) &&
		typeof classification.domain === 'string' && isValidDomain(classification.domain) &&
		typeof classification.scope === 'string' && isValidScope(classification.scope) &&
		typeof classification.confidence === 'number' && classification.confidence >= 0 && classification.confidence <= 1 &&
		typeof classification.reasoning === 'string' &&
		typeof classification.timeEstimate === 'object' && classification.timeEstimate !== null &&
		typeof (classification.timeEstimate as Record<string, unknown>).bestCase === 'string' &&
		isValidIsoDuration((classification.timeEstimate as Record<string, unknown>).bestCase as string) &&
		typeof (classification.timeEstimate as Record<string, unknown>).realistic === 'string' &&
		isValidIsoDuration((classification.timeEstimate as Record<string, unknown>).realistic as string)
	);
}

export class PromptCategorizerService implements IPromptCategorizerService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
		@ITabsAndEditorsService private readonly tabsAndEditorsService: ITabsAndEditorsService,
		@ICopilotTokenStore private readonly copilotTokenStore: ICopilotTokenStore,
	) { }

	categorizePrompt(request: vscode.ChatRequest, context: vscode.ChatContext): void {
		// Always enable for internal users; external users require experiment flag
		const isInternal = this.copilotTokenStore.copilotToken?.isInternal === true;
		if (!isInternal && !this.experimentationService.getTreatmentVariable<boolean>(EXP_FLAG_PROMPT_CATEGORIZATION)) {
			return;
		}

		// Guard conditions - only run for first attempt, panel location, non-subagent
		// location2 === undefined means Panel (ChatRequestEditorData = editor, ChatRequestNotebookData = notebook)
		if (request.location2 !== undefined) {
			return;
		}
		if (request.subAgentName !== undefined) {
			return;
		}
		if (request.attempt !== 0) {
			return;
		}
		// Only categorize truly first messages in a session
		if (context.history.length > 0) {
			return;
		}

		// Fire and forget - don't await
		this._categorizePromptAsync(request, context).catch(err => {
			this.logService.error(`[PromptCategorizer] Error categorizing prompt: ${err instanceof Error ? err.message : String(err)}`);
		});
	}

	private async _categorizePromptAsync(request: vscode.ChatRequest, _context: vscode.ChatContext): Promise<void> {
		const startTime = Date.now();
		let success = false;
		let classification: PromptClassification | undefined;

		// Gather context signals (outside try block for telemetry access)
		const currentLanguage = this.tabsAndEditorsService.activeTextEditor?.document.languageId;

		// Use 10 second timeout - classification should be fast with copilot-fast model
		const CATEGORIZATION_TIMEOUT_MS = 10_000;
		const cts = new CancellationTokenSource();
		const timeoutHandle = setTimeout(() => cts.cancel(), CATEGORIZATION_TIMEOUT_MS);

		try {
			const endpoint = await this.endpointProvider.getChatEndpoint('copilot-fast');

			const { messages } = await renderPromptElement(
				this.instantiationService,
				endpoint,
				PromptCategorizationPrompt,
				{
					userRequest: request.prompt,
				}
			);

			// Collect tool calls from the response stream
			const toolCalls: ICopilotToolCall[] = [];

			const response = await endpoint.makeChatRequest2({
				debugName: 'promptCategorization',
				messages,
				finishedCb: async (_text, _index, delta) => {
					if (delta.copilotToolCalls) {
						toolCalls.push(...delta.copilotToolCalls);
					}
					return undefined;
				},
				location: ChatLocation.Panel,
				userInitiatedRequest: false,
				isConversationRequest: false,
				requestOptions: {
					tools: [{
						type: 'function',
						function: {
							name: CATEGORIZE_PROMPT_TOOL_NAME,
							description: 'Classify a user prompt across intent, domain, scope, and time estimate dimensions',
							parameters: CATEGORIZE_PROMPT_TOOL_SCHEMA
						}
					}],
					tool_choice: { type: 'function', function: { name: CATEGORIZE_PROMPT_TOOL_NAME } }
				}
			}, cts.token);

			if (cts.token.isCancellationRequested) {
				this.logService.debug('[PromptCategorizer] Request cancelled due to timeout');
				// Don't return early - still send telemetry below to track timeouts
			} else if (response.type === ChatFetchResponseType.Success) {
				// Find the categorize_prompt tool call
				const categorizationCall = toolCalls.find(tc => tc.name === CATEGORIZE_PROMPT_TOOL_NAME);

				if (categorizationCall) {
					try {
						const parsed = JSON.parse(categorizationCall.arguments);
						if (isValidClassification(parsed)) {
							classification = parsed;
							success = true;
						} else {
							this.logService.warn(`[PromptCategorizer] Invalid classification structure: ${categorizationCall.arguments.substring(0, 200)}`);
						}
					} catch (parseError) {
						this.logService.warn(`[PromptCategorizer] Failed to parse tool arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
					}
				} else {
					this.logService.warn('[PromptCategorizer] No categorization tool call found in response');
				}
			} else {
				this.logService.warn(`[PromptCategorizer] Request failed with type: ${response.type}`);
			}
		} catch (err) {
			this.logService.error(`[PromptCategorizer] Error during categorization: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			clearTimeout(timeoutHandle);
			cts.dispose();
		}

		const latencyMs = Date.now() - startTime;

		// Send telemetry
		this.telemetryService.sendMSFTTelemetryEvent(
			'promptCategorization',
			{
				sessionId: request.sessionId ?? '',
				requestId: request.id ?? '',
				modeName: request.modeInstructions2?.name,
				currentLanguage: currentLanguage ?? '',
				intent: classification?.intent ?? 'unknown',
				domain: classification?.domain ?? 'unknown',
				timeEstimateBestCase: classification?.timeEstimate?.bestCase ?? '',
				timeEstimateRealistic: classification?.timeEstimate?.realistic ?? '',
				scope: classification?.scope ?? 'unknown',
			},
			{
				promptLength: request.prompt.length,
				numReferences: request.references?.length ?? 0,
				numToolReferences: request.toolReferences?.length ?? 0,
				confidence: classification?.confidence ?? 0,
				latencyMs,
				success: success ? 1 : 0,
			}
		);

		// Send internal telemetry with full metrics including PAI data (reasoning + prompt)
		// Truncate prompt to 8192 chars to avoid telemetry backend limits; promptLength measurement preserves original size
		const MAX_TELEMETRY_PROMPT_LENGTH = 8192;
		const truncatedPrompt = request.prompt.length > MAX_TELEMETRY_PROMPT_LENGTH
			? request.prompt.slice(0, MAX_TELEMETRY_PROMPT_LENGTH)
			: request.prompt;

		this.telemetryService.sendInternalMSFTTelemetryEvent(
			'promptCategorization',
			{
				sessionId: request.sessionId ?? '',
				requestId: request.id ?? '',
				modeName: request.modeInstructions2?.name,
				currentLanguage: currentLanguage ?? '',
				intent: classification?.intent ?? 'unknown',
				domain: classification?.domain ?? 'unknown',
				timeEstimateBestCase: classification?.timeEstimate?.bestCase ?? '',
				timeEstimateRealistic: classification?.timeEstimate?.realistic ?? '',
				scope: classification?.scope ?? 'unknown',
				reasoning: classification?.reasoning ?? '',
				prompt: truncatedPrompt,
			},
			{
				promptLength: request.prompt.length,
				numReferences: request.references?.length ?? 0,
				numToolReferences: request.toolReferences?.length ?? 0,
				confidence: classification?.confidence ?? 0,
				latencyMs,
				success: success ? 1 : 0,
			}
		);

		this.logService.debug(`[PromptCategorizer] Classification complete: success=${success}, latencyMs=${latencyMs}, intent=${classification?.intent}, domain=${classification?.domain}, scope=${classification?.scope}`);
	}
}
