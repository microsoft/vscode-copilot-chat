/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LRUCache } from '../../../util/vs/base/common/map';
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

interface IChatQuestionLookup {
	readonly id: string;
	readonly title: string;
}

export class AskQuestionsTool implements ICopilotTool<IAskQuestionsParams> {
	public static readonly toolName = ToolName.AskQuestions;

	private _invocationSequence = 0;
	private _promptContext: IBuildPromptContext | undefined;
	private readonly _promptContextByRequestId = new LRUCache<string, IBuildPromptContext>(10);
	// We resolve prompt context per invocation input object to avoid cross-request races.
	private readonly _promptContextByInput = new WeakMap<object, IBuildPromptContext>();

	constructor(
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAskQuestionsParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const stopWatch = StopWatch.create();
		const { questions } = options.input;
		this._logService.trace(`[AskQuestionsTool] Invoking with ${questions.length} question(s)`);

		const promptContext = this._getPromptContext(options);
		if (options.chatRequestId) {
			this._promptContextByRequestId.delete(options.chatRequestId);
		}

		const stream = promptContext?.stream;
		if (!stream) {
			this._logService.warn('[AskQuestionsTool] No stream available, cannot show question carousel');
			throw new Error(vscode.l10n.t('Cannot ask questions because the chat response stream is unavailable.'));
		}

		// Convert IQuestion array to ChatQuestion array
		const invocationId = this._createInvocationId(options.chatRequestId);
		const chatQuestions = questions.map((q, index) => this._convertToChatQuestion(q, index, invocationId));
		this._logService.trace(`[AskQuestionsTool] ChatQuestions: ${JSON.stringify(chatQuestions.map(q => ({ id: q.id, title: q.title, type: q.type })))}`);

		// Show the question carousel and wait for answers.
		// We explicitly disallow skip to avoid silent auto-skip behavior.
		let carouselAnswers = await stream.questionCarousel(chatQuestions, false);
		this._logService.trace(`[AskQuestionsTool] Raw carousel answers: ${JSON.stringify(carouselAnswers)}`);

		// Fallback path: in some hosts, multi-question carousel may return undefined immediately.
		// Retry as one-by-one blocking questions before giving up.
		if (carouselAnswers === undefined && questions.length > 1 && !token.isCancellationRequested) {
			this._logService.warn('[AskQuestionsTool] Multi-question carousel returned undefined, retrying one-by-one');
			const recoveredAnswers: Record<string, unknown> = {};
			for (const question of chatQuestions) {
				if (token.isCancellationRequested) {
					break;
				}
				const singleAnswer = await stream.questionCarousel([question], false);
				this._logService.trace(`[AskQuestionsTool] Single-question fallback answer for "${question.title}": ${JSON.stringify(singleAnswer)}`);
				if (singleAnswer) {
					Object.assign(recoveredAnswers, singleAnswer);
				}
			}
			carouselAnswers = Object.keys(recoveredAnswers).length > 0 ? recoveredAnswers : undefined;
		}

		if (carouselAnswers === undefined && !token.isCancellationRequested) {
			// Don't silently convert this into "Skipped" because that causes the agent to proceed without user input.
			throw new Error(vscode.l10n.t('No answers were submitted for the questionnaire.'));
		}

		// Immediately show progress to address the long pause after carousel submission
		// This provides visual feedback while answers are processed and the LLM generates a response
		stream.progress(vscode.l10n.t('Analyzing your answers...'));

		// Convert carousel answers back to IAnswerResult format
		const result = this._convertCarouselAnswers(questions, carouselAnswers, chatQuestions);
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
		if (promptContext.requestId) {
			this._promptContextByRequestId.set(promptContext.requestId, promptContext);
		}
		if (typeof input === 'object' && input !== null) {
			this._promptContextByInput.set(input, promptContext);
		}
		return input;
	}

	private _convertToChatQuestion(question: IQuestion, index: number, invocationId: string): ChatQuestion {
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
			`${invocationId}_question_${index + 1}`,
			type,
			`${index + 1}. ${question.header}`,
			{
				message: question.question,
				options: question.options?.map(opt => ({
					id: opt.label,
					label: `${opt.label}${opt.description ? `: ${opt.description}` : ''}`,
					value: opt.label
				})),
				defaultValue,
				allowFreeformInput: question.allowFreeformInput ?? false
			}
		);
	}

	protected _convertCarouselAnswers(questions: IQuestion[], carouselAnswers: Record<string, unknown> | undefined, chatQuestions?: ReadonlyArray<IChatQuestionLookup>): IAnswerResult {
		const result: IAnswerResult = { answers: {} };

		// Log all available keys in carouselAnswers for debugging
		if (carouselAnswers) {
			this._logService.trace(`[AskQuestionsTool] Carousel answer keys: ${Object.keys(carouselAnswers).join(', ')}`);
			this._logService.trace(`[AskQuestionsTool] Question headers: ${questions.map(q => q.header).join(', ')}`);
		}

		for (let i = 0; i < questions.length; i++) {
			const question = questions[i];
			if (!carouselAnswers) {
				// User skipped all questions
				result.answers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true
				};
				continue;
			}

			const chatQuestion = chatQuestions?.[i];
			const answer = this._findAnswerForQuestion(carouselAnswers, question, chatQuestion);
			this._logService.trace(`[AskQuestionsTool] Processing question "${question.header}", raw answer: ${JSON.stringify(answer)}, type: ${typeof answer}`);

			if (answer === undefined) {
				result.answers[question.header] = {
					selected: [],
					freeText: null,
					skipped: true
				};
			} else if (typeof answer === 'string') {
				// Free text answer or single selection
				const matchedOption = this._matchOptionLabel(question, answer);
				if (matchedOption) {
					result.answers[question.header] = {
						selected: [matchedOption],
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
					selected: this._coerceSelectionValues(answer),
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
						selected: this._coerceSelectionValues(answerObj.selectedValues),
						freeText: freeformValue,
						skipped: false
					};
				} else if ('selectedValue' in answerObj) {
					const value = answerObj.selectedValue;
					if (typeof value === 'string') {
						const matchedOption = this._matchOptionLabel(question, value);
						if (matchedOption) {
							result.answers[question.header] = {
								selected: [matchedOption],
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
							selected: this._coerceSelectionValues(value),
							freeText: freeformValue,
							skipped: false
						};
					} else if (typeof value === 'object' && value !== null) {
						const coercedValue = this._coerceSelectionValue(value);
						if (coercedValue !== undefined) {
							const matchedOption = this._matchOptionLabel(question, coercedValue);
							if (matchedOption) {
								result.answers[question.header] = {
									selected: [matchedOption],
									freeText: freeformValue,
									skipped: false
								};
							} else {
								result.answers[question.header] = {
									selected: [],
									freeText: freeformValue ?? coercedValue,
									skipped: false
								};
							}
						} else if (freeformValue) {
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
					const matchedOption = this._matchOptionLabel(question, answerObj.label);
					result.answers[question.header] = {
						selected: matchedOption ? [matchedOption] : [answerObj.label],
						freeText: null,
						skipped: false
					};
				} else {
					// Unknown object format
					this._logService.warn(`[AskQuestionsTool] Unknown answer object format for "${question.header}"`);
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

	private _getPromptContextForInput(input: IAskQuestionsParams): IBuildPromptContext | undefined {
		if (typeof input !== 'object' || input === null) {
			return undefined;
		}
		return this._promptContextByInput.get(input);
	}

	private _createInvocationId(chatRequestId: string | undefined): string {
		this._invocationSequence++;
		const requestPart = (chatRequestId ?? 'request').replace(/[^a-zA-Z0-9_-]/g, '_');
		return `${requestPart}_${this._invocationSequence}`;
	}

	private _getPromptContext(options: vscode.LanguageModelToolInvocationOptions<IAskQuestionsParams>): IBuildPromptContext | undefined {
		const fromInput = this._getPromptContextForInput(options.input);
		const fromRequestId = options.chatRequestId
			? this._promptContextByRequestId.get(options.chatRequestId)
			: undefined;
		const fallback = this._promptContext;

		if (options.chatRequestId && fallback?.requestId && fallback.requestId !== options.chatRequestId) {
			return fromInput ?? fromRequestId;
		}

		// Final fallback preserves prior behavior when invocation input is rehydrated by the tool runtime.
		return fromInput ?? fromRequestId ?? fallback;
	}

	private _findAnswerForQuestion(
		answers: Record<string, unknown>,
		question: IQuestion,
		chatQuestion: IChatQuestionLookup | undefined
	): unknown {
		const candidateKeys = [
			chatQuestion?.id,
			question.header,
			chatQuestion?.title,
		].filter((key): key is string => typeof key === 'string' && key.length > 0);

		for (const key of candidateKeys) {
			if (Object.prototype.hasOwnProperty.call(answers, key)) {
				return answers[key];
			}
		}

		const normalizedCandidates = new Set(candidateKeys.map(key => this._normalizeQuestionKey(key)));
		for (const [key, value] of Object.entries(answers)) {
			if (normalizedCandidates.has(this._normalizeQuestionKey(key))) {
				return value;
			}
		}

		// Preserve legacy lookup for numbered titles.
		return this._findAnswerByIndexedTitle(answers, question.header)
			?? (chatQuestion ? this._findAnswerByIndexedTitle(answers, chatQuestion.title) : undefined);
	}

	private _normalizeQuestionKey(key: string): string {
		return key
			.replace(/^\d+\s*[.)-]\s*/, '')
			.replace(/\s+/g, ' ')
			.trim()
			.toLowerCase();
	}

	private _coerceSelectionValues(values: unknown[]): string[] {
		return values
			.map(value => this._coerceSelectionValue(value))
			.filter((value): value is string => value !== undefined);
	}

	private _coerceSelectionValue(value: unknown): string | undefined {
		if (typeof value === 'string') {
			return value;
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
		if (typeof value === 'object' && value !== null) {
			const valueObj = value as Record<string, unknown>;
			if (typeof valueObj.value === 'string') {
				return valueObj.value;
			}
			if (typeof valueObj.label === 'string') {
				return valueObj.label;
			}
			if (typeof valueObj.id === 'string') {
				return valueObj.id;
			}
		}
		return undefined;
	}

	private _matchOptionLabel(question: IQuestion, selectedValue: string): string | undefined {
		if (!question.options || question.options.length === 0) {
			return undefined;
		}

		const exact = question.options.find(opt => opt.label === selectedValue);
		if (exact) {
			return exact.label;
		}

		// If the UI returns the rich display label ("Label: description"), map it back to the canonical option label.
		const prefixed = question.options.find(opt =>
			selectedValue.startsWith(`${opt.label}:`)
			|| selectedValue.startsWith(`${opt.label} -`)
		);
		return prefixed?.label;
	}

	private _findAnswerByIndexedTitle(answers: Record<string, unknown>, header: string): unknown {
		for (const [key, value] of Object.entries(answers)) {
			if (key.replace(/^\d+\s*[.)-]\s*/, '') === header) {
				return value;
			}
		}
		return undefined;
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
