/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IExecutionMetricsService } from '../node/executionMetricsService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';

/**
 * Contribution that manages agent execution metrics collection and cleanup
 */
export async function setupExecutionMetricsContribution(
	_context: vscode.ExtensionContext,
	instantiationService: IInstantiationService
): Promise<void> {
	// Use invokeFunction to access the metrics service
	await instantiationService.invokeFunction(async (accessor) => {
		const metricsService = accessor.get(IExecutionMetricsService);
		
		// Listen for chat requests and track them
		if (vscode.chat) {
			const allParticipants = (vscode.chat as any).getAllParticipants ? (vscode.chat as any).getAllParticipants() : [];
			for (const participant of allParticipants) {
				// Log when a session completes for metrics cleanup
				participant.onDidReceiveFeedback?.((e: any) => {
					if (metricsService && e.sessionId) {
						// End the tracking session
						metricsService.endSession(e.sessionId);
					}
				});
			}
		}
	});
}
