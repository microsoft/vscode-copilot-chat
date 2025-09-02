/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CURSOR_TAG, getUserPrompt } from '../promptCrafting';
import { PromptStrategyBase } from './promptStrategyBase';

/**
 * Simplified system prompt strategy
 */
export class SimplifiedPromptStrategy extends PromptStrategyBase {
	protected getSystemPrompt(): string {
		return 'Predict next code edit based on the context given by the user.';
	}

	protected shouldIncludeBackticks(): boolean {
		return true;
	}

	protected getPostScript(currentFilePath: string): string {
		return `\n\nThe developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${currentFilePath}\`. \
Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor \
position marked as \`${CURSOR_TAG}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes \
they would have made next. Provide the revised code that was between the \`<|code_to_edit|>\` and \`<|/code_to_edit|>\` tags with the following format, but do not include the tags themselves.
\`\`\`
// Your revised code goes here
\`\`\``;
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