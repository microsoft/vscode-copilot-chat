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

interface IAdoGetWorkItemParams {
	id: number;
}

class AdoGetWorkItemTool implements ICopilotTool<IAdoGetWorkItemParams> {

	public static readonly toolName = ToolName.AdoGetWorkItem;

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAdoGetWorkItemParams>, token: CancellationToken) {
		checkCancellation(token);

		if (!this.client.isConfigured()) {
			return new LanguageModelToolResult([new LanguageModelTextPart(
				'Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.'
			)]);
		}

		const workItem = await this.client.getWorkItem(options.input.id);
		checkCancellation(token);

		const formatted = this.client.formatWorkItem(workItem);
		return new LanguageModelToolResult([new LanguageModelTextPart(formatted)]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IAdoGetWorkItemParams>, token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);
		return {
			invocationMessage: new MarkdownString(l10n.t`Fetching Azure DevOps work item #${options.input.id}`),
			pastTenseMessage: new MarkdownString(l10n.t`Fetched Azure DevOps work item #${options.input.id}`),
		};
	}
}

ToolRegistry.registerTool(AdoGetWorkItemTool);
