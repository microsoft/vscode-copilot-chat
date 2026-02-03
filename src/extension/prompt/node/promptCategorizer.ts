/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { createServiceIdentifier } from '../../../util/common/services';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { isValidDomain, isValidIntent, isValidScope, PromptClassification } from '../common/promptCategorizationTaxonomy';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { PromptCategorizationPrompt } from '../../prompts/node/panel/promptCategorization';

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

// ISO 8601 duration regex: PT followed by optional hours (H), minutes (M), seconds (S)
const ISO_8601_DURATION_REGEX = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;

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
	) { }

	categorizePrompt(request: vscode.ChatRequest, context: vscode.ChatContext): void {
		// Only run when experiment flag is enabled
		if (!this.experimentationService.getTreatmentVariable<boolean>(EXP_FLAG_PROMPT_CATEGORIZATION)) {
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
			this.logService.error(err instanceof Error ? err : String(err), '[PromptCategorizer] Error categorizing prompt');
		});
	}

	private async _categorizePromptAsync(request: vscode.ChatRequest, _context: vscode.ChatContext): Promise<void> {
		const startTime = Date.now();
		let success = false;
		let classification: PromptClassification | undefined;

		try {
			const endpoint = await this.endpointProvider.getChatEndpoint('copilot-fast');

			// Gather context signals
			// Note: For Panel location, location2 is undefined so these will be false/undefined
			const hasSelection = false;
			const currentFileName: string | undefined = undefined;
			const currentLanguage: string | undefined = undefined;
			const hasErrors = false; // TODO: Could check diagnostics if needed
			const modeName = request.modeInstructions2?.name;

			const { messages } = await renderPromptElement(
				this.instantiationService,
				endpoint,
				PromptCategorizationPrompt,
				{
					userRequest: request.prompt,
					modeName,
					hasSelection,
					currentFileName,
					currentLanguage,
					hasErrors,
				}
			);

			const response = await endpoint.makeChatRequest2({
				debugName: 'promptCategorization',
				messages,
				finishedCb: undefined,
				location: ChatLocation.Panel,
				userInitiatedRequest: false,
				isConversationRequest: false,
			}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { } }) } as vscode.CancellationToken);

			if (response.type === ChatFetchResponseType.Success) {
				const responseText = response.value.trim();

				// Try to parse JSON from potential markdown code block or raw JSON
				let jsonText = responseText;
				const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
				if (codeBlockMatch) {
					jsonText = codeBlockMatch[1].trim();
				}

				try {
					const parsed = JSON.parse(jsonText);
					if (isValidClassification(parsed)) {
						classification = parsed;
						success = true;
					} else {
						this.logService.warn(`[PromptCategorizer] Invalid classification structure: ${jsonText}`);
					}
				} catch (parseError) {
					this.logService.warn(`[PromptCategorizer] Failed to parse JSON response: ${jsonText}`);
				}
			} else {
				this.logService.warn(`[PromptCategorizer] Request failed with type: ${response.type}`);
			}
		} catch (err) {
			this.logService.error(err instanceof Error ? err : String(err), '[PromptCategorizer] Error during categorization');
		}

		const latencyMs = Date.now() - startTime;

		// Send telemetry
		this.telemetryService.sendMSFTTelemetryEvent(
			'promptCategorization',
			{
				sessionId: request.sessionId ?? '',
				requestId: request.id ?? '',
				modeName: request.modeInstructions2?.name,
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

		this.logService.debug(`[PromptCategorizer] Classification complete: success=${success}, latencyMs=${latencyMs}, intent=${classification?.intent}, domain=${classification?.domain}, scope=${classification?.scope}`);
	}
}
