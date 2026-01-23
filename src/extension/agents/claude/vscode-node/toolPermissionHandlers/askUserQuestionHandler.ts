/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import * as vscode from 'vscode';
import {
	ClaudeToolPermissionContext,
	ClaudeToolPermissionResult,
	IClaudeToolPermissionHandler
} from '../../common/claudeToolPermission';
import { registerToolPermissionHandler } from '../../common/claudeToolPermissionRegistry';
import { ClaudeToolNames } from '../../common/claudeTools';

/**
 * Handler for the AskUserQuestion tool.
 * Uses VS Code's QuickPick to ask the user questions.
 */
export class AskUserQuestionHandler implements IClaudeToolPermissionHandler<ClaudeToolNames.AskUserQuestion> {
	public readonly toolNames = [ClaudeToolNames.AskUserQuestion] as const;

	public async handle(
		_toolName: ClaudeToolNames.AskUserQuestion,
		input: AskUserQuestionInput,
		_context: ClaudeToolPermissionContext
	): Promise<ClaudeToolPermissionResult> {
		const answers: Record<string, string> = {};

		// Process each question
		for (const questionItem of input.questions) {
			const options = questionItem.options;

			// Create QuickPick items from options
			const quickPickItems: vscode.QuickPickItem[] = options.map(opt => ({
				label: opt.label,
				description: opt.description
			}));

			// Add "Other" option for free-form input
			const other = {
				label: '$(edit) ' + vscode.l10n.t('Other...'),
				description: vscode.l10n.t('Enter a custom response')
			};
			quickPickItems.push(other);

			let selectedOption: string;

			if (questionItem.multiSelect) {
				// Multi-select mode
				const selected = await vscode.window.showQuickPick(quickPickItems, {
					placeHolder: questionItem.question,
					title: questionItem.header,
					ignoreFocusOut: true,
					canPickMany: true
				});

				if (selected === undefined || selected.length === 0) {
					return {
						behavior: 'deny',
						message: 'The user cancelled the question'
					};
				}

				// Check if "Other" was selected
				if (selected.includes(other)) {
					const customAnswer = await vscode.window.showInputBox({
						prompt: questionItem.question,
						title: questionItem.header,
						ignoreFocusOut: true
					});

					if (customAnswer === undefined) {
						return {
							behavior: 'deny',
							message: 'The user cancelled the question'
						};
					}

					// Combine regular selections with custom answer
					const regularSelections = selected.filter(s => s !== other).map(s => s.label);
					selectedOption = [...regularSelections, customAnswer].join(', ');
				} else {
					selectedOption = selected.map(s => s.label).join(', ');
				}
			} else {
				// Single-select mode
				const selected = await vscode.window.showQuickPick(quickPickItems, {
					placeHolder: questionItem.question,
					title: questionItem.header,
					ignoreFocusOut: true
				});

				if (selected === undefined) {
					return {
						behavior: 'deny',
						message: 'The user cancelled the question'
					};
				}

				if (selected === other) {
					// Free-form input
					const customAnswer = await vscode.window.showInputBox({
						prompt: questionItem.question,
						title: questionItem.header,
						ignoreFocusOut: true
					});

					if (customAnswer === undefined) {
						return {
							behavior: 'deny',
							message: 'The user cancelled the question'
						};
					}
					selectedOption = customAnswer;
				} else {
					selectedOption = selected.label;
				}
			}

			answers[questionItem.question] = selectedOption;
		}

		return {
			behavior: 'allow',
			updatedInput: {
				...input,
				answers
			}
		};
	}
}

// Self-register the handler
registerToolPermissionHandler(
	[ClaudeToolNames.AskUserQuestion],
	AskUserQuestionHandler
);
