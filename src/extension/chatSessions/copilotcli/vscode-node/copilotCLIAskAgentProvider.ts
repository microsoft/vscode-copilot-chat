/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, type CancellationToken, type ChatCustomAgentProvider, type ChatRequestModeInstructions, type ChatResource } from 'vscode';
import { AGENT_FILE_EXTENSION } from '../../../../platform/customInstructions/common/promptTypes';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { buildAskAgentBody } from '../../../agents/vscode-node/askAgentProvider';


const planPrompt = buildAskAgentBody('Ask user tool');

export function isCopilotCLIPlanAgent(mode: ChatRequestModeInstructions) {
	return mode.name.toLowerCase() === 'plan' && mode.content.trim().includes(planPrompt.trim());
}

export class AskAgentProvider extends Disposable implements ChatCustomAgentProvider {
	private static readonly CACHE_DIR = 'github.copilotcli';
	private static readonly AGENT_FILENAME = `Ask${AGENT_FILE_EXTENSION}`;

	private readonly _onDidChangeCustomAgents = this._register(new Emitter<void>());
	readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async provideCustomAgents(
		_context: unknown,
		_token: CancellationToken
	): Promise<ChatResource[]> {
		// Generate .agent.md content
		const content = `---
name: Ask
description: Answers questions without making changes
argumentHint: Ask a question about your code or project
disableModelInvocation: true
tools: ['read', 'subagents', 'skills', 'web', 'ask-user', 'agent', 'search' ]
target: github-copilot
---
${planPrompt}`;

		// Write to cache file and return URI
		const fileUri = await this.writeCacheFile(content);
		return [{ uri: fileUri }];
	}

	private async writeCacheFile(content: string): Promise<Uri> {
		const cacheDir = Uri.joinPath(
			this.extensionContext.globalStorageUri,
			AskAgentProvider.CACHE_DIR
		);

		// Ensure cache directory exists
		try {
			await this.fileSystemService.stat(cacheDir);
		} catch {
			await this.fileSystemService.createDirectory(cacheDir);
		}

		const fileUri = Uri.joinPath(cacheDir, AskAgentProvider.AGENT_FILENAME);
		await this.fileSystemService.writeFile(fileUri, new TextEncoder().encode(content));
		this.logService.trace(`[AskAgentProvider] Wrote agent file: ${fileUri.toString()}`);
		return fileUri;
	}
}
