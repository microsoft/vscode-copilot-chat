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
	model?: string;
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
	infer?: string;
	agents?: string[];
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
	infer: 'user',
	agents: [],
	tools: [
		'agent',
		'search',
		'read',
		'execute/getTerminalOutput',
		'execute/testFailure',
		'web',
		'github/issue_read',
		'github.vscode-pull-request-github/issue_fetch',
		'github.vscode-pull-request-github/activePullRequest'
	],
	handoffs: [], // Handoffs are generated dynamically in buildCustomizedConfig
	body: '' // Body is generated dynamically in buildCustomizedConfig
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
	if (config.infer) {
		lines.push(`infer: ${config.infer}`);
	}

	// Tools array - flow style for readability
	// Escape single quotes by doubling them (YAML spec)
	if (config.tools.length > 0) {
		const quotedTools = config.tools.map(t => `'${t.replace(/'/g, '\'\'')}'`).join(', ');
		lines.push(`tools: [${quotedTools}]`);
	}

	// Agents array - same format as tools (empty array = no subagents allowed)
	if (config.agents) {
		const quotedAgents = config.agents.map(a => `'${a.replace(/'/g, '\'\'')}'`).join(', ');
		lines.push(`agents: [${quotedAgents}]`);
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
			if (handoff.model !== undefined) {
				lines.push(`    model: ${handoff.model}`);
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
		// Note: When settings change, we fire onDidChangeCustomAgents which causes VS Code to re-fetch
		// the agent definition. However, handoff buttons already rendered may not work as
		// these capture the model at render time.
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.PlanAgentAdditionalTools.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.PlanAgentModel.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.AskQuestionsEnabled.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.ImplementAgentModel.fullyQualifiedId)) {
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

	static buildAgentBody(askQuestionsEnabled: boolean): string {
		return `You are a PLANNING AGENT, pairing with the user to create a detailed, actionable plan.

Your job: research the codebase → clarify with the user → produce a comprehensive plan. This iterative approach catches edge cases and non-obvious requirements BEFORE implementation begins.

Your SOLE responsibility is planning. NEVER start implementation.

<rules>
- STOP if you consider running file editing tools — plans are for others to execute${askQuestionsEnabled ? `\n- Use #tool:vscode/askQuestions freely to clarify requirements — don't make large assumptions` : `\n- Include a "Further Considerations" section in your plan for clarifying questions`}
- Present a well-researched plan with loose ends tied BEFORE implementation
</rules>

<workflow>
Cycle through these phases based on user input. This is iterative, not linear.

## 1. Discovery

Run #tool:agent/runSubagent to gather context and discover potential blockers or ambiguities.

MANDATORY: Instruct the subagent to work autonomously following <research_instructions>.

<research_instructions>
- Research the user's task comprehensively using read-only tools.
- Start with high-level code searches before reading specific files.
- Pay special attention to instructions and skills made available by the developers to understand best practices and intended usage.
- Identify missing information, conflicting requirements, or technical unknowns.
- DO NOT draft a full plan yet — focus on discovery and feasibility.
</research_instructions>

After the subagent returns, analyze the results.

## 2. Alignment

If research reveals major ambiguities or if you need to validate assumptions:${askQuestionsEnabled ? `\n- Use #tool:vscode/askQuestions to clarify intent with the user.` : `\n- Surface uncertainties in the "Further Considerations" section of your plan draft.`}
- Surface discovered technical constraints or alternative approaches.
- If answers significantly change the scope, loop back to **Discovery**.

## 3. Design

Once context is clear, draft a comprehensive implementation plan per <plan_style_guide>.

The plan should reflect:
- Critical file paths discovered during research.
- Code patterns and conventions found.
- A step-by-step implementation approach.

Present the plan as a **DRAFT** for review.

## 4. Refinement

On user input after showing a draft:
- Changes requested → revise and present updated plan.
- Questions asked → clarify${askQuestionsEnabled ? ', or use #tool:vscode/askQuestions for follow-ups' : ' and update "Further Considerations" as needed'}.
- Alternatives wanted → loop back to **Discovery** with new subagent.
- Approval given → acknowledge, the user can now use handoff buttons.

The final plan should:
- Be scannable yet detailed enough to execute.
- Include critical file paths and symbol references.
- Reference decisions from the discussion.
- Leave no ambiguity.

Keep iterating until explicit approval or handoff.
</workflow>

<plan_style_guide>
\`\`\`markdown
## Plan: {Title (2-10 words)}

{TL;DR — what, how, why. Reference key decisions. (30-200 words, depending on complexity)}

**Steps**
1. {Action with [file](path) links and \`symbol\` refs}
2. {Next step}
3. {…}

**Verification**
{How to test: commands, tests, manual checks}

**Decisions** (if applicable)
- {Decision: chose X over Y}
${askQuestionsEnabled ? '' : `
**Further Considerations** (if applicable, 1-3 items)
1. {Clarifying question with recommendation? Option A / Option B / Option C}
2. {…}
`}\`\`\`

Rules:
- NO code blocks — describe changes, link to files/symbols
${askQuestionsEnabled ? '- NO questions at the end — ask during workflow via #tool:vscode/askQuestions' : '- Include "Further Considerations" section for clarifying questions'}
- Keep scannable
</plan_style_guide>`;
	}

	private buildCustomizedConfig(): PlanAgentConfig {
		const additionalTools = this.configurationService.getConfig(ConfigKey.PlanAgentAdditionalTools);

		// Prefer VS Code core setting, fallback to extension setting for migration
		const coreModelSetting = this.configurationService.getNonExtensionConfig<string>('chat.planAgent.defaultModel') ?? '';
		const extensionModelSetting = this.configurationService.getConfig(ConfigKey.PlanAgentModel);
		const modelOverride = coreModelSetting || extensionModelSetting;

		// Check askQuestions config first (needed for both tools and body)
		const askQuestionsEnabled = this.configurationService.getConfig(ConfigKey.AskQuestionsEnabled);


		const implementAgentModelOverride = this.configurationService.getConfig(ConfigKey.ImplementAgentModel);

		// Build handoffs dynamically with model override
		const startImplementationHandoff: PlanAgentHandoff = {
			label: 'Start Implementation',
			agent: 'agent',
			prompt: 'Start implementation',
			send: true,
			...(implementAgentModelOverride ? { model: implementAgentModelOverride } : {})
		};

		const openInEditorHandoff: PlanAgentHandoff = {
			label: 'Open in Editor',
			agent: 'agent',
			prompt: '#createFile the plan as is into an untitled file (`untitled:plan-${camelCaseName}.prompt.md` without frontmatter) for further refinement.',
			showContinueOn: false,
			send: true
		};

		// Start with base config, using dynamic body based on askQuestions setting
		const config: PlanAgentConfig = {
			...BASE_PLAN_AGENT_CONFIG,
			tools: [...BASE_PLAN_AGENT_CONFIG.tools],
			handoffs: [startImplementationHandoff, openInEditorHandoff, ...BASE_PLAN_AGENT_CONFIG.handoffs],
			body: PlanAgentProvider.buildAgentBody(askQuestionsEnabled)
		};

		// Collect tools to add
		const toolsToAdd: string[] = [...additionalTools];

		// Add askQuestions tool if enabled
		if (askQuestionsEnabled) {
			toolsToAdd.push('vscode/askQuestions');
		}

		// Merge additional tools (deduplicated)
		if (toolsToAdd.length > 0) {
			config.tools = [...new Set([...config.tools, ...toolsToAdd])];
		}

		// Apply model override
		if (modelOverride) {
			config.model = modelOverride;
		}

		return config;
	}
}
