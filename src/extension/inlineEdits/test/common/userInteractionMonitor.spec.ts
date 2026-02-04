/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, test } from 'vitest';
import { ConfigKey } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { AggressivenessLevel, DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION, UserHappinessScoreConfiguration } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { ILogger, ILogService } from '../../../../platform/log/common/logService';
import { IExperimentationService, NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { MAX_INTERACTIONS_CONSIDERED, MAX_INTERACTIONS_STORED, UserInteractionMonitor } from '../../common/userInteractionMonitor';

/**
 * Null log service for testing.
 */
class NullLogService implements ILogService {
	declare _serviceBrand: undefined;
	trace(_message: string): void { }
	debug(_message: string): void { }
	info(_message: string): void { }
	warn(_message: string): void { }
	error(_error: string | Error, _message?: string): void { }
	show(_preserveFocus?: boolean): void { }
	createSubLogger(_topic: string | readonly string[]): ILogger {
		return this;
	}
	withExtraTarget(_target: unknown): ILogger {
		return this;
	}
}

/**
 * Test-friendly subclass of UserInteractionMonitor that exposes internal state for verification.
 */
class TestUserInteractionMonitor extends UserInteractionMonitor {
	/**
	 * Get a copy of the recent user actions for aggressiveness calculation.
	 */
	getActionsForAggressiveness(): { time: number; kind: ActionKind }[] {
		// Access private field through type assertion
		return [...this._recentUserActionsForAggressiveness];
	}

	/**
	 * Get a copy of the recent user actions for timing calculation.
	 */
	getActionsForTiming(): { time: number; kind: ActionKind.Accepted | ActionKind.Rejected }[] {
		return [...this._recentUserActionsForTiming];
	}
}

/**
 * Mock configuration service that allows setting specific config values for testing.
 */
class MockConfigurationService extends InMemoryConfigurationService {
	constructor() {
		super(new DefaultsOnlyConfigurationService());
	}
}

describe('UserInteractionMonitor', () => {
	let configurationService: MockConfigurationService;
	let experimentationService: IExperimentationService;
	let logService: ILogService;
	let monitor: TestUserInteractionMonitor;

	beforeEach(() => {
		configurationService = new MockConfigurationService();
		experimentationService = new NullExperimentationService();
		logService = new NullLogService();
		monitor = new TestUserInteractionMonitor(configurationService, experimentationService, logService);
	});

	describe('history logging', () => {
		test('handleAcceptance logs accepted action to both histories', () => {
			monitor.handleAcceptance();

			const aggressivenessActions = monitor.getActionsForAggressiveness();
			const timingActions = monitor.getActionsForTiming();

			expect(aggressivenessActions).toHaveLength(1);
			expect(aggressivenessActions[0].kind).toBe('accepted');

			expect(timingActions).toHaveLength(1);
			expect(timingActions[0].kind).toBe('accepted');
		});

		test('handleRejection logs rejected action to both histories', () => {
			monitor.handleRejection();

			const aggressivenessActions = monitor.getActionsForAggressiveness();
			const timingActions = monitor.getActionsForTiming();

			expect(aggressivenessActions).toHaveLength(1);
			expect(aggressivenessActions[0].kind).toBe('rejected');

			expect(timingActions).toHaveLength(1);
			expect(timingActions[0].kind).toBe('rejected');
		});

		test('handleIgnored logs only to aggressiveness history, not timing', () => {
			monitor.handleIgnored();

			const aggressivenessActions = monitor.getActionsForAggressiveness();
			const timingActions = monitor.getActionsForTiming();

			expect(aggressivenessActions).toHaveLength(1);
			expect(aggressivenessActions[0].kind).toBe('ignored');

			// Ignored actions should NOT be recorded for timing
			expect(timingActions).toHaveLength(0);
		});

		test('actions are recorded with timestamps', () => {
			const beforeTime = Date.now();
			monitor.handleAcceptance();
			const afterTime = Date.now();

			const actions = monitor.getActionsForAggressiveness();
			expect(actions[0].time).toBeGreaterThanOrEqual(beforeTime);
			expect(actions[0].time).toBeLessThanOrEqual(afterTime);
		});

		test('multiple actions are recorded in order', () => {
			monitor.handleAcceptance();
			monitor.handleRejection();
			monitor.handleIgnored();
			monitor.handleAcceptance();

			const aggressivenessActions = monitor.getActionsForAggressiveness();
			expect(aggressivenessActions).toHaveLength(4);
			expect(aggressivenessActions[0].kind).toBe('accepted');
			expect(aggressivenessActions[1].kind).toBe('rejected');
			expect(aggressivenessActions[2].kind).toBe('ignored');
			expect(aggressivenessActions[3].kind).toBe('accepted');

			// Timing history should only have accepts and rejects
			const timingActions = monitor.getActionsForTiming();
			expect(timingActions).toHaveLength(3);
			expect(timingActions[0].kind).toBe('accepted');
			expect(timingActions[1].kind).toBe('rejected');
			expect(timingActions[2].kind).toBe('accepted');
		});

		test('aggressiveness history is limited to MAX_INTERACTIONS_STORED', () => {
			// Record more than max actions
			for (let i = 0; i < MAX_INTERACTIONS_STORED + 5; i++) {
				monitor.handleAcceptance();
			}

			const actions = monitor.getActionsForAggressiveness();
			expect(actions).toHaveLength(MAX_INTERACTIONS_STORED);
		});

		test('timing history is limited to MAX_INTERACTIONS_CONSIDERED', () => {
			// Record more than max actions
			for (let i = 0; i < MAX_INTERACTIONS_CONSIDERED + 5; i++) {
				monitor.handleAcceptance();
			}

			const actions = monitor.getActionsForTiming();
			expect(actions).toHaveLength(MAX_INTERACTIONS_CONSIDERED);
		});

		test('timing history does not include "ignored" events', () => {
			// The timing history only contains accepts/rejects
			// The aggressiveness history contains all actions
			// They should be independent

			monitor.handleIgnored();
			monitor.handleIgnored();
			monitor.handleIgnored();

			// Timing history should be empty
			expect(monitor.getActionsForTiming()).toHaveLength(0);

			// Aggressiveness history should have 3 ignored
			expect(monitor.getActionsForAggressiveness()).toHaveLength(3);
		});
	});

	describe('aggressiveness level calculation', () => {
		test('returns neutral aggressiveness with no history', () => {
			// With no data, score is 0.5, which is between low and medium thresholds
			// Default: highThreshold = 0.6, mediumThreshold = 0.4
			const level = monitor.getAggressivenessLevel().aggressivenessLevel;
			expect(level).toBe(AggressivenessLevel.Medium);
		});

		test('returns high aggressiveness after many acceptances', () => {
			// Fill with 10 acceptances
			for (let i = 0; i < 10; i++) {
				monitor.handleAcceptance();
			}

			const level = monitor.getAggressivenessLevel().aggressivenessLevel;
			expect(level).toBe(AggressivenessLevel.High);
		});

		test('returns low aggressiveness after many rejections', () => {
			// Fill with 10 rejections
			for (let i = 0; i < 10; i++) {
				monitor.handleRejection();
			}

			const level = monitor.getAggressivenessLevel().aggressivenessLevel;
			expect(level).toBe(AggressivenessLevel.Low);
		});

		test('respects configured aggressiveness level override', () => {
			configurationService.setConfig(
				ConfigKey.TeamInternal.InlineEditsXtabAggressivenessLevel,
				AggressivenessLevel.Low
			);

			// Even with many acceptances, should return configured level
			for (let i = 0; i < 10; i++) {
				monitor.handleAcceptance();
			}

			const level = monitor.getAggressivenessLevel().aggressivenessLevel;
			expect(level).toBe(AggressivenessLevel.Low);
		});

		test('recent actions have more weight than older ones', () => {
			// Start with acceptances, end with rejections
			for (let i = 0; i < 5; i++) {
				monitor.handleAcceptance();
			}
			for (let i = 0; i < 5; i++) {
				monitor.handleRejection();
			}

			const levelRejectionsRecent = monitor.getAggressivenessLevel().aggressivenessLevel;

			// Reset and do opposite order
			monitor = new TestUserInteractionMonitor(configurationService, experimentationService, logService);
			for (let i = 0; i < 5; i++) {
				monitor.handleRejection();
			}
			for (let i = 0; i < 5; i++) {
				monitor.handleAcceptance();
			}

			const levelAcceptancesRecent = monitor.getAggressivenessLevel().aggressivenessLevel;

			// When acceptances are more recent, aggressiveness should be higher
			const aggressivenessOrder = [AggressivenessLevel.Low, AggressivenessLevel.Medium, AggressivenessLevel.High];
			expect(aggressivenessOrder.indexOf(levelAcceptancesRecent)).toBeGreaterThanOrEqual(
				aggressivenessOrder.indexOf(levelRejectionsRecent)
			);
		});
	});

	describe('ignored action limiting', () => {
		test('ignored actions are included in aggressiveness calculation', () => {
			// With custom config that includes ignored actions
			const customConfig: UserHappinessScoreConfiguration = {
				...DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION,
				includeIgnored: true,
				limitTotalIgnored: false,
				limitConsecutiveIgnored: false,
			};
			configurationService.setConfig(
				ConfigKey.TeamInternal.InlineEditsUserHappinessScoreConfigurationString,
				JSON.stringify(customConfig)
			);

			// Mix of actions
			monitor.handleAcceptance();
			monitor.handleIgnored();
			monitor.handleIgnored();
			monitor.handleRejection();

			const level = monitor.getAggressivenessLevel().aggressivenessLevel;
			// With ignored having score 0.5, result should be medium
			expect(level).toBe(AggressivenessLevel.Medium);
		});

		test('total ignored limit is respected', () => {
			const customConfig: UserHappinessScoreConfiguration = {
				...DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION,
				includeIgnored: true,
				limitTotalIgnored: true,
				limitConsecutiveIgnored: false,
				ignoredLimit: 2,
			};
			configurationService.setConfig(
				ConfigKey.TeamInternal.InlineEditsUserHappinessScoreConfigurationString,
				JSON.stringify(customConfig)
			);

			// Add many ignored actions scattered between accepts
			monitor.handleIgnored();
			monitor.handleAcceptance();
			monitor.handleIgnored();
			monitor.handleAcceptance();
			monitor.handleIgnored();
			monitor.handleIgnored();
			monitor.handleIgnored();

			// Only 2 ignored should be counted due to limit
			const level = monitor.getAggressivenessLevel().aggressivenessLevel;
			expect([AggressivenessLevel.Medium, AggressivenessLevel.High]).toContain(level);
		});
	});
});
