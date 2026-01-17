/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';

export const IChatTipService = createServiceIdentifier<IChatTipService>('IChatTipService');

/**
 * Service that provides educational tips to display during chat responses.
 * Tips are short (1-2 sentences) messages that educate users about Copilot features.
 */
export interface IChatTipService {
	readonly _serviceBrand: undefined;

	/**
	 * Get the next tip to display.
	 * Tips are rotated so users see different tips over time.
	 */
	getNextTip(): string | undefined;

	/**
	 * Check if tips should be shown based on configuration.
	 */
	shouldShowTips(): boolean;
}

/**
 * Default tips about Copilot features.
 * These tips are educational and help users discover features they may not know about.
 */
export const DEFAULT_TIPS: readonly string[] = [
	'You can use `@workspace` to ask questions about your entire codebase.',
	'Try `/explain` to get explanations of selected code.',
	'Use `#file` to reference specific files in your chat.',
	'Press `Ctrl+I` (or `Cmd+I` on Mac) to start inline chat in the editor.',
	'You can ask Copilot to generate commit messages for your changes.',
	'Use `/tests` to generate unit tests for your code.',
	'Reference symbols with `#` to include specific functions or classes in context.',
	'Use `/fix` to get suggestions for fixing errors and warnings.',
	'You can ask follow-up questions to refine Copilot\'s responses.',
	'Try asking Copilot to refactor code for better readability or performance.',
] as const;
