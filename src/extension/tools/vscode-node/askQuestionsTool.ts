/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { StopWatch } from '../../../util/vs/base/common/stopwatch';
import { ChatQuestion, ChatQuestionType, LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

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
	allowFreeformInput?: boolean;
}

export interface IAskQuestionsParams {
	questions: IQuestion[];
}

export interface IQuestionAnswer {
	selected: string[];
	freeText: string | null;
	skipped: boolean;
}

export interface IAnswerResult {
	answers: Record<string, IQuestionAnswer>;
}

export class AskQuestionsTool implements ICopilotTool<IAskQuestionsParams> {
	public static readonly toolName = ToolName.AskQuestions;

	private _promptContext: IBuildPromptContext | undefined;

	constructor(
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAskQuestionsParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const stopWatch = StopWatch.create();
		const { questions } = options.input;
		this._logService.trace(`[AskQuestionsTool] Invoking with ${questions.length} question(s)`);

		const stream = this._promptContext?.stream;
		if (!stream) {
			this._logService.warn('[AskQuestionsTool] No stream available, cannot show question carousel');

			// When no stream is available, return a schema-compliant result with all questions marked as skipped
			const skippedAnswers: Record<string, IQuestionAnswer> = {};
			for (const question of questions) {
				skippedAnswers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true
				};
			}

			const toolResultJson = JSON.stringify({ answers: skippedAnswers });
			return new LanguageModelToolResult([
				new LanguageModelTextPart(toolResultJson)
			]);
		}

		// Convert IQuestion array to ChatQuestion array
		const chatQuestions = questions.map(q => this._convertToChatQuestion(q));
		this._logService.trace(`[AskQuestionsTool] ChatQuestions: ${JSON.stringify(chatQuestions.map(q => ({ id: q.id, title: q.title, type: q.type })))}`);

		// Show the question carousel and wait for answers
		const carouselAnswers = await stream.questionCarousel(chatQuestions, true);
		this._logService.trace(`[AskQuestionsTool] Raw carousel answers: ${JSON.stringify(carouselAnswers)}`);

		// Convert carousel answers back to IAnswerResult format
		const result = this._convertCarouselAnswers(questions, carouselAnswers);
		this._logService.trace(`[AskQuestionsTool] Converted result: ${JSON.stringify(result)}`);

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

		const toolResultJson = JSON.stringify(result);
		this._logService.trace(`[AskQuestionsTool] Returning tool result: ${toolResultJson}`);
		return new LanguageModelToolResult([
			new LanguageModelTextPart(toolResultJson)
		]);
	}

	async resolveInput(input: IAskQuestionsParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<IAskQuestionsParams> {
		this._promptContext = promptContext;
		return input;
	}

	private _convertToChatQuestion(question: IQuestion): ChatQuestion {
		// Determine question type based on options and multiSelect
		let type: ChatQuestionType;
		if (!question.options || question.options.length === 0) {
			type = ChatQuestionType.Text;
		} else if (question.multiSelect) {
			type = ChatQuestionType.MultiSelect;
		} else {
			type = ChatQuestionType.SingleSelect;
		}

		// Find default value from recommended option
		let defaultValue: string | string[] | undefined;
		if (question.options) {
			const recommendedOptions = question.options.filter(opt => opt.recommended);
			if (recommendedOptions.length > 0) {
				if (question.multiSelect) {
					defaultValue = recommendedOptions.map(opt => opt.label);
				} else {
					defaultValue = recommendedOptions[0].label;
				}
			}
		}

		return new ChatQuestion(
			question.header,
			type,
			question.header,
			{
				message: question.question,
				options: question.options?.map(opt => ({
					id: opt.label,
					label: `${opt.label}${opt.description ? ' - ' + opt.description : ''}`,
					value: opt.label
				})),
				defaultValue,
				allowFreeformInput: question.allowFreeformInput ?? false
			}
		);
	}

	protected _convertCarouselAnswers(questions: IQuestion[], carouselAnswers: Record<string, unknown> | undefined): IAnswerResult {
		const result: IAnswerResult = { answers: {} };

		// Log all available keys in carouselAnswers for debugging
		if (carouselAnswers) {
			this._logService.trace(`[AskQuestionsTool] Carousel answer keys: ${Object.keys(carouselAnswers).join(', ')}`);
			this._logService.trace(`[AskQuestionsTool] Question headers: ${questions.map(q => q.header).join(', ')}`);
		}

		for (const question of questions) {
			if (!carouselAnswers) {
				// User skipped all questions
				result.answers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true
				};
				continue;
			}

			const answer = carouselAnswers[question.header];
			this._logService.trace(`[AskQuestionsTool] Processing question "${question.header}", raw answer: ${JSON.stringify(answer)}, type: ${typeof answer}`);

			if (answer === undefined) {
				result.answers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true
				};
			} else if (typeof answer === 'string') {
				// Free text answer or single selection
				if (question.options?.some(opt => opt.label === answer)) {
					result.answers[question.header] = {
						selected: [answer],
						freeText: null,
						skipped: false
					};
				} else {
					result.answers[question.header] = {
						selected: [],
						freeText: answer,
						skipped: false
					};
				}
			} else if (Array.isArray(answer)) {
				// Multi-select answer
				result.answers[question.header] = {
					selected: answer.map(a => String(a)),
					freeText: null,
					skipped: false
				};
			} else if (typeof answer === 'object' && answer !== null) {
				// Handle object answers - VS Code returns { selectedValue: string } or { selectedValues: string[] }
				// Also may include { freeformValue: string } when user enters free text with options
				const answerObj = answer as Record<string, unknown>;

				// Extract freeform text if present (treat empty string as no freeform)
				const freeformValue = ('freeformValue' in answerObj && typeof answerObj.freeformValue === 'string' && answerObj.freeformValue)
					? answerObj.freeformValue
					: null;

				if ('selectedValues' in answerObj && Array.isArray(answerObj.selectedValues)) {
					// Multi-select answer
					result.answers[question.header] = {
						selected: answerObj.selectedValues.map(v => String(v)),
						freeText: freeformValue,
						skipped: false
					};
				} else if ('selectedValue' in answerObj) {
					const value = answerObj.selectedValue;
					if (typeof value === 'string') {
						if (question.options?.some(opt => opt.label === value)) {
							result.answers[question.header] = {
								selected: [value],
								freeText: freeformValue,
								skipped: false
							};
						} else {
							// selectedValue is not a known option - treat it as free text
							result.answers[question.header] = {
								selected: [],
								freeText: freeformValue ?? value,
								skipped: false
							};
						}
					} else if (Array.isArray(value)) {
						result.answers[question.header] = {
							selected: value.map(v => String(v)),
							freeText: freeformValue,
							skipped: false
						};
					} else if (value === undefined || value === null) {
						// No selection made, but might have freeform text
						if (freeformValue) {
							result.answers[question.header] = {
								selected: [],
								freeText: freeformValue,
								skipped: false
							};
						} else {
							result.answers[question.header] = {
								selected: [],
								freeText: null,
								skipped: true
							};
						}
					}
				} else if ('freeformValue' in answerObj && freeformValue) {
					// Only freeform text provided, no selection
					result.answers[question.header] = {
						selected: [],
						freeText: freeformValue,
						skipped: false
					};
				} else if ('label' in answerObj && typeof answerObj.label === 'string') {
					// Answer might be the raw option object
					result.answers[question.header] = {
						selected: [answerObj.label],
						freeText: null,
						skipped: false
					};
				} else {
					// Unknown object format
					this._logService.warn(`[AskQuestionsTool] Unknown answer object format for "${question.header}": ${JSON.stringify(answer)}`);
					result.answers[question.header] = {
						selected: [],
						freeText: null,
						skipped: true
					};
				}
			} else {
				// Unknown format, treat as skipped
				this._logService.warn(`[AskQuestionsTool] Unknown answer format for "${question.header}": ${typeof answer}`);
				result.answers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true
				};
			}
		}

		return result;
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
