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

interface IAdoAddCommentParams {
	workItemId: number;
	text: string;
}

class AdoAddCommentTool implements ICopilotTool<IAdoAddCommentParams> {

	public static readonly toolName = ToolName.AdoAddComment;

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAdoAddCommentParams>, token: CancellationToken) {
		checkCancellation(token);

		if (!this.client.isConfigured()) {
			return new LanguageModelToolResult([new LanguageModelTextPart(
				'Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.'
			)]);
		}

		const comment = await this.client.addComment(options.input.workItemId, options.input.text);
		checkCancellation(token);

		return new LanguageModelToolResult([new LanguageModelTextPart(
			`Comment added to work item ${options.input.workItemId} by ${comment.createdBy.displayName}.`
		)]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IAdoAddCommentParams>, token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);

		const preview = options.input.text.length > 80
			? options.input.text.substring(0, 80) + '...'
			: options.input.text;
		return {
			invocationMessage: new MarkdownString(l10n.t`Adding comment to Azure DevOps work item #${options.input.workItemId}`),
			pastTenseMessage: new MarkdownString(l10n.t`Added comment to Azure DevOps work item #${options.input.workItemId}`),
			confirmationMessages: {
				title: l10n.t`Add comment to work item #${options.input.workItemId}?`,
				message: new MarkdownString(l10n.t`Comment: ${preview}`),
			},
		};
	}
}

ToolRegistry.registerTool(AdoAddCommentTool);
