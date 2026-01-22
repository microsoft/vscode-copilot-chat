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

			// answer is guaranteed to be the answer object here:
			// - 'back' case already executed `continue` above
			// - 'skipped' case already executed `break` above
			result.answers[question.header] = answer as { selected: string[]; freeText: string | null; skipped: boolean };
			currentStep++;
		}

		// Calculate telemetry metrics from results
		const answers = Object.values(result.answers);
		const answeredCount = answers.filter(a => !a.skipped).length;
		const skippedCount = answers.filter(a => a.skipped).length;
		const freeTextCount = answers.filter(a => a.freeText !== null).length;
		const recommendedAvailableCount = questions.filter(q => q.options.some(opt => opt.recommended)).length;
		const recommendedSelectedCount = questions.filter(q => {
			const answer = result.answers[q.header];
			const recommendedOption = q.options.find(opt => opt.recommended);
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

	private _getDefaultOption(question: IQuestion): IQuestionOption {
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
				label: vscode.l10n.t('Other...'),
				description: vscode.l10n.t('Enter custom answer'),
				isFreeText: true,
				originalLabel: 'Other'
			});

			quickPick.items = items;

			// Set default selection
			const defaultOption = this._getDefaultOption(question);
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
							placeHolder: vscode.l10n.t('Enter your answer'),
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
			if (!question.options || question.options.length < 2) {
				throw new Error(vscode.l10n.t('Question "{0}" must have at least two options.', question.header));
			}
		}

		const questionCount = questions.length;
		const message = questionCount === 1
			? vscode.l10n.t('Asking a question')
			: vscode.l10n.t('Asking {0} questions', questionCount);
		const pastMessage = questionCount === 1
			? vscode.l10n.t('Asked a question')
			: vscode.l10n.t('Asked {0} questions', questionCount);

		return {
			invocationMessage: new MarkdownString(message),
			pastTenseMessage: new MarkdownString(pastMessage)
		};
	}
}

ToolRegistry.registerTool(AskQuestionsTool);
