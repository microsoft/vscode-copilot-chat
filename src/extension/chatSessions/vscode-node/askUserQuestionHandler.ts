/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatParticipantToolToken, LanguageModelTextPart } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IUserQuestionHandler, UserInputRequest, UserInputResponse } from '../copilotcli/node/userInputHelpers';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';

export interface IQuestionOption {
	readonly label: string;
	readonly description?: string;
	readonly recommended?: boolean;
}

export interface IQuestion {
	readonly header: string;
	readonly question: string;
	readonly multiSelect?: boolean;
	readonly options?: IQuestionOption[];
	readonly allowFreeformInput?: boolean;
}

export interface IAskQuestionsParams {
	readonly questions: IQuestion[];
}

export interface IQuestionAnswer {
	readonly selected: string[];
	readonly freeText: string | null;
	readonly skipped: boolean;
}

export interface IAnswerResult {
	readonly answers: Record<string, IQuestionAnswer>;
}


export class UserQuestionHandler implements IUserQuestionHandler {
	declare _serviceBrand: undefined;
	constructor(
		@ILogService protected readonly _logService: ILogService,
		@IToolsService private readonly _toolsService: IToolsService,
	) {
	}
	async askUserQuestion(question: UserInputRequest, toolInvocationToken: ChatParticipantToolToken, token: CancellationToken): Promise<UserInputResponse | undefined> {
		const input: IAskQuestionsParams = {
			questions: [
				{
					header: question.question,
					question: question.question,
					allowFreeformInput: question.allowFreeform,
					options: question.choices?.map(option => ({ label: option })),
				}
			]
		};
		const result = await this._toolsService.invokeTool(ToolName.CoreAskQuestions, {
			input,
			toolInvocationToken,
		}, token);


		// Parse the result
		const firstPart = result?.content.at(0);
		if (!(firstPart instanceof LanguageModelTextPart) || !firstPart.value) {
			return undefined;
		}

		const carouselAnswers = JSON.parse(firstPart.value) as IAnswerResult;

		// Log all available keys in carouselAnswers for debugging
		this._logService.trace(`[AskQuestionsTool] Question & answers ${question.question}, Answers object: ${JSON.stringify(carouselAnswers)}`);

		const answer = carouselAnswers.answers[question.question];
		if (answer === undefined) {
			return undefined;
		} else if (answer.freeText) {
			return {
				answer: answer.freeText,
				wasFreeform: true
			};
		} else if (answer.selected.length) {
			return {
				answer: answer.selected.join(', '),
				wasFreeform: false,
			};
		}
		return undefined;
	}
}
