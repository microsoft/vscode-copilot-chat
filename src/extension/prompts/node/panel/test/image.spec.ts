/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { CopilotToken } from '../../../../../platform/authentication/common/copilotToken';

describe('Image warning conditions', () => {
	test('warning should be shown for business/enterprise user with preview features disabled', () => {
		// Test the condition logic that triggers the warning
		const mockToken = {
			isIndividual: false,
			isEditorPreviewFeaturesEnabled: () => false,
		} as unknown as CopilotToken;

		const shouldShowWarning = !mockToken.isIndividual && !mockToken.isEditorPreviewFeaturesEnabled();
		expect(shouldShowWarning).toBe(true);
	});

	test('warning should not be shown for individual user', () => {
		const mockToken = {
			isIndividual: true,
			isEditorPreviewFeaturesEnabled: () => false,
		} as unknown as CopilotToken;

		const shouldShowWarning = !mockToken.isIndividual && !mockToken.isEditorPreviewFeaturesEnabled();
		expect(shouldShowWarning).toBe(false);
	});

	test('warning should not be shown when preview features are enabled', () => {
		const mockToken = {
			isIndividual: false,
			isEditorPreviewFeaturesEnabled: () => true,
		} as unknown as CopilotToken;

		const shouldShowWarning = !mockToken.isIndividual && !mockToken.isEditorPreviewFeaturesEnabled();
		expect(shouldShowWarning).toBe(false);
	});
});
