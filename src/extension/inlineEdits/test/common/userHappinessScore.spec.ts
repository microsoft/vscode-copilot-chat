/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION, UserHappinessScoreConfiguration } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';

type ActionKind = 'accepted' | 'rejected' | 'ignored';

/**
 * Original algorithm from main branch (only accepted/rejected).
 * Used as reference to verify the new configurable algorithm can mimic the original behavior.
 */
function originalGetUserHappinessScore(actions: { kind: 'accepted' | 'rejected' }[]): number {
	const MAX_INTERACTIONS_CONSIDERED = 10;

	if (actions.length === 0) {
		return 0.5; // neutral score when no data
	}

	let weightedScore = 0;
	let totalWeight = 0;

	for (let i = 0; i < actions.length; i++) {
		const action = actions[i];
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
	const dataConfidence = actions.length / MAX_INTERACTIONS_CONSIDERED;
	return 0.5 + (rawScore - 0.5) * dataConfidence;
}

/**
 * Configuration that mimics the original algorithm behavior.
 */
const CONFIG_MIMICS_ORIGINAL: UserHappinessScoreConfiguration = {
	acceptedScore: 1,
	rejectedScore: 0,
	ignoredScore: 0.5,
	highThreshold: 0.7,
	mediumThreshold: 0.4,
	includeIgnored: false,
	ignoredLimit: 0,
	limitConsecutiveIgnored: false,
	limitTotalIgnored: true,
};

/**
 * Implementation of the windowing logic with ignored limiting.
 * This mirrors the _getWindowWithIgnoredLimit method in UserInteractionMonitor.
 */
function getWindowWithIgnoredLimit(
	actions: { kind: ActionKind }[],
	config: UserHappinessScoreConfiguration
): { kind: ActionKind }[] {
	const MAX_INTERACTIONS_CONSIDERED = 10;
	const { limitConsecutiveIgnored, limitTotalIgnored, ignoredLimit } = config;

	if (!limitConsecutiveIgnored && !limitTotalIgnored) {
		// No limiting - just take last MAX_INTERACTIONS_CONSIDERED
		return actions.slice(-MAX_INTERACTIONS_CONSIDERED);
	}

	const result: { kind: ActionKind }[] = [];
	let consecutiveIgnored = 0;
	let totalIgnored = 0;

	// Walk backwards through history
	for (let i = actions.length - 1; i >= 0 && result.length < MAX_INTERACTIONS_CONSIDERED; i--) {
		const action = actions[i];

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

/**
 * New configurable happiness score algorithm.
 * This mirrors the _getUserHappinessScore method in UserInteractionMonitor.
 */
function newGetUserHappinessScore(
	actions: { kind: ActionKind }[],
	config: UserHappinessScoreConfiguration
): number {
	const MAX_INTERACTIONS_CONSIDERED = 10;

	if (actions.length === 0) {
		return 0.5; // neutral score when no data
	}

	// Get window of actions with ignored limiting
	const window = getWindowWithIgnoredLimit(actions, config);

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
	const dataConfidence = window.length / MAX_INTERACTIONS_CONSIDERED;
	return 0.5 + (rawScore - 0.5) * dataConfidence;
}

describe('UserHappinessScore', () => {
	describe('new algorithm mimics original', () => {
		const testCases: { name: string; actions: ActionKind[] }[] = [
			{ name: 'empty actions', actions: [] },
			{ name: 'single accept', actions: ['accepted'] },
			{ name: 'single reject', actions: ['rejected'] },
			{ name: 'all accepts', actions: ['accepted', 'accepted', 'accepted', 'accepted', 'accepted'] },
			{ name: 'all rejects', actions: ['rejected', 'rejected', 'rejected', 'rejected', 'rejected'] },
			{ name: 'mixed 50/50', actions: ['accepted', 'rejected', 'accepted', 'rejected', 'accepted', 'rejected'] },
			{ name: 'accepts then rejects', actions: ['accepted', 'accepted', 'accepted', 'rejected', 'rejected', 'rejected'] },
			{ name: 'rejects then accepts', actions: ['rejected', 'rejected', 'rejected', 'accepted', 'accepted', 'accepted'] },
			{ name: 'full 10 mixed', actions: ['accepted', 'rejected', 'accepted', 'accepted', 'rejected', 'accepted', 'rejected', 'accepted', 'rejected', 'accepted'] },
			// Cases with ignored (should be filtered out when mimicking original)
			{ name: 'accepts with ignored', actions: ['accepted', 'ignored', 'accepted', 'ignored', 'accepted'] },
			{ name: 'rejects with ignored', actions: ['rejected', 'ignored', 'rejected', 'ignored', 'rejected'] },
			{ name: 'mixed with many ignored', actions: ['accepted', 'ignored', 'ignored', 'ignored', 'rejected', 'ignored', 'accepted'] },
			{ name: 'all ignored', actions: ['ignored', 'ignored', 'ignored', 'ignored', 'ignored'] },
			{ name: 'accept surrounded by ignored', actions: ['ignored', 'ignored', 'accepted', 'ignored', 'ignored'] },
		];

		for (const testCase of testCases) {
			test(testCase.name, () => {
				// For original, filter out ignored actions (original didn't have them)
				const originalActions = testCase.actions
					.filter((a): a is 'accepted' | 'rejected' => a !== 'ignored')
					.map(kind => ({ kind }));

				const newActions = testCase.actions.map(kind => ({ kind }));

				const originalScore = originalGetUserHappinessScore(originalActions);
				const newScore = newGetUserHappinessScore(newActions, CONFIG_MIMICS_ORIGINAL);

				expect(newScore).toBeCloseTo(originalScore, 6);
			});
		}
	});

	describe('v2 algorithm with ignored actions', () => {
		test('ignored actions count towards score when includeIgnored is true', () => {
			const config: UserHappinessScoreConfiguration = {
				...DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION,
				includeIgnored: true,
			};

			const actions = [
				{ kind: 'accepted' as const },
				{ kind: 'ignored' as const },
				{ kind: 'rejected' as const },
			];

			const score = newGetUserHappinessScore(actions, config);
			// With ignored having score 0.5, it should pull the average towards middle
			expect(score).toBeGreaterThan(0.4);
			expect(score).toBeLessThan(0.6);
		});

		test('consecutive ignored limiting works correctly', () => {
			const config: UserHappinessScoreConfiguration = {
				...DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION,
				limitConsecutiveIgnored: true,
				limitTotalIgnored: false,
				ignoredLimit: 2,
				includeIgnored: true,
			};

			// Many consecutive ignored followed by accept
			const actions: { kind: ActionKind }[] = [
				{ kind: 'ignored' },
				{ kind: 'ignored' },
				{ kind: 'ignored' },
				{ kind: 'ignored' },
				{ kind: 'ignored' },
				{ kind: 'accepted' },
			];

			const window = getWindowWithIgnoredLimit(actions, config);
			// Should only include 2 consecutive ignored before the accept
			expect(window.length).toBe(3); // 2 ignored + 1 accepted
		});

		test('total ignored limiting works correctly', () => {
			const config: UserHappinessScoreConfiguration = {
				...DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION,
				limitConsecutiveIgnored: false,
				limitTotalIgnored: true,
				ignoredLimit: 2,
				includeIgnored: true,
			};

			// Scattered ignored actions
			const actions: { kind: ActionKind }[] = [
				{ kind: 'ignored' },
				{ kind: 'accepted' },
				{ kind: 'ignored' },
				{ kind: 'rejected' },
				{ kind: 'ignored' },
				{ kind: 'accepted' },
			];

			const window = getWindowWithIgnoredLimit(actions, config);
			// Should only include 2 total ignored
			const ignoredCount = window.filter(a => a.kind === 'ignored').length;
			expect(ignoredCount).toBe(2);
		});

		test('different score weights affect result', () => {
			// Test that including ignored with a specific score affects the result
			const actions = [
				{ kind: 'accepted' as const },
				{ kind: 'ignored' as const },
				{ kind: 'rejected' as const },
			];

			// Config where ignored is included but scores as neutral (0.5)
			const configWithIgnoredNeutral: UserHappinessScoreConfiguration = {
				...DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION,
				includeIgnored: true,
				ignoredScore: 0.5, // Neutral
			};

			// Config where ignored is included but scores as positive (0.8)
			const configWithIgnoredPositive: UserHappinessScoreConfiguration = {
				...DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION,
				includeIgnored: true,
				ignoredScore: 0.8, // Higher than neutral
			};

			const neutralScore = newGetUserHappinessScore(actions, configWithIgnoredNeutral);
			const positiveScore = newGetUserHappinessScore(actions, configWithIgnoredPositive);

			// With higher ignored score, overall score should be higher
			expect(positiveScore).toBeGreaterThan(neutralScore);
		});
	});

	describe('edge cases', () => {
		test('empty actions returns neutral score', () => {
			const score = newGetUserHappinessScore([], DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION);
			expect(score).toBe(0.5);
		});

		test('all ignored with no limiting returns neutral', () => {
			const config: UserHappinessScoreConfiguration = {
				...DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION,
				limitTotalIgnored: true,
				ignoredLimit: 0,
				includeIgnored: false,
			};

			const actions = [
				{ kind: 'ignored' as const },
				{ kind: 'ignored' as const },
				{ kind: 'ignored' as const },
			];

			const score = newGetUserHappinessScore(actions, config);
			expect(score).toBe(0.5);
		});

		test('score adjusts towards neutral with fewer data points', () => {
			const config = DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION;

			// Single accept should give score above 0.5 but not too high
			const singleAccept = newGetUserHappinessScore([{ kind: 'accepted' }], config);
			expect(singleAccept).toBeGreaterThan(0.5);
			expect(singleAccept).toBeLessThan(0.6); // Pulled towards neutral due to low confidence

			// 10 accepts should give score closer to 1
			const manyAccepts = newGetUserHappinessScore(
				Array(10).fill(null).map(() => ({ kind: 'accepted' as const })),
				config
			);
			expect(manyAccepts).toBeGreaterThan(0.9);
		});

		test('more recent actions have higher weight', () => {
			const config = DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION;

			// Accepts followed by rejects (recent rejects should lower score)
			const acceptsThenRejects = newGetUserHappinessScore(
				[{ kind: 'accepted' }, { kind: 'accepted' }, { kind: 'rejected' }, { kind: 'rejected' }],
				config
			);

			// Rejects followed by accepts (recent accepts should raise score)
			const rejectsThenAccepts = newGetUserHappinessScore(
				[{ kind: 'rejected' }, { kind: 'rejected' }, { kind: 'accepted' }, { kind: 'accepted' }],
				config
			);

			// Recent accepts should give higher score than recent rejects
			expect(rejectsThenAccepts).toBeGreaterThan(acceptsThenRejects);
		});
	});
});
