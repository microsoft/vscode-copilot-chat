/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ICustomInstructionsService } from '../../../platform/customInstructions/common/customInstructionsService';
import { TextDocumentSnapshot } from '../../../platform/editing/common/textDocumentSnapshot';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { getCurrentCapturingToken, IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseNotebookEditPart, ChatResponseTextEditPart, ChatToolInvocationPart, ExtendedLanguageModelToolResult, LanguageModelTextPart, MarkdownString } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { SkillSubagentToolCallingLoop } from '../../prompt/node/skillSubagentToolCallingLoop';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { formatUriForFileWidget } from '../common/toolUtils';
import { resolveToolInputPath } from './toolUtils';

export interface ILoadSkillParams {
	/** Path to the SKILL.md file to load. */
	skillPath: string;
	/** The mode. 'inline' (default) returns skill content as context. 'fork' spawns a subagent with the skill instructions. */
	context?: 'inline' | 'fork';
	/** Required when context is 'fork'. The task for the skill subagent to perform. */
	query?: string;
	/** Required when context is 'fork'. A short user-visible description of the task. */
	description?: string;
}

const DEFAULT_SKILL_SUBAGENT_TOOL_CALL_LIMIT = 10;

class LoadSkillTool implements ICopilotTool<ILoadSkillParams> {
	public static readonly toolName = ToolName.LoadSkill;
	public static readonly nonDeferred = true;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@ICustomInstructionsService private readonly customInstructionsService: ICustomInstructionsService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ILoadSkillParams>, token: vscode.CancellationToken) {
		const uri = resolveToolInputPath(options.input.skillPath, this.promptPathRepresentationService);

		// Read the skill file content
		const document = await this.workspaceService.openTextDocument(uri);
		const snapshot = TextDocumentSnapshot.create(document);
		const skillContent = snapshot.getText();

		const mode = options.input.context ?? 'inline';

		if (mode === 'inline') {
			return this.invokeInline(skillContent, uri);
		} else {
			return this.invokeFork(skillContent, options, token);
		}
	}

	private invokeInline(skillContent: string, uri: import('../../../util/vs/base/common/uri').URI) {
		const skillInfo = this.customInstructionsService.getSkillInfo(uri);
		const skillLabel = skillInfo?.skillName ?? 'skill';
		const resultText = `<skill_instructions name="${skillLabel}">\n${skillContent}\n</skill_instructions>`;

		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(resultText)]);
		result.toolResultMessage = new MarkdownString(l10n.t`Loaded skill: ${skillLabel}`);
		return result;
	}

	private async invokeFork(skillContent: string, options: vscode.LanguageModelToolInvocationOptions<ILoadSkillParams>, token: vscode.CancellationToken) {
		if (!this._inputContext) {
			throw new Error('LoadSkillTool: _inputContext is not set. Ensure resolveInput is called before invoke.');
		}

		const query = options.input.query;
		if (!query) {
			throw new Error('LoadSkillTool: query is required when context is "fork".');
		}

		const request = this._inputContext.request!;
		const parentSessionId = this._inputContext.conversation?.sessionId ?? generateUuid();
		const subAgentInvocationId = generateUuid();

		const loop = this.instantiationService.createInstance(SkillSubagentToolCallingLoop, {
			toolCallLimit: DEFAULT_SKILL_SUBAGENT_TOOL_CALL_LIMIT,
			conversation: new Conversation(parentSessionId, [new Turn(generateUuid(), { type: 'user', message: query })]),
			request,
			location: request.location,
			promptText: query,
			skillInstructions: skillContent,
			subAgentInvocationId,
		});

		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => part instanceof ChatToolInvocationPart || part instanceof ChatResponseTextEditPart || part instanceof ChatResponseNotebookEditPart
		);

		const parentChatSessionId = getCurrentCapturingToken()?.chatSessionId;
		const skillSubagentToken = new CapturingToken(
			`Skill: ${options.input.description?.substring(0, 50) ?? query.substring(0, 50)}${(options.input.description ?? query).length > 50 ? '...' : ''}`,
			'skill',
			subAgentInvocationId,
			'skill',
			subAgentInvocationId,
			parentChatSessionId,
			'skillSubagent',
		);

		const loopResult = await this.requestLogger.captureInvocation(skillSubagentToken, () => loop.run(stream, token));

		const toolMetadata = {
			skillPath: options.input.skillPath,
			query,
			description: options.input.description,
			subAgentInvocationId,
			agentName: 'skill'
		};

		let subagentResponse = '';
		if (loopResult.response.type === ChatFetchResponseType.Success) {
			subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		} else {
			subagentResponse = `The skill subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
		}

		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(subagentResponse)]);
		result.toolMetadata = toolMetadata;
		result.toolResultMessage = new MarkdownString(l10n.t`Skill complete: ${options.input.description ?? query}`);
		return result;
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ILoadSkillParams>, _token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation | undefined> {
		const uri = resolveToolInputPath(options.input.skillPath, this.promptPathRepresentationService);

		await this.customInstructionsService.refreshExtensionPromptFiles();
		const skillInfo = this.customInstructionsService.getSkillInfo(uri);
		const skillLabel = skillInfo?.skillName ?? 'skill';

		const mode = options.input.context ?? 'inline';

		if (mode === 'fork') {
			return {
				invocationMessage: new MarkdownString(l10n.t`Running skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillLabel })}: ${options.input.description ?? options.input.query ?? ''}`),
				pastTenseMessage: new MarkdownString(l10n.t`Ran skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillLabel })}`),
			};
		}

		return {
			invocationMessage: new MarkdownString(l10n.t`Loading skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillLabel })}`),
			pastTenseMessage: new MarkdownString(l10n.t`Loaded skill ${formatUriForFileWidget(uri, { vscodeLinkType: 'skill', linkText: skillLabel })}`),
		};
	}

	async resolveInput(input: ILoadSkillParams, promptContext: IBuildPromptContext, _mode: CopilotToolMode): Promise<ILoadSkillParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(LoadSkillTool);
