/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { AggressivenessLevel } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { DelaySession } from './delay';

export class UserInteractionMonitor {

	private static readonly MAX_INTERACTIONS_CONSIDERED = 10;

	private _recentUserActions: { time: number; kind: 'accepted' | 'rejected' }[] = [];

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
	) { }

	// Capture user interactions

	public handleAcceptance(): void {
		this._recordUserAction('accepted');
	}

	public handleRejection(): void {
		this._recordUserAction('rejected');
	}

	private _recordUserAction(kind: 'accepted' | 'rejected') {
		this._recentUserActions.push({ time: Date.now(), kind });
		// keep at most 10 user actions
		this._recentUserActions = this._recentUserActions.slice(-UserInteractionMonitor.MAX_INTERACTIONS_CONSIDERED);
	}

	// Creates a DelaySession based on recent user interactions

	public createDelaySession(requestTime: number | undefined): DelaySession {
		const baseDebounceTime = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsDebounce, this._experimentationService);

		const backoffDebounceEnabled = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsBackoffDebounceEnabled, this._experimentationService);
		const expectedTotalTime = backoffDebounceEnabled ? this._getExpectedTotalTime(baseDebounceTime) : undefined;

		return new DelaySession(baseDebounceTime, expectedTotalTime, requestTime);
	}

	private _getExpectedTotalTime(baseDebounceTime: number): number {
		const DEBOUNCE_DECAY_TIME_MS = 10 * 60 * 1000; // 10 minutes
		const MAX_DEBOUNCE_TIME = 3000; // 3 seconds
		const MIN_DEBOUNCE_TIME = 50; // 50 ms
		const REJECTION_WEIGHT = 1.5;
		const ACCEPTANCE_WEIGHT = 0.8;
		const now = Date.now();
		let multiplier = 1;

		// Calculate impact of each action with time decay
		for (const action of this._recentUserActions) {
			const timeSinceAction = now - action.time;
			if (timeSinceAction > DEBOUNCE_DECAY_TIME_MS) {
				continue;
			}

			// Exponential decay: impact decreases as time passes
			const decayFactor = Math.exp(-timeSinceAction / DEBOUNCE_DECAY_TIME_MS);
			const actionWeight = action.kind === 'rejected' ? REJECTION_WEIGHT : ACCEPTANCE_WEIGHT;
			multiplier *= 1 + ((actionWeight - 1) * decayFactor);
		}

		let debounceTime = baseDebounceTime * multiplier;

		// Clamp the debounce time to reasonable bounds
		debounceTime = Math.min(MAX_DEBOUNCE_TIME, Math.max(MIN_DEBOUNCE_TIME, debounceTime));

		return debounceTime;
	}

	// Determine aggressiveness level based on user interactions

	/**
	 * Returns the aggressiveness level and the user happiness score that was used to derive it.
	 * The score is returned to avoid race conditions when logging telemetry.
	 */
	public getAggressivenessLevel(): { aggressivenessLevel: AggressivenessLevel; userHappinessScore: number | undefined } {
		const configuredAggressivenessLevel = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsXtabAggressivenessLevel, this._experimentationService);

		if (configuredAggressivenessLevel !== undefined) {
			return { aggressivenessLevel: configuredAggressivenessLevel, userHappinessScore: undefined };
		}

		let level: AggressivenessLevel;
		const userHappinessScore = this._getUserHappinessScore();
		if (userHappinessScore >= 0.7) {
			level = AggressivenessLevel.High;
		} else if (userHappinessScore >= 0.4) {
			level = AggressivenessLevel.Medium;
		} else {
			level = AggressivenessLevel.Low;
		}
		return { aggressivenessLevel: level, userHappinessScore };
	}

	/**
	 * Value between 0 and 1 indicating user happiness.
	 * 1 means very happy, 0 means very unhappy.
	 */
	private _getUserHappinessScore(): number {
		if (this._recentUserActions.length === 0) {
			return 0.5; // neutral score when no data
		}

		let weightedScore = 0;
		let totalWeight = 0;

		for (let i = 0; i < this._recentUserActions.length; i++) {
			const action = this._recentUserActions[i];
			// Calculate weight based on position (more recent = higher weight)
			// Position 0 (oldest) has lowest weight, last position has highest weight
			const weight = i + 1;

			// Accepted = 1, Rejected = 0
			const score = action.kind === 'accepted' ? 1 : 0;

			weightedScore += score * weight;
			totalWeight += weight;
		}

		const rawScore = totalWeight > 0 ? weightedScore / totalWeight : 0.5;

		// Adjust score towards neutral (0.5) when we have fewer data points
		// This prevents extreme scores with limited data
		const dataConfidence = this._recentUserActions.length / UserInteractionMonitor.MAX_INTERACTIONS_CONSIDERED;
		return 0.5 + (rawScore - 0.5) * dataConfidence;
	}
}