/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../util/vs/platform/instantiation/common/instantiation';
import { analyzeRequest, getCompletionCriteria, RequestAnalysis, shouldRequireFullCompletion } from './actionWordAnalysis';

export interface IActionWordService {
	readonly _serviceBrand: undefined;

	/**
	 * Analyzes a user request for action words and completion requirements
	 */
	analyzeRequest(request: string): RequestAnalysis;

	/**
	 * Gets completion criteria text for the agent based on analysis
	 */
	getCompletionCriteria(analysis: RequestAnalysis): string;

	/**
	 * Determines if a request should require full completion
	 */
	shouldRequireFullCompletion(analysis: RequestAnalysis): boolean;
}

export const IActionWordService = createDecorator<IActionWordService>('actionWordService');

export class ActionWordService implements IActionWordService {
	declare readonly _serviceBrand: undefined;

	analyzeRequest(request: string): RequestAnalysis {
		return analyzeRequest(request);
	}

	getCompletionCriteria(analysis: RequestAnalysis): string {
		return getCompletionCriteria(analysis);
	}

	shouldRequireFullCompletion(analysis: RequestAnalysis): boolean {
		return shouldRequireFullCompletion(analysis);
	}
}
