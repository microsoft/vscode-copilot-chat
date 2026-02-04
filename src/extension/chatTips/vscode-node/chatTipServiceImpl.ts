/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DEFAULT_TIPS, IChatTipService } from '../common/chatTipService';

/**
 * Implementation of the chat tip service that rotates through tips.
 */
export class ChatTipService implements IChatTipService {
	declare readonly _serviceBrand: undefined;

	private _currentTipIndex = 0;
	private readonly _tips: readonly string[];

	constructor() {
		// Use default tips - in the future this could be extended to load custom tips
		this._tips = DEFAULT_TIPS;

		// Start at a random index to provide variety
		this._currentTipIndex = Math.floor(Math.random() * this._tips.length);
	}

	getNextTip(): string | undefined {
		if (!this.shouldShowTips() || this._tips.length === 0) {
			return undefined;
		}

		const tip = this._tips[this._currentTipIndex];
		
		// Move to next tip for next call
		this._currentTipIndex = (this._currentTipIndex + 1) % this._tips.length;

		return tip;
	}

	shouldShowTips(): boolean {
		// Tips are enabled by default, but can be disabled via configuration
		// For now, always show tips. Configuration can be added later if needed.
		return true;
	}
}
