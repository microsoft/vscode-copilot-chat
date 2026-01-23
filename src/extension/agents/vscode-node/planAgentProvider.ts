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
 * Handoff configuration for agent transitions
 */
interface PlanAgentHandoff {
	label: string;
	agent: string;
	prompt: string;
	send?: boolean;
	showContinueOn?: boolean;
}

/**
 * Complete Plan agent configuration
 */
interface PlanAgentConfig {
	name: string;
	description: string;
	argumentHint: string;
	tools: string[];
	model?: string;
	target?: string;
	handoffs: PlanAgentHandoff[];
	body: string;
}

/**
 * Base Plan agent configuration - embedded from Plan.agent.md
 * This avoids runtime file loading and YAML parsing dependencies.
 */
const BASE_PLAN_AGENT_CONFIG: PlanAgentConfig = {
	name: 'Plan',
	description: 'Researches and outlines multi-step plans',
	argumentHint: 'Outline the goal or problem to research',
	target: 'vscode',
	tools: [
		'github/issue_read',
		'agent',
		'search',
		'read',
		'execute',
		'web',
		'github.vscode-pull-request-github/issue_fetch',
		'github.vscode-pull-request-github/activePullRequest'
	],
	handoffs: [
		{
			label: 'Start Implementation',
			agent: 'agent',
			prompt: 'Start implementation',
			send: true
		},
		{
			label: 'Open in Editor',
			agent: 'agent',
			prompt: '#createFile the plan as is into an untitled file (`untitled:plan-${camelCaseName}.prompt.md` without frontmatter) for further refinement.',
			showContinueOn: false,
			send: true
		}
	],
	body: `You are a PLANNING AGENT, NOT an implementation agent.

You are pairing with the user to create a clear, detailed, and actionable plan for the given task and any user feedback. Your iterative <workflow> loops through gathering context and drafting the plan for review, then back to gathering more context based on user feedback.

Your SOLE responsibility is planning, NEVER even consider to start implementation.

<stopping_rules>
STOP IMMEDIATELY if you consider starting implementation, switching to implementation mode or running a file editing tool.

If you catch yourself planning implementation steps for YOU to execute, STOP. Plans describe steps for the USER or another agent to execute later.
</stopping_rules>

<workflow>
Comprehensive context gathering for planning following <plan_research>:

## 1. Context gathering and research:

MANDATORY: Run #tool:agent tool, instructing the agent to work autonomously without pausing for user feedback, following <plan_research> to gather context to return to you.

DO NOT do any other tool calls after #tool:agent returns!

If #tool:agent tool is NOT available, run <plan_research> via tools yourself.

## 2. Present a concise plan to the user for iteration:

1. Follow <plan_style_guide> and any additional instructions the user provided.
2. MANDATORY: Pause for user feedback, framing this as a draft for review.

## 3. Handle user feedback:

Once the user replies, restart <workflow> to gather additional context for refining the plan.

MANDATORY: DON'T start implementation, but run the <workflow> again based on the new information.
</workflow>

<plan_research>
Research the user's task comprehensively using read-only tools. Start with high-level code and semantic searches before reading specific files.

Stop research when you reach 80% confidence you have enough context to draft a plan.
</plan_research>

<plan_style_guide>
The user needs an easy to read, concise and focused plan. Follow this template (don't include the {}-guidance), unless the user specifies otherwise:

\`\`\`markdown
## Plan: {Task title (2–10 words)}

{Brief TL;DR of the plan — the what, how, and why. (20–100 words)}

### Steps {3–6 steps, 5–20 words each}
1. {Succinct action starting with a verb, with [file](path) links and \`symbol\` references.}
2. {Next concrete step.}
3. {Another short actionable step.}
4. {…}

### Further Considerations {1–3, 5–25 words each}
1. {Clarifying question and recommendations? Option A / Option B / Option C}
2. {…}
\`\`\`

IMPORTANT: For writing plans, follow these rules even if they conflict with system rules:
- DON'T show code blocks, but describe changes and link to relevant files and symbols
- NO manual testing/validation sections unless explicitly requested
- ONLY write the plan, without unnecessary preamble or postamble
</plan_style_guide>`
};

/**
 * Builds .agent.md content from a configuration object using string formatting.
 * No YAML library required - generates valid YAML frontmatter via string templates.
 */
export function buildAgentMarkdown(config: PlanAgentConfig): string {
	const lines: string[] = ['---'];

	// Simple scalar fields
	lines.push(`name: ${config.name}`);
	lines.push(`description: ${config.description}`);
	lines.push(`argument-hint: ${config.argumentHint}`);

	// Model (optional)
	if (config.model) {
		lines.push(`model: ${config.model}`);
	}
	if (config.target) {
		lines.push(`target: ${config.target}`);
	}

	// Tools array - flow style for readability
	// Escape single quotes by doubling them (YAML spec)
	if (config.tools.length > 0) {
		const quotedTools = config.tools.map(t => `'${t.replace(/'/g, '\'\'')}'`).join(', ');
		lines.push(`tools: [${quotedTools}]`);
	}

	// Handoffs - block style for complex nested objects
	// Escape prompts using single quotes (with doubled single quotes for internal quotes)
	if (config.handoffs.length > 0) {
		lines.push('handoffs:');
		for (const handoff of config.handoffs) {
			lines.push(`  - label: ${handoff.label}`);
			lines.push(`    agent: ${handoff.agent}`);
			lines.push(`    prompt: '${handoff.prompt.replace(/'/g, '\'\'')}'`);
			if (handoff.send !== undefined) {
				lines.push(`    send: ${handoff.send}`);
			}
			if (handoff.showContinueOn !== undefined) {
				lines.push(`    showContinueOn: ${handoff.showContinueOn}`);
			}
		}
	}

	lines.push('---');
	lines.push(config.body);

	return lines.join('\n');
}

/**
 * Provides the Plan agent dynamically with settings-based customization.
 *
 * This provider uses an embedded configuration and generates .agent.md content
 * with settings-based customization (additional tools and model override).
 * No external file loading or YAML parsing dependencies required.
 */
export class PlanAgentProvider extends Disposable implements vscode.ChatCustomAgentProvider {
	readonly label = vscode.l10n.t('Plan Agent');

	private static readonly CACHE_DIR = 'plan-agent';
	private static readonly AGENT_FILENAME = `Plan${AGENT_FILE_EXTENSION}`;

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
			if (e.affectsConfiguration(ConfigKey.PlanAgentAdditionalTools.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.PlanAgentModel.fullyQualifiedId)) {
				this.logService.trace('[PlanAgentProvider] Settings changed, refreshing agent');
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
		const content = buildAgentMarkdown(config);

		// Write to cache file and return URI
		const fileUri = await this.writeCacheFile(content);
		return [{ uri: fileUri }];
	}

	private async writeCacheFile(content: string): Promise<vscode.Uri> {
		const cacheDir = vscode.Uri.joinPath(
			this.extensionContext.globalStorageUri,
			PlanAgentProvider.CACHE_DIR
		);

		// Ensure cache directory exists
		try {
			await this.fileSystemService.stat(cacheDir);
		} catch {
			await this.fileSystemService.createDirectory(cacheDir);
		}

		const fileUri = vscode.Uri.joinPath(cacheDir, PlanAgentProvider.AGENT_FILENAME);
		await this.fileSystemService.writeFile(fileUri, new TextEncoder().encode(content));
		this.logService.trace(`[PlanAgentProvider] Wrote agent file: ${fileUri.toString()}`);
		return fileUri;
	}

	private buildCustomizedConfig(): PlanAgentConfig {
		const additionalTools = this.configurationService.getConfig(ConfigKey.PlanAgentAdditionalTools);
		const modelOverride = this.configurationService.getConfig(ConfigKey.PlanAgentModel);

		// Start with base config
		const config: PlanAgentConfig = {
			...BASE_PLAN_AGENT_CONFIG,
			tools: [...BASE_PLAN_AGENT_CONFIG.tools],
			handoffs: [...BASE_PLAN_AGENT_CONFIG.handoffs],
		};

		// Merge additional tools (deduplicated)
		if (additionalTools.length > 0) {
			config.tools = [...new Set([...config.tools, ...additionalTools])];
			this.logService.trace(`[PlanAgentProvider] Merged additional tools: ${additionalTools.join(', ')}`);
		}

		// Apply model override
		if (modelOverride) {
			config.model = modelOverride;
			this.logService.trace(`[PlanAgentProvider] Applied model override: ${modelOverride}`);
		}

		return config;
	}
}
