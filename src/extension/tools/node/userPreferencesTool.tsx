/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, Raw, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { Proxy4oEndpoint } from '../../../platform/endpoint/node/proxy4oEndpoint';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { extractCodeBlocks } from '../../../util/common/markdown';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { CodeBlock } from '../../prompts/node/panel/safeElements';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

interface IUpdateUserPreferencesToolParams {
	facts: string[];
}

interface IUserPreferenceUpdatePrompt extends BasePromptElementProps {
	facts: string[];
	userPreferenceFile: URI;
	currentContent: string;
}

class UserPreferenceUpdatePrompt extends PromptElement<IUserPreferenceUpdatePrompt> {
	constructor(props: IUserPreferenceUpdatePrompt) {
		super(props);
	}
	render() {
		const { userPreferenceFile, facts, currentContent } = this.props;

		return (
			<>
				<SystemMessage priority={1000}>
					You are an AI programming assistant. The user has provided new preferences to be added to their existing preferences file.<br />
					Please incorporate the following new preferences into the existing file content:<br />
					<CodeBlock uri={userPreferenceFile} code={facts.join('\n')} languageId='markdown' shouldTrim={false} includeFilepath={false} /><br />
					Ensure the final content is well-formatted and correctly indented.<br />
				</SystemMessage>
				<UserMessage priority={700}>
					<CodeBlock uri={userPreferenceFile} code={currentContent} languageId='markdown' shouldTrim={false} includeFilepath={false} /><br />
				</UserMessage>
			</>
		);
	}
}

class UpdateUserPreferencesTool implements ICopilotTool<IUpdateUserPreferencesToolParams> {

	public static readonly toolName = ToolName.UpdateUserPreferences;

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
	}

	private getEndpoint(): Proxy4oEndpoint {
		return this.instantiationService.createInstance(Proxy4oEndpoint);
	}

	private get userPreferenceFile(): URI {
		return URI.joinPath(this.extensionContext.globalStorageUri, 'copilotUserPreferences.md');
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IUpdateUserPreferencesToolParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult> {

		try {
			const currentContent = await this.fileSystemService.readFile(this.userPreferenceFile).catch(() => '');
			const newContent = await this.generateNewContent(currentContent.toString(), options.input.facts, token);
			await this.fileSystemService.writeFile(this.userPreferenceFile, Buffer.from(newContent));
			return new LanguageModelToolResult([
				new LanguageModelTextPart('User preferences updated')
			]);
		} catch (ex) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('Encountered an error while updating user preferences')
			]);
		}
	}

	private async generateNewContent(currentContent: string, facts: string[], token: CancellationToken): Promise<string> {
		const endpoint = this.getEndpoint();
		const { messages } = await renderPromptElement(this.instantiationService, endpoint, UserPreferenceUpdatePrompt, { facts: facts, currentContent, userPreferenceFile: this.userPreferenceFile }, undefined, token);
		return this.doFetch(messages, endpoint, currentContent, token);
	}

	private async doFetch(promptMessages: Raw.ChatMessage[], endpoint: IChatEndpoint, speculation: string, token: CancellationToken) {

		const result = await endpoint.makeChatRequest(
			'updateUserPreferences',
			promptMessages,
			async () => {
				return undefined;
			},
			token,
			ChatLocation.Other,
			undefined,
			{ stream: true, temperature: 0, prediction: { type: 'content', content: speculation } }
		);
		if (result.type !== ChatFetchResponseType.Success) {
			throw new Error('Failed to update user preferences');
		}
		return extractCodeBlocks(result.value)[0].code;
	}

	prepareInvocation?(options: vscode.LanguageModelToolInvocationPrepareOptions<IUpdateUserPreferencesToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: l10n.t`Updating user preferences`,
			pastTenseMessage: l10n.t`Updated user preferences`
		};
	}
}

ToolRegistry.registerTool(UpdateUserPreferencesTool);
