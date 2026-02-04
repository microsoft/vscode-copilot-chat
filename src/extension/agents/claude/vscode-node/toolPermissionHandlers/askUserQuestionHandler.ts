/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart } from '../../../../../vscodeTypes';
import { ToolName } from '../../../../tools/common/toolNames';
import { CopilotToolMode, ICopilotTool } from '../../../../tools/common/toolsRegistry';
import { IToolsService } from '../../../../tools/common/toolsService';
import { IAnswerResult, IAskQuestionsParams } from '../../../../tools/vscode-node/askQuestionsTool';
import {
	ClaudeToolPermissionContext,
	ClaudeToolPermissionResult,
	IClaudeToolPermissionHandler
} from '../../common/claudeToolPermission';
import { registerToolPermissionHandler } from '../../common/claudeToolPermissionRegistry';
import { ClaudeToolNames } from '../../common/claudeTools';

/**
 * Handler for the AskUserQuestion tool.
 * Delegates to the AskQuestions tool for improved UX with step navigation,
 * back button support, and custom text input.
 */
export class AskUserQuestionHandler implements IClaudeToolPermissionHandler<ClaudeToolNames.AskUserQuestion> {
	public readonly toolNames = [ClaudeToolNames.AskUserQuestion] as const;

	constructor(
		@IToolsService private readonly toolsService: IToolsService,
	) { }

	public async handle(
		_toolName: ClaudeToolNames.AskUserQuestion,
		input: AskUserQuestionInput,
		context: ClaudeToolPermissionContext
	): Promise<ClaudeToolPermissionResult> {
		try {
			// Get the AskQuestions tool instance directly
			const askQuestionsTool = this.toolsService.getCopilotTool(ToolName.AskQuestions) as ICopilotTool<IAskQuestionsParams> | undefined;
			if (!askQuestionsTool?.invoke) {
				return {
					behavior: 'deny',
					message: 'The AskQuestions tool is not available'
				};
			}

			// Call resolveInput to inject the stream (needed for displaying the question carousel)
			if (askQuestionsTool.resolveInput) {
				await askQuestionsTool.resolveInput(
					input satisfies IAskQuestionsParams,
					{ stream: context.stream } as Parameters<typeof askQuestionsTool.resolveInput>[1],
					CopilotToolMode.FullContext
				);
			}

			// Invoke the tool directly
			const result = await askQuestionsTool.invoke(
				{
					input: input satisfies IAskQuestionsParams,
					toolInvocationToken: context.toolInvocationToken,
				},
				CancellationToken.None
			);

			// Parse the result
			const firstPart = result?.content.at(0);
			if (!(firstPart instanceof LanguageModelTextPart)) {
				return {
					behavior: 'deny',
					message: 'The user cancelled the question'
				};
			}

			const toolResult: IAnswerResult = JSON.parse(firstPart.value);

			// Check if all questions were skipped
			const allSkipped = Object.values(toolResult.answers).every(a => a.skipped);
			if (allSkipped) {
				return {
					behavior: 'deny',
					message: 'The user cancelled the question'
				};
			}

			// Transform result back to SDK expected format (answers keyed by question text)
			const answers: Record<string, string> = {};
			for (const questionItem of input.questions) {
				const answer = toolResult.answers[questionItem.header];
				if (answer && !answer.skipped) {
					// Combine selected options and free text
					const parts: string[] = [...answer.selected];
					if (answer.freeText) {
						parts.push(answer.freeText);
					}
					answers[questionItem.question] = parts.join(', ');
				}
			}

			return {
				behavior: 'allow',
				updatedInput: {
					...input,
					answers
				}
			};
		} catch {
			return {
				behavior: 'deny',
				message: 'The user cancelled the question'
			};
		}
	}
}

// Self-register the handler
registerToolPermissionHandler(
	[ClaudeToolNames.AskUserQuestion],
	AskUserQuestionHandler
);
