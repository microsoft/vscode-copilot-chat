/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { AGENT_FILE_EXTENSION } from '../../../platform/customInstructions/common/promptTypes';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

/**
 * Complete Implement agent configuration
 */
interface ImplementAgentConfig {
	name: string;
	description: string;
	model?: string;
	body: string;
}

/**
 * Base Implement agent configuration - embedded from Implement.agent.md
 * This avoids runtime file loading and YAML parsing dependencies.
 */
const BASE_IMPLEMENT_AGENT_CONFIG: ImplementAgentConfig = {
	name: 'Implement',
	description: 'Executes an existing plan',
	body: `You are an IMPLEMENTATION AGENT.

You receive a plan that has already been created by the user or a planning agent. Your role is to carry out that plan by executing its steps in order.

Focus on implementation, not planning or redesigning. Follow the plan as written and aim to achieve its intended outcome.

If the plan is unclear or cannot be followed as written, pause and ask for clarification

You are successful when the plan's stated outcome is achieved, with **no unrequested changes**.

## Guidelines
- Follow the plan's steps in sequence
- Complete each step before moving to the next
- Avoid introducing new scope or features
- Limit changes to what is necessary to implement the plan

<stopping_rules>
Stop implementation and hand back to **Plan** if:
- Required information or files are missing
- A step cannot be completed as described
- You need to make a significant decision not covered by the plan
</stopping_rules>

<implement_style_guide>
- Be concise and practical
- Explain actions briefly when helpful
- Summarize changes at the end if appropriate

Your tone should reflect: **"I am implementing the plan."**
</implement_style_guide>`
};

/**
 * Builds .agent.md content from a configuration object using string formatting.
 */
export function buildImplementAgentMarkdown(config: ImplementAgentConfig): string {
	const lines: string[] = ['---'];

	// Simple scalar fields
	lines.push(`name: ${config.name}`);
	lines.push(`description: ${config.description}`);

	// Model (optional)
	if (config.model) {
		lines.push(`model: ${config.model}`);
	}

	lines.push('---');
	lines.push(config.body);

	return lines.join('\n');
}

/**
 * Provides the Implement agent dynamically with settings-based customization.
 *
 * This provider uses an embedded configuration and generates .agent.md content
 * with settings-based customization (model override).
 */
export class ImplementAgentProvider extends Disposable implements vscode.ChatCustomAgentProvider {
	readonly label = vscode.l10n.t('Implement Agent');

	private static readonly CACHE_DIR = 'implement-agent';
	private static readonly AGENT_FILENAME = `Implement${AGENT_FILE_EXTENSION}`;

	private readonly _onDidChangeCustomAgents = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Listen for settings changes to refresh agents
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.ImplementAgentModel.fullyQualifiedId)) {
				this.logService.trace('[ImplementAgentProvider] Settings changed, refreshing agent');
				this._onDidChangeCustomAgents.fire();
			}
		}));
	}

	async provideCustomAgents(
		_context: unknown,
		_token: vscode.CancellationToken
	): Promise<vscode.ChatResource[]> {
		// Build config with settings-based customization
		const config = this.buildCustomizedConfig();

		// Generate .agent.md content
		const content = buildImplementAgentMarkdown(config);

		// Write to cache file and return URI
		const fileUri = await this.writeCacheFile(content);
		return [{ uri: fileUri }];
	}

	private async writeCacheFile(content: string): Promise<vscode.Uri> {
		const cacheDir = vscode.Uri.joinPath(
			this.extensionContext.globalStorageUri,
			ImplementAgentProvider.CACHE_DIR
		);

		// Ensure cache directory exists
		try {
			await this.fileSystemService.stat(cacheDir);
		} catch {
			await this.fileSystemService.createDirectory(cacheDir);
		}

		const fileUri = vscode.Uri.joinPath(cacheDir, ImplementAgentProvider.AGENT_FILENAME);
		await this.fileSystemService.writeFile(fileUri, new TextEncoder().encode(content));
		this.logService.trace(`[ImplementAgentProvider] Wrote agent file: ${fileUri.toString()}`);
		return fileUri;
	}

	private buildCustomizedConfig(): ImplementAgentConfig {
		const modelOverride = this.configurationService.getConfig(ConfigKey.ImplementAgentModel);

		// Start with base config
		const config: ImplementAgentConfig = {
			...BASE_IMPLEMENT_AGENT_CONFIG,
		};

		// Apply model override
		if (modelOverride) {
			config.model = modelOverride;
			this.logService.trace(`[ImplementAgentProvider] Applied model override: ${modelOverride}`);
		}

		return config;
	}
}
