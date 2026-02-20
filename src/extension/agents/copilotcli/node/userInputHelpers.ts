/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions } from '@github/copilot/sdk';
import { ILogService } from '../../../../platform/log/common/logService';
import { ChatQuestion } from '../../../../vscodeTypes';
import { IAnswerResult } from '../../../tools/common/askQuestionsTypes';

export type UserInputRequest = Parameters<NonNullable<SessionOptions['requestUserInput']>>[0];

export type UserInputResponse = ReturnType<NonNullable<SessionOptions['requestUserInput']>>;

export function convertBackgroundQuestionToolResponseToAnswers(questions: ChatQuestion[], carouselAnswers: Record<string, unknown> | undefined, logService: ILogService): IAnswerResult {
	const result: IAnswerResult = { answers: {} };

	// Log all available keys in carouselAnswers for debugging
	if (carouselAnswers) {
		logService.trace(`[AskQuestionsTool] Carousel answer keys: ${Object.keys(carouselAnswers).join(', ')}`);
		logService.trace(`[AskQuestionsTool] Question titles: ${questions.map(q => q.title).join(', ')}`);
	}

	for (const question of questions) {
		if (!carouselAnswers) {
			// User skipped all questions
			result.answers[question.id] = {
				selected: [],
				freeText: null,
				skipped: true
			};
			continue;
		}

		const answer = carouselAnswers[question.id];
		logService.trace(`[AskQuestionsTool] Processing question "${question.title}", raw answer: ${JSON.stringify(answer)}, type: ${typeof answer}`);

		if (answer === undefined) {
			result.answers[question.id] = {
				selected: [],
				freeText: null,
				skipped: true
			};
		} else if (typeof answer === 'string') {
			// Free text answer or single selection
			if (question.options?.some(opt => opt.label === answer)) {
				result.answers[question.id] = {
					selected: [answer],
					freeText: null,
					skipped: false
				};
			} else {
				result.answers[question.id] = {
					selected: [],
					freeText: answer,
					skipped: false
				};
			}
		} else if (Array.isArray(answer)) {
			// Multi-select answer
			result.answers[question.id] = {
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
				result.answers[question.id] = {
					selected: answerObj.selectedValues.map(v => String(v)),
					freeText: freeformValue,
					skipped: false
				};
			} else if ('selectedValue' in answerObj) {
				const value = answerObj.selectedValue;
				if (typeof value === 'string') {
					if (question.options?.some(opt => opt.label === value)) {
						result.answers[question.id] = {
							selected: [value],
							freeText: freeformValue,
							skipped: false
						};
					} else {
						// selectedValue is not a known option - treat it as free text
						result.answers[question.id] = {
							selected: [],
							freeText: freeformValue ?? value,
							skipped: false
						};
					}
				} else if (Array.isArray(value)) {
					result.answers[question.id] = {
						selected: value.map(v => String(v)),
						freeText: freeformValue,
						skipped: false
					};
				} else if (value === undefined || value === null) {
					// No selection made, but might have freeform text
					if (freeformValue) {
						result.answers[question.id] = {
							selected: [],
							freeText: freeformValue,
							skipped: false
						};
					} else {
						result.answers[question.id] = {
							selected: [],
							freeText: null,
							skipped: true
						};
					}
				}
			} else if ('freeformValue' in answerObj && freeformValue) {
				// Only freeform text provided, no selection
				result.answers[question.id] = {
					selected: [],
					freeText: freeformValue,
					skipped: false
				};
			} else if ('label' in answerObj && typeof answerObj.label === 'string') {
				// Answer might be the raw option object
				result.answers[question.id] = {
					selected: [answerObj.label],
					freeText: null,
					skipped: false
				};
			} else {
				// Unknown object format
				logService.warn(`[AskQuestionsTool] Unknown answer object format for "${question.title}": ${JSON.stringify(answer)}`);
				result.answers[question.id] = {
					selected: [],
					freeText: null,
					skipped: true
				};
			}
		} else {
			// Unknown format, treat as skipped
			logService.warn(`[AskQuestionsTool] Unknown answer format for "${question.title}": ${typeof answer}`);
			result.answers[question.id] = {
				selected: [],
				freeText: null,
				skipped: true
			};
		}
	}

	return result;
}
