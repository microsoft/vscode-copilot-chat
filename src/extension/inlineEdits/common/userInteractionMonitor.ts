/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { AggressivenessLevel, DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION, USER_HAPPINESS_SCORE_CONFIGURATION_VALIDATOR, UserHappinessScoreConfiguration } from '../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { DelaySession } from './delay';

export class UserInteractionMonitor {

	private static readonly MAX_INTERACTIONS_CONSIDERED = 10;
	/**
	 * Store more actions than we consider to allow for ignored action limiting.
	 * When ignored actions are skipped, we can still fill the window from deeper history.
	 */
	private static readonly MAX_INTERACTIONS_STORED = 30;

	/**
	 * Used for aggressiveness level calculation.
	 * Includes all action types (accepted, rejected, ignored).
	 */
	private _recentUserActionsForAggressiveness: { time: number; kind: 'accepted' | 'rejected' | 'ignored' }[] = [];

	/**
	 * Used for timing/debounce calculation.
	 * Only includes accepted and rejected actions (ignored actions don't affect timing).
	 */
	private _recentUserActionsForTiming: { time: number; kind: 'accepted' | 'rejected' }[] = [];

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

	public handleIgnored(): void {
		this._recordUserAction('ignored');
	}

	private _recordUserAction(kind: 'accepted' | 'rejected' | 'ignored') {
		const now = Date.now();

		// Always record for aggressiveness calculation
		this._recentUserActionsForAggressiveness.push({ time: now, kind });
		this._recentUserActionsForAggressiveness = this._recentUserActionsForAggressiveness.slice(-UserInteractionMonitor.MAX_INTERACTIONS_STORED);

		// Only record accepts/rejects for timing calculation
		if (kind !== 'ignored') {
			this._recentUserActionsForTiming.push({ time: now, kind });
			this._recentUserActionsForTiming = this._recentUserActionsForTiming.slice(-UserInteractionMonitor.MAX_INTERACTIONS_CONSIDERED);
		}
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
		// Uses timing-specific array which only contains accepts/rejects
		for (const action of this._recentUserActionsForTiming) {
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

	public getAggressivenessLevel(): AggressivenessLevel {
		const configuredAggressivenessLevel = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsXtabAggressivenessLevel, this._experimentationService);

		if (configuredAggressivenessLevel !== undefined) {
			return configuredAggressivenessLevel;
		}

		const config = this._getUserHappinessScoreConfiguration();
		const userHappinessScore = this._getUserHappinessScore(config);
		if (userHappinessScore >= config.highThreshold) {
			return AggressivenessLevel.High;
		} else if (userHappinessScore >= config.mediumThreshold) {
			return AggressivenessLevel.Medium;
		} else {
			return AggressivenessLevel.Low;
		}
	}

	private _getUserHappinessScoreConfiguration(): UserHappinessScoreConfiguration {
		const configString = this._configurationService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsUserHappinessScoreConfigurationString, this._experimentationService);
		if (configString === undefined) {
			return DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION;
		}

		try {
			const parsed = JSON.parse(configString);
			const validation = USER_HAPPINESS_SCORE_CONFIGURATION_VALIDATOR.validate(parsed);
			if (validation.error) {
				return DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION;
			}
			return validation.content;
		} catch {
			return DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION;
		}
	}

	/**
	 * Value between 0 and 1 indicating user happiness.
	 * 1 means very happy, 0 means very unhappy.
	 *
	 * Uses position-weighted scoring with ignored action limiting:
	 * - More recent actions have higher weight
	 * - Ignored actions can be limited (consecutive or total) to prevent score dilution
	 * - Score is adjusted towards neutral (0.5) based on data confidence
	 */
	private _getUserHappinessScore(config: UserHappinessScoreConfiguration): number {
		if (this._recentUserActionsForAggressiveness.length === 0) {
			return 0.5; // neutral score when no data
		}

		// Get window of actions with ignored limiting
		const window = this._getWindowWithIgnoredLimit(config);

		if (window.length === 0) {
			return 0.5; // neutral score when no data after filtering
		}

		// Calculate weighted score
		let weightedScore = 0;
		let totalWeight = 0;

		for (let i = 0; i < window.length; i++) {
			const action = window[i];

			// Skip ignored actions if not included in score calculation
			if (action.kind === 'ignored' && !config.includeIgnored) {
				continue;
			}

			// Calculate weight based on position (more recent = higher weight)
			// Position 0 (oldest) has lowest weight, last position has highest weight
			const weight = i + 1;

			// Get score based on action kind from configuration
			let score: number;
			switch (action.kind) {
				case 'accepted':
					score = config.acceptedScore;
					break;
				case 'rejected':
					score = config.rejectedScore;
					break;
				case 'ignored':
					score = config.ignoredScore;
					break;
			}

			// Normalize score to 0-1 range based on accept/reject weights
			const normalized = (score - config.rejectedScore) / (config.acceptedScore - config.rejectedScore);

			weightedScore += normalized * weight;
			totalWeight += weight;
		}

		const rawScore = totalWeight > 0 ? weightedScore / totalWeight : 0.5;

		// Adjust score towards neutral (0.5) when we have fewer data points
		// This prevents extreme scores with limited data
		const dataConfidence = window.length / UserInteractionMonitor.MAX_INTERACTIONS_CONSIDERED;
		return 0.5 + (rawScore - 0.5) * dataConfidence;
	}

	/**
	 * Get window of actions with ignored action limiting via window expansion.
	 *
	 * When ignored limit is reached, skip excess ignored actions but expand window
	 * further back to still get MAX_INTERACTIONS_CONSIDERED items.
	 */
	private _getWindowWithIgnoredLimit(config: UserHappinessScoreConfiguration): { time: number; kind: 'accepted' | 'rejected' | 'ignored' }[] {
		const { limitConsecutiveIgnored, limitTotalIgnored, ignoredLimit } = config;

		if (!limitConsecutiveIgnored && !limitTotalIgnored) {
			// No limiting - just take last MAX_INTERACTIONS_CONSIDERED
			return this._recentUserActionsForAggressiveness.slice(-UserInteractionMonitor.MAX_INTERACTIONS_CONSIDERED);
		}

		const result: { time: number; kind: 'accepted' | 'rejected' | 'ignored' }[] = [];
		let consecutiveIgnored = 0;
		let totalIgnored = 0;

		// Walk backwards through history
		for (let i = this._recentUserActionsForAggressiveness.length - 1; i >= 0 && result.length < UserInteractionMonitor.MAX_INTERACTIONS_CONSIDERED; i--) {
			const action = this._recentUserActionsForAggressiveness[i];

			if (action.kind === 'ignored') {
				let skip = false;
				if (limitConsecutiveIgnored && consecutiveIgnored >= ignoredLimit) {
					skip = true;
				}
				if (limitTotalIgnored && totalIgnored >= ignoredLimit) {
					skip = true;
				}

				if (skip) {
					continue;
				}

				consecutiveIgnored++;
				totalIgnored++;
			} else {
				consecutiveIgnored = 0; // Reset consecutive count on accept/reject
			}

			result.push(action);
		}

		// Reverse to get chronological order
		result.reverse();
		return result;
	}
}