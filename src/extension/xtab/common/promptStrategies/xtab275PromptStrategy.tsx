/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getUserPrompt } from '../promptCrafting';
import { PromptStrategyBase } from './promptStrategyBase';

/**
 * Xtab275 prompt strategy
 */
export class Xtab275PromptStrategy extends PromptStrategyBase {
	protected getSystemPrompt(): string {
		return `Predict the next code edit based on user context, following Microsoft content policies and avoiding copyright violations. If a request may breach guidelines, reply: "Sorry, I can't assist with that."`;
	}

	protected shouldIncludeBackticks(): boolean {
		return true;
	}

	protected getPostScript(currentFilePath: string): string {
		return `\n\nThe developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`<|cursor|>\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Provide the revised code that was between the \`<|code_to_edit|>\` and \`<|/code_to_edit|>\` tags, but do not include the tags themselves. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors. Don't include the line numbers or the form #| in your response. Do not skip any lines. Do not be lazy.`;
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