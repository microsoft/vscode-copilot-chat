/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatParticipantToolToken, ChatResponseStream, LanguageModelTextPart } from 'vscode';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { ILogService } from '../../../platform/log/common/logService';
import { IAnswerResult, IUserQuestionHandler, UserInputRequest, UserInputResponse } from '../../agents/copilotcli/node/userInputHelpers';
import { ToolName } from '../../tools/common/toolNames';
import { CopilotToolMode, ICopilotTool } from '../../tools/common/toolsRegistry';
import { IToolsService } from '../../tools/common/toolsService';
import { IAskQuestionsParams } from '../../tools/vscode-node/askQuestionsTool';


export class UserQuestionHandler implements IUserQuestionHandler {
	declare _serviceBrand: undefined;
	constructor(
		@ILogService protected readonly _logService: ILogService,
		@IToolsService private readonly _toolsService: IToolsService,
	) {
	}
	async askUserQuestion(question: UserInputRequest, stream: ChatResponseStream, toolInvocationToken: ChatParticipantToolToken, token: CancellationToken): Promise<UserInputResponse | undefined> {
		// Get the AskQuestions tool instance directly
		const askQuestionsTool = this._toolsService.getCopilotTool(ToolName.AskQuestions) as ICopilotTool<IAskQuestionsParams> | undefined;
		if (!askQuestionsTool?.invoke) {
			throw new Error('AskQuestions tool is not available');
		}

		const input: IAskQuestionsParams = {
			questions: [
				{
					header: question.question,
					question: question.question,
					allowFreeformInput: question.allowFreeform,
					options: question.choices?.map(option => ({ label: option })),
					multiSelect: !!question.choices?.length,
				}
			]
		};
		// Call resolveInput to inject the stream (needed for displaying the question carousel)
		if (askQuestionsTool.resolveInput) {
			await askQuestionsTool.resolveInput(
				input,
				{ stream } as Parameters<typeof askQuestionsTool.resolveInput>[1],
				CopilotToolMode.FullContext
			);
		}

		// Invoke the tool directly
		const result = await askQuestionsTool.invoke(
			{
				input: input,
				toolInvocationToken,
			},
			token
		);

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
