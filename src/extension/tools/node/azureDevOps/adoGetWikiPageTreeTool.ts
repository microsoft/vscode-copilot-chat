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

interface IAdoGetWikiPageTreeParams {
	wikiIdentifier: string;
	path?: string;
}

class AdoGetWikiPageTreeTool implements ICopilotTool<IAdoGetWikiPageTreeParams> {

	public static readonly toolName = ToolName.AdoGetWikiPageTree;

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAdoGetWikiPageTreeParams>, token: CancellationToken) {
		checkCancellation(token);

		if (!this.client.isConfigured()) {
			return new LanguageModelToolResult([new LanguageModelTextPart(
				'Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.'
			)]);
		}

		const rootPath = options.input.path ?? '/';
		const tree = await this.client.getWikiPageTree(options.input.wikiIdentifier, rootPath);
		checkCancellation(token);

		const formatted = this.client.formatWikiPageTree(tree);
		return new LanguageModelToolResult([new LanguageModelTextPart(
			`# Wiki page tree: ${options.input.wikiIdentifier}\n\n\`\`\`\n${formatted}\`\`\``
		)]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IAdoGetWikiPageTreeParams>, token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);
		const path = options.input.path ?? '/';
		return {
			invocationMessage: new MarkdownString(l10n.t`Browsing wiki page tree from ${path}`),
			pastTenseMessage: new MarkdownString(l10n.t`Browsed wiki page tree from ${path}`),
		};
	}
}

ToolRegistry.registerTool(AdoGetWikiPageTreeTool);
