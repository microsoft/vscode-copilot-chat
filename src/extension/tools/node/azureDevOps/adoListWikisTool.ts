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

interface IAdoListWikisParams {
	project?: string;
}

class AdoListWikisTool implements ICopilotTool<IAdoListWikisParams> {

	public static readonly toolName = ToolName.AdoListWikis;

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAdoListWikisParams>, token: CancellationToken) {
		checkCancellation(token);

		if (!this.client.isConfigured()) {
			return new LanguageModelToolResult([new LanguageModelTextPart(
				'Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.'
			)]);
		}

		const wikis = await this.client.listWikis(options.input.project);
		checkCancellation(token);

		if (wikis.length === 0) {
			return new LanguageModelToolResult([new LanguageModelTextPart('No wikis found in this project.')]);
		}

		const lines = wikis.map(w => `- **${w.name}** (ID: ${w.id}, Type: ${w.type})`);
		return new LanguageModelToolResult([new LanguageModelTextPart(
			`Found ${wikis.length} wiki(s):\n\n${lines.join('\n')}`
		)]);
	}

	prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IAdoListWikisParams>, token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);
		return {
			invocationMessage: new MarkdownString(l10n.t`Listing Azure DevOps wikis`),
			pastTenseMessage: new MarkdownString(l10n.t`Listed Azure DevOps wikis`),
		};
	}
}

ToolRegistry.registerTool(AdoListWikisTool);
