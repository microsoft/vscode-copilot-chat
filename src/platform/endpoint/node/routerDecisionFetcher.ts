/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { Codicon } from '../../../util/vs/base/common/codicons';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { IValidator, vArray, vBoolean, vEnum, vNumber, vObj, vRequired, vString } from '../../configuration/common/validator';
import { ILogService } from '../../log/common/logService';
import { Response } from '../../networking/common/fetcherService';
import { IRequestLogger, LoggedRequestKind } from '../../requestLogger/node/requestLogger';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ICAPIClientService } from '../common/capiClient';

export interface RouterDecisionResponse {
	predicted_label: 'needs_reasoning' | 'no_reasoning';
	confidence: number;
	latency_ms: number;
	chosen_model: string;
	candidate_models: string[];
	scores: {
		needs_reasoning: number;
		no_reasoning: number;
	};
	sticky_override?: boolean;
}

const routerDecisionResponseValidator: IValidator<RouterDecisionResponse> = vObj({
	predicted_label: vRequired(vEnum('needs_reasoning', 'no_reasoning')),
	confidence: vRequired(vNumber()),
	latency_ms: vRequired(vNumber()),
	chosen_model: vRequired(vString()),
	candidate_models: vRequired(vArray(vString())),
	scores: vRequired(vObj({
		needs_reasoning: vRequired(vNumber()),
		no_reasoning: vRequired(vNumber())
	})),
	sticky_override: vBoolean()
});

/**
 * Fetches routing decisions from a classification API to determine which model should handle a query.
 *
 * This class sends queries along with available models to a router API endpoint, which uses reasoning
 * classification to select the most appropriate model based on the query's requirements.
 */
export class RouterDecisionFetcher {
	constructor(
		private readonly _capiClientService: ICAPIClientService,
		private readonly _authService: IAuthenticationService,
		private readonly _logService: ILogService,
		private readonly _telemetryService: ITelemetryService,
		private readonly _requestLogger: IRequestLogger,
	) {
	}

	async getRouterDecision(query: string, autoModeToken: string, availableModels: string[], stickyThreshold?: number): Promise<RouterDecisionResponse> {
		const startTime = Date.now();
		const requestBody: Record<string, unknown> = { prompt: query, available_models: availableModels };
		if (stickyThreshold !== undefined) {
			requestBody.sticky_threshold = stickyThreshold;
		}
		const response = await this._capiClientService.makeRequest<Response>({
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${(await this._authService.getCopilotToken()).token}`,
				'Copilot-Session-Token': autoModeToken,
			},
			body: JSON.stringify(requestBody)
		}, { type: RequestType.ModelRouter });

		if (!response.ok) {
			throw new Error(`Router decision request failed with status ${response.status}: ${response.statusText}`);
		}

		const text = await response.text();
		const { content: result, error: validationError } = routerDecisionResponseValidator.validate(JSON.parse(text));
		if (validationError) {
			throw new Error(`Invalid router decision response: ${validationError.message}`);
		}
		const e2eLatencyMs = Date.now() - startTime;
		this._logService.trace(`[RouterDecisionFetcher] Prediction: ${result.predicted_label}, model: ${result.chosen_model} (confidence: ${(result.confidence * 100).toFixed(1)}%, scores: needs_reasoning=${(result.scores.needs_reasoning * 100).toFixed(1)}%, no_reasoning=${(result.scores.no_reasoning * 100).toFixed(1)}%) (latency_ms: ${result.latency_ms}, e2e_latency_ms: ${e2eLatencyMs}, candidate models: ${result.candidate_models.join(', ')}, sticky_override: ${result.sticky_override ?? false})`);

		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: `Auto Mode Router`,
			startTimeMs: startTime,
			icon: Codicon.lightbulbSparkle,
			markdownContent: [
				`# Auto Mode Router Decision`,
				`## Result`,
				`- **Predicted Label**: ${result.predicted_label}`,
				`- **Chosen Model**: ${result.chosen_model}`,
				`- **Confidence**: ${(result.confidence * 100).toFixed(1)}%`,
			`- **Sticky Override**: ${result.sticky_override ?? false}`,
			`## Scores`,
				`- **Needs Reasoning**: ${(result.scores.needs_reasoning * 100).toFixed(1)}%`,
				`- **No Reasoning**: ${(result.scores.no_reasoning * 100).toFixed(1)}%`,
				`## Latency`,
				`- **Router Latency**: ${result.latency_ms}ms`,
				`- **E2E Latency**: ${e2eLatencyMs}ms`,
				`## Candidate Models`,
				...result.candidate_models.map(m => `- ${m}`),
				`## Query`,
				query,
			].join('\n'),
		});

		/* __GDPR__
			"automode.routerDecision" : {
				"owner": "lramos15",
				"comment": "Reports the routing decision made by the auto mode router API",
				"predictedLabel": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The predicted classification label (needs_reasoning or no_reasoning)" },
				"chosenModel": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The model selected by the router" },
				"confidence": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The confidence score of the routing decision" },
				"latencyMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "The latency of the router API call in milliseconds" },
				"e2eLatencyMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "The end-to-end latency of the router request in milliseconds, including network overhead" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('automode.routerDecision',
			{
				predictedLabel: result.predicted_label,
				chosenModel: result.chosen_model,
			},
			{
				confidence: result.confidence,
				latencyMs: result.latency_ms,
				e2eLatencyMs: e2eLatencyMs,
			}
		);
		return result;
	}
}
