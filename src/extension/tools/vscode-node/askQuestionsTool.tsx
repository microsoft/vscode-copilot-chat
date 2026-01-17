/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

interface IQuestionOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

interface IQuestion {
	header: string;
	question: string;
	multiSelect?: boolean;
	options: IQuestionOption[];
}

interface IAskQuestionsParams {
	questions: IQuestion[];
}

interface IAnswerResult {
	answers: Record<string, { selected: string[]; freeText: string | null; skipped: boolean }>;
}

interface IQuickPickOptionItem extends vscode.QuickPickItem {
	isRecommended?: boolean;
	isFreeText?: boolean;
	originalLabel: string;
}

export class AskQuestionsTool implements ICopilotTool<IAskQuestionsParams> {
	public static readonly toolName = ToolName.AskQuestions;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAskQuestionsParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const { questions } = options.input;
		const result: IAnswerResult = { answers: {} };
		let currentStep = 0;

		while (currentStep < questions.length) {
			if (token.isCancellationRequested) {
				// Mark remaining questions as skipped
				for (let i = currentStep; i < questions.length; i++) {
					const q = questions[i];
					result.answers[q.header] = {
						selected: [],
						freeText: null,
						skipped: true
					};
				}
				break;
			}

			const question = questions[currentStep];
			const answer = await this.askQuestion(question, currentStep, questions.length, token);

			if (answer === 'back' && currentStep > 0) {
				currentStep--;
				continue;
			}

			if (answer === 'skipped') {
				// User pressed ESC - mark current and remaining questions as skipped
				for (let i = currentStep; i < questions.length; i++) {
					const q = questions[i];
					result.answers[q.header] = {
						selected: [],
						freeText: null,
						skipped: true
					};
				}
				break;
			}

			// At this point, answer is always a valid response object
			// (back case handled above with continue, skipped case handled with break)
			if (answer !== 'back') {
				result.answers[question.header] = answer;
			}

			currentStep++;
		}

		return new LanguageModelToolResult([
			new LanguageModelTextPart(JSON.stringify(result))
		]);
	}

	private getDefaultOption(question: IQuestion): IQuestionOption {
		const recommended = question.options.find(opt => opt.recommended);
		return recommended ?? question.options[0];
	}

	private async askQuestion(
		question: IQuestion,
		step: number,
		totalSteps: number,
		token: CancellationToken
	): Promise<{ selected: string[]; freeText: string | null; skipped: boolean } | 'back' | 'skipped'> {
		// Check cancellation before showing UI to avoid creating unnecessary QuickPick
		if (token.isCancellationRequested) {
			return 'skipped';
		}

		return new Promise((resolve) => {
			// Track resolution state to prevent race conditions (e.g., onDidHide firing after onDidAccept)
			let resolved = false;
			const safeResolve = (value: { selected: string[]; freeText: string | null; skipped: boolean } | 'back' | 'skipped') => {
				if (!resolved) {
					resolved = true;
					resolve(value);
				}
			};

			const quickPick = vscode.window.createQuickPick<IQuickPickOptionItem>();
			quickPick.title = question.header;
			quickPick.placeholder = question.question;
			quickPick.step = step + 1;
			quickPick.totalSteps = totalSteps;
			quickPick.canSelectMany = question.multiSelect ?? false;
			quickPick.ignoreFocusOut = true;

			// Build items
			const items: IQuickPickOptionItem[] = question.options.map(opt => ({
				label: opt.recommended ? `$(star-full) ${opt.label}` : opt.label,
				description: opt.description,
				isRecommended: opt.recommended,
				isFreeText: false,
				originalLabel: opt.label
			}));

			// Always add free text option
			items.push({
				label: l10n.t('Other...'),
				description: l10n.t('Enter custom answer'),
				isFreeText: true,
				originalLabel: 'Other'
			});

			quickPick.items = items;

			// Set default selection
			const defaultOption = this.getDefaultOption(question);
			const defaultItem = items.find(item =>
				item.originalLabel === defaultOption.label || item.isRecommended
			);

			if (defaultItem) {
				if (question.multiSelect) {
					quickPick.selectedItems = [defaultItem];
				} else {
					quickPick.activeItems = [defaultItem];
				}
			}

			// Add back button for multi-step flows
			if (step > 0) {
				quickPick.buttons = [vscode.QuickInputButtons.Back];
			}

			const store = new DisposableStore();
			store.add(quickPick);

			store.add(
				token.onCancellationRequested(() => {
					quickPick.hide();
				})
			);

			store.add(
				quickPick.onDidTriggerButton(button => {
					if (button === vscode.QuickInputButtons.Back) {
						quickPick.hide();
						safeResolve('back');
					}
				})
			);

			store.add(
				quickPick.onDidAccept(async () => {
					const selectedItems = question.multiSelect
						? quickPick.selectedItems
						: quickPick.activeItems;

					if (selectedItems.length === 0) {
						// No selection, use default
						quickPick.hide();
						safeResolve({
							selected: [defaultOption.label],
							freeText: null,
							skipped: false
						});
						return;
					}

					// Check if free text option was selected
					const freeTextItem = selectedItems.find(item => item.isFreeText);
					if (freeTextItem) {
						// Mark as resolved before hiding to prevent onDidHide from resolving with default
						resolved = true;
						quickPick.hide();

						const freeTextInput = await vscode.window.showInputBox({
							prompt: question.question,
							placeHolder: l10n.t('Enter your answer'),
							ignoreFocusOut: true
						}, token);

						// Filter out the free text item and include remaining selections
						const otherSelections = selectedItems
							.filter(item => !item.isFreeText)
							.map(item => item.originalLabel);

						if (freeTextInput === undefined) {
							// User cancelled input box: preserve other selections if any, otherwise treat as skipped
							if (otherSelections.length > 0) {
								resolve({
									selected: otherSelections,
									freeText: null,
									skipped: false
								});
							} else {
								resolve('skipped');
							}
						} else {
							resolve({
								selected: otherSelections.length > 0 ? otherSelections : [freeTextItem.originalLabel],
								freeText: freeTextInput,
								skipped: false
							});
						}
						return;
					}

					// Regular selection
					quickPick.hide();
					safeResolve({
						selected: selectedItems.map(item => item.originalLabel),
						freeText: null,
						skipped: false
					});
				})
			);

			store.add(
				quickPick.onDidHide(() => {
					store.dispose();

					// If we get here without resolving, user pressed ESC - signal skip
					safeResolve('skipped');
				})
			);

			quickPick.show();
		});
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IAskQuestionsParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { questions } = options.input;

		// Validate input early before showing UI
		if (!questions || questions.length === 0) {
			throw new Error(l10n.t('No questions provided. The questions array must contain at least one question.'));
		}

		for (const question of questions) {
			if (!question.options || question.options.length < 2) {
				throw new Error(l10n.t('Question "{0}" must have at least two options.', question.header));
			}
		}

		const questionCount = questions.length;
		const message = questionCount === 1
			? l10n.t('Asking a question')
			: l10n.t('Asking {0} questions', questionCount);
		const pastMessage = questionCount === 1
			? l10n.t('Asked a question')
			: l10n.t('Asked {0} questions', questionCount);

		return {
			invocationMessage: new MarkdownString(message),
			pastTenseMessage: new MarkdownString(pastMessage)
		};
	}
}

ToolRegistry.registerTool(AskQuestionsTool);
