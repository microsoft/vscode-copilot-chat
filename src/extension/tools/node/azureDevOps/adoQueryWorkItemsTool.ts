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

interface IAdoQueryWorkItemsParams {
	wiql: string;
	project?: string;
	top?: number;
}

class AdoQueryWorkItemsTool implements ICopilotTool<IAdoQueryWorkItemsParams> {

	public static readonly toolName = ToolName.AdoQueryWorkItems;

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAdoQueryWorkItemsParams>, token: CancellationToken) {
		checkCancellation(token);

		if (!this.client.isConfigured()) {
			return new LanguageModelToolResult([new LanguageModelTextPart(
				'Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.'
			)]);
		}

		const top = options.input.top ?? 20;
		const queryResult = await this.client.queryWorkItems(options.input.wiql, options.input.project, top);
		checkCancellation(token);

		if (queryResult.workItems.length === 0) {
			return new LanguageModelToolResult([new LanguageModelTextPart('No work items found matching the query.')]);
		}

		const ids = queryResult.workItems.map(wi => wi.id);
		const workItems = await this.client.getWorkItems(ids, options.input.project);
		checkCancellation(token);

		const formatted = workItems.map(wi => this.client.formatWorkItem(wi)).join('\n---\n\n');
		return new LanguageModelToolResult([new LanguageModelTextPart(
			`Found ${workItems.length} work item(s):\n\n${formatted}`
		)]);
	}

	prepareInvocation(_options: vscode.LanguageModelToolInvocationPrepareOptions<IAdoQueryWorkItemsParams>, token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);
		return {
			invocationMessage: new MarkdownString(l10n.t`Querying Azure DevOps work items`),
			pastTenseMessage: new MarkdownString(l10n.t`Queried Azure DevOps work items`),
		};
	}
}

ToolRegistry.registerTool(AdoQueryWorkItemsTool);
