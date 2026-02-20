/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../../vscodeTypes';
import { IAnswerResult, UserInputRequest } from '../../../agents/copilotcli/node/userInputHelpers';
import { ToolName } from '../../../tools/common/toolNames';
import { CopilotToolMode, ICopilotTool } from '../../../tools/common/toolsRegistry';
import { IToolsService } from '../../../tools/common/toolsService';
import type { IAskQuestionsParams } from '../../../tools/vscode-node/askQuestionsTool';
import { UserQuestionHandler } from '../askUserQuestionHandler';

function makeAskQuestionsTool(invokeResult: LanguageModelToolResult | undefined, resolveInput?: ICopilotTool<IAskQuestionsParams>['resolveInput']): ICopilotTool<IAskQuestionsParams> {
	return {
		invoke: vi.fn(async () => invokeResult),
		resolveInput,
	} as unknown as ICopilotTool<IAskQuestionsParams>;
}

function makeToolsService(tool: ICopilotTool<IAskQuestionsParams> | undefined): IToolsService {
	return new class extends mock<IToolsService>() {
		override getCopilotTool(name: string) {
			if (name === ToolName.AskQuestions) {
				return tool as unknown as ReturnType<IToolsService['getCopilotTool']>;
			}
			return undefined;
		}
	}();
}

const logService = new class extends mock<import('../../../../platform/log/common/logService').ILogService>() {
	override trace = vi.fn();
	override warn = vi.fn();
}();

function makeHandler(tool: ICopilotTool<IAskQuestionsParams> | undefined) {
	return new UserQuestionHandler(logService, makeToolsService(tool));
}

const stream = {} as import('vscode').ChatResponseStream;
const toolInvocationToken = {} as import('vscode').ChatParticipantToolToken;

const question: UserInputRequest = {
	question: 'What color?',
	choices: ['Red', 'Blue'],
	allowFreeform: true,
};

describe('UserQuestionHandler', () => {
	describe('askUserQuestion', () => {
		it('throws when AskQuestions tool is unavailable', async () => {
			const handler = makeHandler(undefined);
			await expect(handler.askUserQuestion(question, stream, toolInvocationToken, CancellationToken.None))
				.rejects.toThrow('AskQuestions tool is not available');
		});

		it('returns undefined when tool returns no content', async () => {
			const tool = makeAskQuestionsTool(new LanguageModelToolResult([]));
			const handler = makeHandler(tool);
			const result = await handler.askUserQuestion(question, stream, toolInvocationToken, CancellationToken.None);
			expect(result).toBeUndefined();
		});

		it('returns undefined when result part is not a LanguageModelTextPart', async () => {
			const tool = makeAskQuestionsTool(new LanguageModelToolResult([{ value: 'not-a-text-part' } as unknown as LanguageModelTextPart]));
			const handler = makeHandler(tool);
			const result = await handler.askUserQuestion(question, stream, toolInvocationToken, CancellationToken.None);
			expect(result).toBeUndefined();
		});

		it('returns undefined when the answer key is missing', async () => {
			const answers: IAnswerResult = { answers: {} };
			const tool = makeAskQuestionsTool(new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(answers))]));
			const handler = makeHandler(tool);
			const result = await handler.askUserQuestion(question, stream, toolInvocationToken, CancellationToken.None);
			expect(result).toBeUndefined();
		});

		it('returns freeText answer when freeText is present', async () => {
			const answers: IAnswerResult = {
				answers: {
					'What color?': { selected: [], freeText: 'Purple', skipped: false }
				}
			};
			const tool = makeAskQuestionsTool(new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(answers))]));
			const handler = makeHandler(tool);
			const result = await handler.askUserQuestion(question, stream, toolInvocationToken, CancellationToken.None);
			expect(result).toEqual({ answer: 'Purple', wasFreeform: true });
		});

		it('returns joined selections when choices are selected', async () => {
			const answers: IAnswerResult = {
				answers: {
					'What color?': { selected: ['Red', 'Blue'], freeText: null, skipped: false }
				}
			};
			const tool = makeAskQuestionsTool(new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(answers))]));
			const handler = makeHandler(tool);
			const result = await handler.askUserQuestion(question, stream, toolInvocationToken, CancellationToken.None);
			expect(result).toEqual({ answer: 'Red, Blue', wasFreeform: false });
		});

		it('returns undefined when answer has no freeText and no selections', async () => {
			const answers: IAnswerResult = {
				answers: {
					'What color?': { selected: [], freeText: null, skipped: true }
				}
			};
			const tool = makeAskQuestionsTool(new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(answers))]));
			const handler = makeHandler(tool);
			const result = await handler.askUserQuestion(question, stream, toolInvocationToken, CancellationToken.None);
			expect(result).toBeUndefined();
		});

		it('calls resolveInput when available to inject the stream', async () => {
			const resolveInput = vi.fn(async () => { });
			const answers: IAnswerResult = {
				answers: {
					'What color?': { selected: ['Red'], freeText: null, skipped: false }
				}
			};
			const tool = makeAskQuestionsTool(
				new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(answers))]),
				resolveInput as unknown as ICopilotTool<IAskQuestionsParams>['resolveInput']
			);
			const handler = makeHandler(tool);
			await handler.askUserQuestion(question, stream, toolInvocationToken, CancellationToken.None);
			expect(resolveInput).toHaveBeenCalledWith(
				expect.objectContaining({ questions: expect.any(Array) }),
				expect.objectContaining({ stream }),
				CopilotToolMode.FullContext
			);
		});

		it('passes question text, choices, and freeform flag to the tool', async () => {
			const answers: IAnswerResult = {
				answers: { 'What color?': { selected: ['Red'], freeText: null, skipped: false } }
			};
			const tool = makeAskQuestionsTool(new LanguageModelToolResult([new LanguageModelTextPart(JSON.stringify(answers))]));
			const handler = makeHandler(tool);
			await handler.askUserQuestion(question, stream, toolInvocationToken, CancellationToken.None);
			const invokeArg = (tool.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(invokeArg.input.questions[0]).toMatchObject({
				header: 'What color?',
				question: 'What color?',
				allowFreeformInput: true,
				options: [{ label: 'Red' }, { label: 'Blue' }],
			});
		});
	});
});
