/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IRunCommandExecutionService } from '../../../platform/commands/common/runCommandExecutionService';
import { ResourceSet } from '../../../util/vs/base/common/map';
import { Schemas } from '../../../util/vs/base/common/network';
import { URI } from '../../../util/vs/base/common/uri';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';


export interface ISimpleBrowserParams {
	url: string;
}

export class SimpleBrowserTool implements ICopilotTool<ISimpleBrowserParams> {
	public static toolName = ToolName.SimpleBrowser;
	private _alreadyApprovedDomains = new ResourceSet();

	constructor(
		@IRunCommandExecutionService private readonly commandService: IRunCommandExecutionService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ISimpleBrowserParams>, token: vscode.CancellationToken) {
		const uri = URI.parse(options.input.url);
		this._alreadyApprovedDomains.add(uri);
		this.commandService.executeCommand('simpleBrowser.show', options.input.url);
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				l10n.t('Simple Browser opened at {0}', options.input.url),
			)
		]);
	}

	async resolveInput(input: ISimpleBrowserParams, promptContext: IBuildPromptContext): Promise<ISimpleBrowserParams> {
		return input;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ISimpleBrowserParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const uri = URI.parse(options.input.url);
		if (uri.scheme !== Schemas.http && uri.scheme !== Schemas.https) {
			throw new Error(l10n.t('Invalid URL scheme. Only HTTP and HTTPS are supported.'));
		}

		const urlsNeedingConfirmation = !this._alreadyApprovedDomains.has(uri);
		let confirmationMessages: vscode.LanguageModelToolConfirmationMessages | undefined;
		if (urlsNeedingConfirmation) {
			confirmationMessages = { title: l10n.t`Open untrusted web page?`, message: new MarkdownString(l10n.t`${options.input.url}`) };
		}

		return {
			invocationMessage: new MarkdownString(l10n.t`Opening Simple Browser at ${options.input.url}`),
			pastTenseMessage: new MarkdownString(l10n.t`Opened Simple Browser at ${options.input.url}`),
			confirmationMessages
		};
	}
}

ToolRegistry.registerTool(SimpleBrowserTool);
