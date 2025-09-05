/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getUserPrompt } from '../promptCrafting';
import { PromptStrategyBase } from './promptStrategyBase';

/**
 * Codexv21NesUnified prompt strategy
 */
export class Codexv21NesUnifiedPromptStrategy extends PromptStrategyBase {
	protected getSystemPrompt(): string {
		return 'Predict next code edit based on the context given by the user.';
	}

	protected shouldIncludeBackticks(): boolean {
		return false;
	}

	protected getPostScript(currentFilePath: string): string {
		return ''; // No post-script for this strategy
	}

	protected buildUserPrompt(): string {
		return getUserPrompt(
			this.props.request,
			this.props.currentFileContent,
			this.props.areaAroundCodeToEdit,
			this.props.langCtx,
			this.props.computeTokens,
			this.props.opts
		);
	}
}