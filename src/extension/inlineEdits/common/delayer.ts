/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';

export class DelaySession {
	private extraDebounce = 0;

	constructor(
		private baseDebounceTime: number,
		private readonly expectedTotalTime: number | undefined,
		private readonly providerInvocationTime: number = Date.now(),
	) {
	}

	public setExtraDebounce(extraDebounce: number): void {
		this.extraDebounce = extraDebounce;
	}

	getDebounceTime() {
		const expectedDebounceTime = this.expectedTotalTime === undefined
			? this.baseDebounceTime + this.extraDebounce
			: Math.min(this.baseDebounceTime + this.extraDebounce, this.expectedTotalTime);

		const timeAlreadySpent = Date.now() - this.providerInvocationTime;
		const actualDebounceTime = Math.max(0, expectedDebounceTime - timeAlreadySpent);

		return actualDebounceTime;
	}

	getArtificialDelay() {
		if (this.expectedTotalTime === undefined) {
			return 0;
		}

		const timeAlreadySpent = Date.now() - this.providerInvocationTime;
		const delay = Math.max(0, this.expectedTotalTime - timeAlreadySpent);
		return delay;
	}
}

export class Delayer {

	private _recentUserActions: { time: number; kind: 'accepted' | 'rejected' }[] = [];

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
	) {
	}

	public createDelaySession(requestTime: number | undefined): DelaySession {
		const baseDebounceTime = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsDebounce, this._experimentationService);

		const backoffDebounceEnabled = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.InlineEditsBackoffDebounceEnabled, this._experimentationService);
		const expectedTotalTime = backoffDebounceEnabled ? this._getExpectedTotalTime(baseDebounceTime) : undefined;

		return new DelaySession(baseDebounceTime, expectedTotalTime, requestTime);
	}

	public handleAcceptance(): void {
		this._recordUserAction('accepted');
	}

	public handleRejection(): void {
		this._recordUserAction('rejected');
	}

	private _recordUserAction(kind: 'accepted' | 'rejected') {
		this._recentUserActions.push({ time: Date.now(), kind });
		// keep at most 10 user actions
		this._recentUserActions = this._recentUserActions.slice(-10);
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

}
