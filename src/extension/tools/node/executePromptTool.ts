/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseMarkdownPart, ExtendedLanguageModelToolResult, LanguageModelTextPart, MarkdownString } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ExecutePromptToolCallingLoop } from '../../prompt/node/executePromptToolCalling';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { assertFileOkForTool, formatUriForFileWidget, resolveToolInputPath } from './toolUtils';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';

export interface IExecutePromptParams {
	filePath: string;
}

class ExecutePromptTool implements ICopilotTool<IExecutePromptParams> {
	public static readonly toolName = ToolName.ExecutePrompt;
	private _inputContext: IBuildPromptContext | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IExecutePromptParams>, token: vscode.CancellationToken) {
		if (!options.input.filePath) {
			throw new Error('Invalid input');
		}

		// Read the prompt file as text and include a reference
		const uri = resolveToolInputPath(options.input.filePath, this.promptPathRepresentationService);
		await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, uri));
		const promptText = (await this.fileSystemService.readFile(uri)).toString();

		const loop = this.instantiationService.createInstance(ExecutePromptToolCallingLoop, {
			toolCallLimit: 5,
			conversation: new Conversation('', [new Turn('', { type: 'user', message: promptText })]),
			request: {
				...this._inputContext!.request!,
				references: [],
				prompt: promptText,
				toolReferences: [],
				modeInstructions: '',
				editedFileEvents: []
			},
			location: this._inputContext!.request!.location,
			promptText,
		});

		// TODO This also prevents codeblock pills from being rendered
		// I want to render this content as thinking blocks but couldn't get it to work
		const stream = this._inputContext?.stream && ChatResponseStreamImpl.filter(
			this._inputContext.stream,
			part => !(part instanceof ChatResponseMarkdownPart)
		);
		const loopResult = await loop.run(stream, token);
		// Return the text of the last assistant response from the tool calling loop
		const lastRoundResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
		const result = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(lastRoundResponse)]);
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IExecutePromptParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { input } = options;
		if (!input.filePath) {
			return;
		}
		try {
			const uri = resolveToolInputPath(input.filePath, this.promptPathRepresentationService);
			return {
				invocationMessage: new MarkdownString(l10n.t`Executing prompt file ${formatUriForFileWidget(uri)}`),
				pastTenseMessage: new MarkdownString(l10n.t`Executed prompt file ${formatUriForFileWidget(uri)}`),
			};
		} catch {
			return;
		}
	}

	async resolveInput(input: IExecutePromptParams, promptContext: IBuildPromptContext, mode: CopilotToolMode): Promise<IExecutePromptParams> {
		this._inputContext = promptContext;
		return input;
	}
}

ToolRegistry.registerTool(ExecutePromptTool);
