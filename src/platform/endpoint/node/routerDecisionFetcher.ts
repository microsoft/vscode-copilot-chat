/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { IValidator, vArray, vEnum, vNumber, vObj, vRequired, vString } from '../../configuration/common/validator';
import { ILogService } from '../../log/common/logService';
import { IFetcherService, Response } from '../../networking/common/fetcherService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';

interface RouterDecisionResponse {
	predicted_label: 'needs_reasoning' | 'no_reasoning';
	confidence: number;
	latency_ms: number;
	chosen_model: string;
	candidate_models: string[];
	scores: {
		needs_reasoning: number;
		no_reasoning: number;
	};
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
	}))
});

const MAX_RETRIES = 3;
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

/**
 * Fetches routing decisions from a classification API to determine which model should handle a query.
 *
 * This class sends queries along with available models to a router API endpoint, which uses reasoning
 * classification to select the most appropriate model based on the query's requirements.
 */
export class RouterDecisionFetcher extends Disposable {
	constructor(
		private readonly _fetcherService: IFetcherService,
		private readonly _logService: ILogService,
		private readonly _configurationService: IConfigurationService,
		private readonly _experimentationService: IExperimentationService,
		private readonly _telemetryService: ITelemetryService
	) {
		super();
	}

	async getRoutedModel(query: string, availableModels: string[], preferredModels: string[]): Promise<string> {
		const routerApiUrl = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.AutoModeRouterUrl, this._experimentationService);
		if (!routerApiUrl) {
			throw new Error('Router API URL not configured');
		}

		let lastError: Error | undefined;
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			let response: Response;
			try {
				response = await this._fetcherService.fetch(routerApiUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					retryFallbacks: true,
					body: JSON.stringify({ prompt: query, available_models: availableModels, preferred_models: preferredModels })
				});
			} catch (error) {
				// Network error - retry
				lastError = error instanceof Error ? error : new Error(String(error));
				this._logService.warn(`[RouterDecisionFetcher] Network error, retrying (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}`);
				continue;
			}

			if (RETRYABLE_STATUS_CODES.includes(response.status)) {
				lastError = new Error(`[RouterDecisionFetcher] API request failed: ${response.statusText} (status: ${response.status})`);
				this._logService.warn(`[RouterDecisionFetcher] Returned ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES})`);
				continue;
			}

			if (!response.ok) {
				// Non-retryable HTTP error (e.g. 404, 400, 401) - fail immediately
				const error = new Error(`[RouterDecisionFetcher] API request failed: ${response.status}`);
				this._logService.error('[RouterDecisionFetcher] Request failed: ', error.message);
				throw error;
			}

			let json: unknown;
			try {
				json = await response.json();
			} catch {
				throw new Error('Invalid router decision response: malformed JSON');
			}
			const { content: result, error: validationError } = routerDecisionResponseValidator.validate(json);
			if (validationError) {
				throw new Error(`Invalid router decision response: ${validationError.message}`);
			}

			this._logService.trace(`[RouterDecisionFetcher] Prediction: ${result.predicted_label}, model: ${result.chosen_model} (confidence: ${(result.confidence * 100).toFixed(1)}%, scores: needs_reasoning=${(result.scores.needs_reasoning * 100).toFixed(1)}%, no_reasoning=${(result.scores.no_reasoning * 100).toFixed(1)}%) (latency_ms: ${result.latency_ms}, candidate models: ${result.candidate_models.join(', ')}, preferred models: ${preferredModels.join(', ')})`);

			this._telemetryService.sendGHTelemetryEvent('autoMode.routerDecision', {
				routerUrl: routerApiUrl,
				chosenModel: result.chosen_model,
				predictedLabel: result.predicted_label,
			}, {
				confidence: result.confidence,
				latencyMs: result.latency_ms,
			});

			return result.chosen_model;
		}

		this._logService.error('[RouterDecisionFetcher] Failed after retries: ', lastError?.message);
		throw lastError;
	}
}
