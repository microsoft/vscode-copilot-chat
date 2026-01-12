/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';

// Remote reasoning classifier configuration
export const ROUTER_API_URL = 'https://gh-model-router-v1.yellowforest-598004f3.westus3.azurecontainerapps.io/predict';

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

/**
 * Fetches routing decisions from a classification API to determine which model should handle a query.
 *
 * This class sends queries along with available models to a router API endpoint, which uses reasoning
 * classification to select the most appropriate model based on the query's requirements.
 */
export class RouterDecisionFetcher extends Disposable {
	constructor(
		private readonly _fetcherService: IFetcherService,
		private readonly _logService: ILogService
	) {
		super();
	}

	async getRoutedModel(query: string, availableModels: string[], preferredModels: string[]): Promise<string> {
		try {
			const response = await this._fetcherService.fetch(ROUTER_API_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ prompt: query, available_models: availableModels, preferred_models: preferredModels })
			});

			if (!response.ok) {
				throw new Error(`Reasoning classifier API request failed: ${response.statusText}`);
			}

			const result: RouterDecisionResponse = await response.json();

			this._logService.trace(`Reasoning classifier prediction: ${result.predicted_label}, model: ${result.chosen_model} (confidence: ${(result.confidence * 100).toFixed(1)}%, scores: needs_reasoning=${(result.scores.needs_reasoning * 100).toFixed(1)}%, no_reasoning=${(result.scores.no_reasoning * 100).toFixed(1)}%) (latency_ms: ${result.latency_ms}, candidate models: ${result.candidate_models.join(', ')}, preferred models: ${preferredModels.join(', ')})`);

			return result.chosen_model;
		} catch (error) {
			this._logService.error('Reasoning classification failed', error);
			throw error;
		}
	}
}
