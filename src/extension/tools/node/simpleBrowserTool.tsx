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
import { encodeUrlHostname } from '../common/toolUtils';


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
		const { encoded: encodedUrl } = encodeUrlHostname(options.input.url);
		const uri = URI.parse(encodedUrl);
		this._alreadyApprovedDomains.add(uri);
		this.commandService.executeCommand('simpleBrowser.show', encodedUrl);
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				l10n.t('Simple Browser opened at {0}', encodedUrl),
			)
		]);
	}

	async resolveInput(input: ISimpleBrowserParams, promptContext: IBuildPromptContext): Promise<ISimpleBrowserParams> {
		return input;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ISimpleBrowserParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const { encoded: encodedUrl, isDifferent } = encodeUrlHostname(options.input.url);
		const uri = URI.parse(encodedUrl);
		if (uri.scheme !== Schemas.http && uri.scheme !== Schemas.https) {
			throw new Error(l10n.t('Invalid URL scheme. Only HTTP and HTTPS are supported.'));
		}

		const urlsNeedingConfirmation = !this._alreadyApprovedDomains.has(uri);
		let confirmationMessages: vscode.LanguageModelToolConfirmationMessages | undefined;
		if (urlsNeedingConfirmation) {
			const displayUrl = isDifferent ? `${encodedUrl} (${options.input.url})` : encodedUrl;
			confirmationMessages = { title: l10n.t`Open untrusted web page?`, message: new MarkdownString(l10n.t`${displayUrl}`) };
		}

		return {
			invocationMessage: new MarkdownString(l10n.t`Opening Simple Browser at ${encodedUrl}`),
			pastTenseMessage: new MarkdownString(l10n.t`Opened Simple Browser at ${encodedUrl}`),
			confirmationMessages
		};
	}
}

ToolRegistry.registerTool(SimpleBrowserTool);
