/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken, ChatCustomAgentProvider, ChatResource } from 'vscode';
import { AGENT_FILE_EXTENSION } from '../../../../platform/customInstructions/common/promptTypes';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../../platform/log/common/logService';
import { Emitter } from '../../../../util/vs/base/common/event';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { Uri } from '../../../../vscodeTypes';
import { AgentConfig, buildAgentMarkdown } from '../../vscode-node/agentTypes';


/**
 * Base Plan agent configuration - embedded from Plan.agent.md
 * This avoids runtime file loading and YAML parsing dependencies.
 */
const BASE_PLAN_AGENT_CONFIG: AgentConfig = {
	name: 'Plan',
	description: 'Github Copilot CLI Plan agent',
	argumentHint: 'Outline the goal or problem to research',
	target: 'github-copilot',
	agents: [], // Explore agent added dynamically when exploreSubagentEnabled
	tools: [],
	handoffs: [], // Handoffs are generated dynamically in buildCustomizedConfig
	body: 'Plan model is configured and defined within Github Copilot CLI' // Body is generated dynamically in buildCustomizedConfig
};

/**
 * Provides the Plan agent dynamically with settings-based customization.
 *
 * This provider uses an embedded configuration and generates .agent.md content
 * with settings-based customization (additional tools and model override).
 * No external file loading or YAML parsing dependencies required.
 */
export class PlanAgentProvider extends Disposable implements ChatCustomAgentProvider {
	private static readonly CACHE_DIR = 'plan-agent-v2';
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
		const content = buildAgentMarkdown(BASE_PLAN_AGENT_CONFIG);

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
