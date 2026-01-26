/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

export interface IQuestionOption {
	label: string;
	description?: string;
	recommended?: boolean;
}

export interface IQuestion {
	header: string;
	question: string;
	multiSelect?: boolean;
	options?: IQuestionOption[];
}

export interface IAskQuestionsParams {
	questions: IQuestion[];
}

export interface IQuestionAnswer {
	selected: string[];
	freeText: string | null;
	skipped: boolean;
}

type AskQuestionResult = IQuestionAnswer | 'back' | 'skipped';

export interface IAnswerResult {
	answers: Record<string, IQuestionAnswer>;
}

interface IQuickPickOptionItem extends vscode.QuickPickItem {
	isRecommended?: boolean;
	isCustomTextOption?: boolean;
	isOtherOption?: boolean;
	originalLabel: string;
}

export class AskQuestionsTool implements ICopilotTool<IAskQuestionsParams> {
	public static readonly toolName = ToolName.AskQuestions;

	constructor(
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAskQuestionsParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const stopWatch = StopWatch.create();
		const { questions } = options.input;
		this._logService.trace(`[AskQuestionsTool] Invoking with ${questions.length} question(s)`);
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

			if (answer === 'back') {
				if (currentStep > 0) {
					currentStep--;
				}
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

			// Control flow ensures answer is IQuestionAnswer here:
			// - 'back' case executed `continue` above
			// - 'skipped' case executed `break` above
			result.answers[question.header] = answer;
			currentStep++;
		}

		// Calculate telemetry metrics from results
		const answers = Object.values(result.answers);
		const answeredCount = answers.filter(a => !a.skipped).length;
		const skippedCount = answers.filter(a => a.skipped).length;
		const freeTextCount = answers.filter(a => a.freeText !== null).length;
		const recommendedAvailableCount = questions.filter(q => q.options?.some(opt => opt.recommended)).length;
		const recommendedSelectedCount = questions.filter(q => {
			const answer = result.answers[q.header];
			const recommendedOption = q.options?.find(opt => opt.recommended);
			return answer && !answer.skipped && recommendedOption && answer.selected.includes(recommendedOption.label);
		}).length;

		this._sendTelemetry(
			options.chatRequestId,
			questions.length,
			answeredCount,
			skippedCount,
			freeTextCount,
			recommendedAvailableCount,
			recommendedSelectedCount,
			stopWatch.elapsed()
		);

		return new LanguageModelToolResult([
			new LanguageModelTextPart(JSON.stringify(result))
		]);
	}

	private _sendTelemetry(
		requestId: string | undefined,
		questionCount: number,
		answeredCount: number,
		skippedCount: number,
		freeTextCount: number,
		recommendedAvailableCount: number,
		recommendedSelectedCount: number,
		duration: number
	): void {
		/* __GDPR__
			"askQuestionsToolInvoked" : {
				"owner": "digitarald",
				"comment": "Tracks usage of the AskQuestions tool for agent clarifications",
				"requestId": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The id of the current request turn." },
				"questionCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The total number of questions asked" },
				"answeredCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of questions that were answered" },
				"skippedCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of questions that were skipped" },
				"freeTextCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of questions answered with free text input" },
				"recommendedAvailableCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of questions that had a recommended option" },
				"recommendedSelectedCount": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The number of questions where the user selected the recommended option" },
				"duration": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "The total time in milliseconds to complete all questions" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('askQuestionsToolInvoked',
			{
				requestId,
			},
			{
				questionCount,
				answeredCount,
				skippedCount,
				freeTextCount,
				recommendedAvailableCount,
				recommendedSelectedCount,
				duration,
			}
		);
	}

	private _getDefaultOption(question: IQuestion): IQuestionOption | undefined {
		if (!question.options?.length) {
			return undefined;
		}
		const recommended = question.options.find(opt => opt.recommended);
		return recommended ?? question.options[0];
	}

	private async _askFreeTextQuestion(
		question: IQuestion,
		step: number,
		totalSteps: number,
		token: CancellationToken
	): Promise<AskQuestionResult> {
		const input = await vscode.window.showInputBox({
			title: `${question.header} (${step + 1}/${totalSteps})`,
			prompt: question.question,
			placeHolder: vscode.l10n.t('Enter your answer'),
			ignoreFocusOut: true
		}, token);

		if (input === undefined || !input.trim()) {
			return {
				selected: [],
				freeText: null,
				skipped: true
			};
		}

		return {
			selected: [],
			freeText: input.trim(),
			skipped: false
		};
	}

	private async askQuestion(
		question: IQuestion,
		step: number,
		totalSteps: number,
		token: CancellationToken
	): Promise<AskQuestionResult> {
		// Check cancellation before showing UI to avoid creating unnecessary QuickPick
		if (token.isCancellationRequested) {
			return 'skipped';
		}

		// Free text mode: show input box instead of QuickPick
		if (!question.options || question.options.length === 0) {
			return this._askFreeTextQuestion(question, step, totalSteps, token);
		}

		return new Promise((resolve) => {
			// Track resolution state to prevent race conditions (e.g., onDidHide firing after onDidAccept)
			let resolved = false;
			const safeResolve = (value: AskQuestionResult) => {
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
			const items: IQuickPickOptionItem[] = question.options!.map(opt => ({
				label: opt.recommended ? `$(star-full) ${opt.label}` : opt.label,
				description: opt.description,
				isRecommended: opt.recommended,
				originalLabel: opt.label
			}));

			// Track the original items for filtering (before adding "Other...")
			const originalItems = [...items];

			// Add "Other..." option for custom answers
			const otherItem: IQuickPickOptionItem = {
				label: `$(edit) ${vscode.l10n.t('Other...')}`,
				description: vscode.l10n.t('Enter custom answer'),
				isOtherOption: true,
				originalLabel: 'Other'
			};
			items.push(otherItem);

			quickPick.items = items;

			// Set default selection
			if (question.multiSelect) {
				// Select all recommended items in multiselect mode
				const recommendedItems = items.filter(item => item.isRecommended);
				if (recommendedItems.length > 0) {
					quickPick.selectedItems = recommendedItems;
				}
			} else {
				// Set first recommended or first item as active in single-select
				const defaultOption = this._getDefaultOption(question);
				if (defaultOption) {
					const defaultItem = items.find(item => item.originalLabel === defaultOption.label);
					if (defaultItem) {
						quickPick.activeItems = [defaultItem];
					}
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

			// Show dynamic "Use custom answer" item when typing non-matching text
			store.add(
				quickPick.onDidChangeValue(value => {
					const trimmed = value.trim();
					const matchesOption = originalItems.some(
						item => item.originalLabel.toLowerCase().includes(trimmed.toLowerCase())
					);

					if (trimmed.length > 0 && !matchesOption) {
						// Show custom text option at the top, keep "Other..." at the bottom
						const customItem: IQuickPickOptionItem = {
							label: `$(edit) ${vscode.l10n.t('Use "{0}"', trimmed)}`,
							description: vscode.l10n.t('Submit as custom answer'),
							originalLabel: trimmed,
							isCustomTextOption: true,
							alwaysShow: true
						};
						quickPick.items = [customItem, ...originalItems, otherItem];
					} else {
						// Restore original items with "Other..." at the bottom
						quickPick.items = [...originalItems, otherItem];
					}
				})
			);

			store.add(
				quickPick.onDidAccept(async () => {
					const selectedItems = question.multiSelect
						? quickPick.selectedItems
						: quickPick.activeItems;

					// Check if user explicitly selected the custom text option (dynamic)
					const customTextItem = selectedItems.find(item => item.isCustomTextOption);
					if (customTextItem) {
						// User explicitly chose the custom text option - only submit custom text
						quickPick.hide();
						safeResolve({
							selected: [],
							freeText: customTextItem.originalLabel,
							skipped: false
						});
						return;
					}

					// Check if user selected "Other..." option
					const otherOptionItem = selectedItems.find(item => item.isOtherOption);
					if (otherOptionItem) {
						// Mark as resolved before hiding to prevent onDidHide from resolving
						resolved = true;
						quickPick.hide();

						const freeTextInput = await vscode.window.showInputBox({
							prompt: question.question,
							placeHolder: vscode.l10n.t('Enter your answer'),
							ignoreFocusOut: true
						}, token);

						// Get other selections (excluding "Other...")
						const otherSelections = selectedItems
							.filter(item => !item.isOtherOption && !item.isCustomTextOption)
							.map(item => item.originalLabel);

						if (freeTextInput === undefined) {
							// User cancelled input box
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
								selected: otherSelections,
								freeText: freeTextInput,
								skipped: false
							});
						}
						return;
					}

					// Regular selection - filter out any special items
					const selectedLabels = selectedItems
						.filter(item => !item.isCustomTextOption && !item.isOtherOption)
						.map(item => item.originalLabel);

					if (selectedLabels.length === 0) {
						// No selection, use default if available
						const defaultOption = this._getDefaultOption(question);
						quickPick.hide();
						if (defaultOption) {
							safeResolve({
								selected: [defaultOption.label],
								freeText: null,
								skipped: false
							});
						} else {
							safeResolve('skipped');
						}
						return;
					}

					// Regular selection
					quickPick.hide();
					safeResolve({
						selected: selectedLabels,
						freeText: null,
						skipped: false
					});
				})
			);

			store.add(
				quickPick.onDidHide(() => {
					// Resolve first before disposal to prevent race conditions
					safeResolve('skipped');
					store.dispose();
				})
			);

			quickPick.show();
		});
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IAskQuestionsParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { questions } = options.input;

		// Validate input early before showing UI
		if (!questions || questions.length === 0) {
			throw new Error(vscode.l10n.t('No questions provided. The questions array must contain at least one question.'));
		}

		for (const question of questions) {
			// Options with 1 item don't make sense - need 0 (free text) or 2+ (choice)
			if (question.options && question.options.length === 1) {
				throw new Error(vscode.l10n.t('Question "{0}" must have at least two options, or none for free text input.', question.header));
			}
		}

		const questionCount = questions.length;
		const headers = questions.map(q => q.header).join(', ');
		const message = questionCount === 1
			? vscode.l10n.t('Asking a question ({0})', headers)
			: vscode.l10n.t('Asking {0} questions ({1})', questionCount, headers);
		const pastMessage = questionCount === 1
			? vscode.l10n.t('Asked a question ({0})', headers)
			: vscode.l10n.t('Asked {0} questions ({1})', questionCount, headers);

		return {
			invocationMessage: new MarkdownString(message),
			pastTenseMessage: new MarkdownString(pastMessage)
		};
	}
}

ToolRegistry.registerTool(AskQuestionsTool);
