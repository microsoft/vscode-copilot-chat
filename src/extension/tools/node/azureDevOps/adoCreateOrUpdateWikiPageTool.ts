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

interface IAdoCreateOrUpdateWikiPageParams {
	wikiIdentifier: string;
	path: string;
	content: string;
	project?: string;
}

class AdoCreateOrUpdateWikiPageTool implements ICopilotTool<IAdoCreateOrUpdateWikiPageParams> {

	public static readonly toolName = ToolName.AdoCreateOrUpdateWikiPage;

	private readonly client: AzureDevOpsClient;

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService,
	) {
		this.client = new AzureDevOpsClient(configurationService, logService);
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IAdoCreateOrUpdateWikiPageParams>, token: CancellationToken) {
		checkCancellation(token);

		if (!this.client.isConfigured()) {
			return new LanguageModelToolResult([new LanguageModelTextPart(
				'Azure DevOps is not configured. Set yourcompany.ado.orgUrl and yourcompany.ado.pat in VS Code settings.'
			)]);
		}

		// Try to fetch existing page to get ETag for update
		let etag: string | undefined;
		try {
			const existing = await this.client.getWikiPage(options.input.wikiIdentifier, options.input.path, options.input.project);
			etag = existing.etag;
		} catch {
			// Page doesn't exist yet — create without ETag
		}

		checkCancellation(token);

		const page = await this.client.createOrUpdateWikiPage(
			options.input.wikiIdentifier,
			options.input.path,
			options.input.content,
			etag,
			options.input.project,
		);
		checkCancellation(token);

		const action = etag ? 'Updated' : 'Created';
		return new LanguageModelToolResult([new LanguageModelTextPart(
			`${action} wiki page "${page.path}" in wiki "${options.input.wikiIdentifier}".`
		)]);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IAdoCreateOrUpdateWikiPageParams>, token: CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);

		const contentPreview = options.input.content.length > 100
			? options.input.content.substring(0, 100) + '...'
			: options.input.content;

		return {
			invocationMessage: new MarkdownString(l10n.t`Writing wiki page ${options.input.path}`),
			pastTenseMessage: new MarkdownString(l10n.t`Wrote wiki page ${options.input.path}`),
			confirmationMessages: {
				title: l10n.t`Write to wiki page "${options.input.path}" in "${options.input.wikiIdentifier}"?`,
				message: new MarkdownString(l10n.t`Content preview:\n\n${contentPreview}`),
			},
		};
	}
}

ToolRegistry.registerTool(AdoCreateOrUpdateWikiPageTool);
