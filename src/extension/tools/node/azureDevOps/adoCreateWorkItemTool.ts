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

interface IAdoCreateWorkItemParams {
	workItemType: string;
	fields: { path: string; value: unknown }[];
	project?: string;
}

class AdoCreateWorkItemTool implements ICopilotTool<IAdoCreateWorkItemParams> {

	public static readonly toolName = ToolName.AdoCreateWorkItem;

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAdoCreateWorkItemParams>, token: CancellationToken) {
		checkCancellation(token);

		if (!this.client.isConfigured()) {
			return new LanguageModelToolResult([new LanguageModelTextPart(
				'Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.'
			)]);
		}

		const operations: WorkItemPatchOperation[] = options.input.fields.map(f => ({
			op: 'add' as const,
			path: f.path,
			value: f.value,
		}));

		const workItem = await this.client.createWorkItem(options.input.workItemType, operations, options.input.project);
		checkCancellation(token);

		const formatted = this.client.formatWorkItem(workItem);
		return new LanguageModelToolResult([new LanguageModelTextPart(
			`Successfully created work item ${workItem.id}:\n\n${formatted}`
		)]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IAdoCreateWorkItemParams>, token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);

		const titleField = options.input.fields.find(f => f.path === '/fields/System.Title');
		const title = titleField ? String(titleField.value) : 'New item';
		return {
			invocationMessage: new MarkdownString(l10n.t`Creating Azure DevOps ${options.input.workItemType}`),
			pastTenseMessage: new MarkdownString(l10n.t`Created Azure DevOps ${options.input.workItemType}`),
			confirmationMessages: {
				title: l10n.t`Create Azure DevOps ${options.input.workItemType}?`,
				message: new MarkdownString(l10n.t`Title: ${title}`),
			},
		};
	}
}

ToolRegistry.registerTool(AdoCreateWorkItemTool);
