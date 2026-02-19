/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { ITrajectoryLogger } from '../../../platform/trajectory/common/trajectoryLogger';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAgentDebugEventService } from '../../agentDebug/common/agentDebugEventService';
import { AgentDebugEventCategory, ILLMRequestEvent } from '../../agentDebug/common/agentDebugTypes';
import { IExtensionContribution } from '../../common/contributions';

/**
 * Provider that supplies session overview information by aggregating data
 * from trajectory steps and agent debug events.
 *
 * Metrics produced:
 * - **User Messages**: count of trajectory steps with `source === 'user'`
 * - **Tokens Generated**: sum of completion tokens across all agent steps
 *   (sourced from trajectory step metrics, with a fallback to LLMRequest
 *   events from the agent debug event service)
 */
export class ChatDebugSessionOverviewProviderContribution extends Disposable implements IExtensionContribution {
	readonly id = 'chatDebugSessionOverviewProvider';

	constructor(
		@ITrajectoryLogger private readonly _trajectoryLogger: ITrajectoryLogger,
		@IAgentDebugEventService private readonly _debugEventService: IAgentDebugEventService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._logService.info('[ChatDebugSessionOverviewProvider] Registering chat debug session overview provider');
		try {
			this._register(vscode.chat.registerChatDebugSessionOverviewProvider({
				provideChatDebugSessionOverview: (sessionId, token) =>
					this._provideChatDebugSessionOverview(sessionId, token),
			}));
		} catch (e) {
			this._logService.warn(`[ChatDebugSessionOverviewProvider] Failed to register: ${e}`);
		}
	}

	private _provideChatDebugSessionOverview(
		sessionId: string,
		_token: vscode.CancellationToken,
	): vscode.ChatDebugSessionOverview | undefined {
		this._logService.info(`[ChatDebugSessionOverviewProvider] provideChatDebugSessionOverview called for session: ${sessionId}`);

		const allTrajectories = this._trajectoryLogger.getAllTrajectories();
		const trajectory = allTrajectories.get(sessionId);

		let userMessageCount = 0;
		let tokensGenerated = 0;
		let sessionTitle: string | undefined;

		// Primary source: trajectory steps
		if (trajectory) {
			for (const step of trajectory.steps) {
				if (step.source === 'user') {
					userMessageCount++;
					if (!sessionTitle) {
						// Use the first user message as the session title
						sessionTitle = step.message.length > 120
							? step.message.slice(0, 120) + '…'
							: step.message;
					}
				}
				if (step.metrics?.completion_tokens !== undefined) {
					tokensGenerated += step.metrics.completion_tokens;
				}
			}

			// Use final_metrics if available and we haven't gathered per-step data
			if (tokensGenerated === 0 && trajectory.final_metrics?.total_completion_tokens !== undefined) {
				tokensGenerated = trajectory.final_metrics.total_completion_tokens;
			}
		}

		// Supplementary source: LLMRequest events from the debug event service
		if (tokensGenerated === 0) {
			const events = this._debugEventService.getEvents({
				sessionId,
				categories: [AgentDebugEventCategory.LLMRequest],
			});
			for (const event of events) {
				const lr = event as ILLMRequestEvent;
				tokensGenerated += lr.completionTokens;
			}
		}

		// Count user messages from LoopControl events if trajectory had none
		if (userMessageCount === 0) {
			const loopEvents = this._debugEventService.getEvents({
				sessionId,
				categories: [AgentDebugEventCategory.LoopControl],
			});
			for (const event of loopEvents) {
				const details = event.details;
				if (details['source'] === 'user' || event.summary.toLowerCase().includes('user message')) {
					userMessageCount++;
					if (!sessionTitle && details['message']) {
						const msg = String(details['message']);
						sessionTitle = msg.length > 120 ? msg.slice(0, 120) + '…' : msg;
					}
				}
			}
		}

		const metrics: vscode.ChatDebugSessionOverviewMetric[] = [
			{ label: 'User Messages', value: String(userMessageCount) },
			{ label: 'Tokens Generated', value: tokensGenerated.toLocaleString() },
		];

		this._logService.info(`[ChatDebugSessionOverviewProvider] Session ${sessionId}: ${userMessageCount} user messages, ${tokensGenerated} tokens generated`);

		return {
			sessionTitle,
			metrics,
		};
	}
}
