/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, type CancellationToken, type ChatCustomAgentProvider, type ChatRequestModeInstructions, type ChatResource } from 'vscode';
import { AGENT_FILE_EXTENSION } from '../../../platform/customInstructions/common/promptTypes';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

const planPrompt = `Plan model is configured and defined within Github Copilot CLI`;

export function isCopilotCLIPlanAgent(mode: ChatRequestModeInstructions) {
	return mode.name.toLowerCase() === 'plan' && mode.content.trim().includes(planPrompt.trim());
}

export class PlanAgentProvider extends Disposable implements ChatCustomAgentProvider {
	private static readonly CACHE_DIR = 'github.copilotcli';
	private static readonly AGENT_FILENAME = `Plan${AGENT_FILE_EXTENSION}`;

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
name: Plan
description: Github Copilot CLI Plan agent
target: github-copilot
---
${planPrompt}
For more details on Plan mode, see https://github.blog/changelog/2026-01-21-github-copilot-cli-plan-before-you-build-steer-as-you-go/#plan-mode`;

		// Write to cache file and return URI
		const fileUri = await this.writeCacheFile(content);
		return [{ uri: fileUri }];
	}

	private async writeCacheFile(content: string): Promise<Uri> {
		const cacheDir = Uri.joinPath(
			this.extensionContext.globalStorageUri,
			PlanAgentProvider.CACHE_DIR
		);

		// Ensure cache directory exists
		try {
			await this.fileSystemService.stat(cacheDir);
		} catch {
			await this.fileSystemService.createDirectory(cacheDir);
		}

		const fileUri = Uri.joinPath(cacheDir, PlanAgentProvider.AGENT_FILENAME);
		await this.fileSystemService.writeFile(fileUri, new TextEncoder().encode(content));
		this.logService.trace(`[PlanAgentProvider] Wrote agent file: ${fileUri.toString()}`);
		return fileUri;
	}
}
