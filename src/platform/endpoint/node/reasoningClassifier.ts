/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';

// Remote reasoning classifier configuration
export const REASONING_CLASSIFIER_API_URL = 'https://model-router-v0.yellowforest-598004f3.westus3.azurecontainerapps.io/predict';

interface ReasoningClassifierResponse {
	text: string;
	predicted_label: 'needs_reasoning' | 'no_reasoning';
	confidence: number;
	scores: {
		needs_reasoning: number;
		no_reasoning: number;
	};
}

/**
 * Remote reasoning classifier that calls an external API to determine
 * whether a query requires reasoning or not.
 * Output: true if non-reasoning (simple query), false if reasoning required
 */
export class ReasoningClassifier extends Disposable {
	constructor(
		private readonly _fetcherService: IFetcherService,
		private readonly _logService: ILogService
	) {
		super();
	}

	/**
	 * Classify a query as reasoning or non-reasoning by calling remote API
	 * @param query The user's query text
	 * @returns true if non-reasoning (simple query), false if reasoning required
	 */
	async classify(query: string): Promise<boolean> {
		try {
			const response = await this._fetcherService.fetch(REASONING_CLASSIFIER_API_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ text: query })
			});

			if (!response.ok) {
				throw new Error(`Reasoning classifier API request failed: ${response.statusText}`);
			}

			const body = await response.text();
			const result: ReasoningClassifierResponse = JSON.parse(body);

			const isNonReasoning = result.predicted_label === 'no_reasoning';
			const confidence = result.confidence;

			this._logService.trace(`Reasoning classifier prediction: ${result.predicted_label} (confidence: ${(confidence * 100).toFixed(1)}%, scores: needs_reasoning=${(result.scores.needs_reasoning * 100).toFixed(1)}%, no_reasoning=${(result.scores.no_reasoning * 100).toFixed(1)}%)`);

			return isNonReasoning;
		} catch (error) {
			this._logService.error('Reasoning classification failed', error);
			throw error;
		}
	}
}

