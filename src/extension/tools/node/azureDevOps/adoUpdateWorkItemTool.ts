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
import { AzureDevOpsClient, WorkItemPatchOperation } from './azureDevOpsClient';

interface IAdoUpdateWorkItemParams {
	id: number;
	operations: WorkItemPatchOperation[];
}

class AdoUpdateWorkItemTool implements ICopilotTool<IAdoUpdateWorkItemParams> {

	public static readonly toolName = ToolName.AdoUpdateWorkItem;

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAdoUpdateWorkItemParams>, token: CancellationToken) {
		checkCancellation(token);

		if (!this.client.isConfigured()) {
			return new LanguageModelToolResult([new LanguageModelTextPart(
				'Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.'
			)]);
		}

		const workItem = await this.client.updateWorkItem(options.input.id, options.input.operations);
		checkCancellation(token);

		const formatted = this.client.formatWorkItem(workItem);
		return new LanguageModelToolResult([new LanguageModelTextPart(
			`Successfully updated work item ${workItem.id}:\n\n${formatted}`
		)]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IAdoUpdateWorkItemParams>, token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);

		const fieldSummary = options.input.operations.map(op => op.path.replace('/fields/', '')).join(', ');
		return {
			invocationMessage: new MarkdownString(l10n.t`Updating Azure DevOps work item #${options.input.id}`),
			pastTenseMessage: new MarkdownString(l10n.t`Updated Azure DevOps work item #${options.input.id}`),
			confirmationMessages: {
				title: l10n.t`Update Azure DevOps work item #${options.input.id}?`,
				message: new MarkdownString(l10n.t`This will modify fields: ${fieldSummary}`),
			},
		};
	}
}

ToolRegistry.registerTool(AdoUpdateWorkItemTool);
