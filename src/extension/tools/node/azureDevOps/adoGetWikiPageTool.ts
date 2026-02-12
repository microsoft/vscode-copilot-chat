/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../../vscodeTypes';
import { ToolName } from '../../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../common/toolsRegistry';
import { checkCancellation } from '../toolUtils';
import { AzureDevOpsClient } from './azureDevOpsClient';

interface IAdoGetWikiPageParams {
	wikiIdentifier: string;
	path: string;
}

class AdoGetWikiPageTool implements ICopilotTool<IAdoGetWikiPageParams> {

	public static readonly toolName = ToolName.AdoGetWikiPage;

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAdoGetWikiPageParams>, token: CancellationToken) {
		checkCancellation(token);

		if (!this.client.isConfigured()) {
			return new LanguageModelToolResult([new LanguageModelTextPart(
				'Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.'
			)]);
		}

		const page = await this.client.getWikiPage(options.input.wikiIdentifier, options.input.path);
		checkCancellation(token);

		const content = page.content ?? '(empty page)';
		const subPagesInfo = page.subPages?.length
			? `\n\n**Sub-pages:**\n${page.subPages.map(sp => `- ${sp.path}`).join('\n')}`
			: '';

		return new LanguageModelToolResult([new LanguageModelTextPart(
			`# Wiki: ${options.input.wikiIdentifier} - ${page.path}\n\n${content}${subPagesInfo}`
		)]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IAdoGetWikiPageParams>, token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);
		return {
			invocationMessage: new MarkdownString(l10n.t`Reading wiki page ${options.input.path}`),
			pastTenseMessage: new MarkdownString(l10n.t`Read wiki page ${options.input.path}`),
		};
	}
}

ToolRegistry.registerTool(AdoGetWikiPageTool);
