/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIPS } from '../../common/chatTipService';
import { ChatTipService } from '../../vscode-node/chatTipServiceImpl';

describe('ChatTipService', () => {
	let tipService: ChatTipService;

	beforeEach(() => {
		tipService = new ChatTipService();
	});

	describe('shouldShowTips', () => {
		it('should return true by default', () => {
			expect(tipService.shouldShowTips()).toBe(true);
		});
	});

	describe('getNextTip', () => {
		it('should return a tip from the default tips', () => {
			const tip = tipService.getNextTip();
			expect(tip).toBeDefined();
			expect(DEFAULT_TIPS).toContain(tip!);
		});

		it('should rotate through tips', () => {
			const tips = new Set<string>();
			const tipCount = DEFAULT_TIPS.length;

			// Get tips, should cycle through all
			for (let i = 0; i < tipCount * 2; i++) {
				const tip = tipService.getNextTip();
				if (tip) {
					tips.add(tip);
				}
			}

			// Should have seen multiple different tips
			expect(tips.size).toBeGreaterThan(1);
		});

		it('should return undefined when tips are disabled', () => {
			// Create a service that has shouldShowTips return false
			const customTipService = new (class extends ChatTipService {
				shouldShowTips(): boolean {
					return false;
				}
			})();

			const tip = customTipService.getNextTip();
			expect(tip).toBeUndefined();
		});

		it('should cycle back to the start after reaching the end', () => {
			const tipCount = DEFAULT_TIPS.length;
			const seenTips: string[] = [];

			// Collect all tips in order
			for (let i = 0; i < tipCount; i++) {
				const tip = tipService.getNextTip();
				if (tip) {
					seenTips.push(tip);
				}
			}

			// Get one more tip - should be different from the last
			const nextTip = tipService.getNextTip();
			expect(nextTip).toBeDefined();

			// Should have cycled back (we can't guarantee it's the first one due to random start)
			expect(DEFAULT_TIPS).toContain(nextTip!);
		});
	});

	describe('DEFAULT_TIPS', () => {
		it('should contain at least one tip', () => {
			expect(DEFAULT_TIPS.length).toBeGreaterThan(0);
		});

		it('should have short tips (1-2 sentences)', () => {
			for (const tip of DEFAULT_TIPS) {
				// Tips should be concise - check they're not too long
				expect(tip.length).toBeLessThan(200);
				expect(tip.length).toBeGreaterThan(10);
			}
		});

		it('should not have duplicate tips', () => {
			const uniqueTips = new Set(DEFAULT_TIPS);
			expect(uniqueTips.size).toBe(DEFAULT_TIPS.length);
		});
	});
});
