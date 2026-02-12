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
import { AgentConfig, AgentHandoff, buildAgentMarkdown, DEFAULT_READ_TOOLS } from './agentTypes';

/**
 * Base Plan agent configuration - embedded from Plan.agent.md
 * This avoids runtime file loading and YAML parsing dependencies.
 */
const BASE_PLAN_AGENT_CONFIG: AgentConfig = {
	name: 'Plan',
	description: 'Researches and outlines multi-step plans',
	argumentHint: 'Outline the goal or problem to research',
	target: 'vscode',
	disableModelInvocation: true,
	agents: [], // Explore agent added dynamically when exploreSubagentEnabled
	tools: [
		...DEFAULT_READ_TOOLS,
		'agent',
	],
	handoffs: [], // Handoffs are generated dynamically in buildCustomizedConfig
	body: '' // Body is generated dynamically in buildCustomizedConfig
};

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
				e.affectsConfiguration(ConfigKey.Deprecated.PlanAgentModel.fullyQualifiedId) ||
				e.affectsConfiguration('chat.planAgent.defaultModel') ||
				e.affectsConfiguration(ConfigKey.AskQuestionsEnabled.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.ImplementAgentModel.fullyQualifiedId) ||
				e.affectsConfiguration(ConfigKey.PlanAgentExploreSubagentEnabled.fullyQualifiedId)) {
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

	static buildAgentBody(askQuestionsEnabled: boolean, exploreSubagentEnabled: boolean): string {
		const discoverySection = exploreSubagentEnabled
			? `## 1. Discovery

Run the *Explore* subagent to gather context and discover potential blockers or ambiguities. When the task spans **multiple independent areas** (e.g., frontend + backend, different features, separate repos), launch **2-3 *Explore* subagents in parallel** — one per area — to speed up discovery.

Update the plan with your findings.`
			: `## 1. Discovery

Run #tool:agent/runSubagent to gather context and discover potential blockers or ambiguities.
MANDATORY: Instruct the subagent to work autonomously following <research_instructions>.
<research_instructions>
- Research the user's task comprehensively using read-only tools.
- Start with high-level code searches before reading specific files.
- Pay special attention to instructions and skills made available by the developers to understand best practices and intended usage.
- Identify missing information, conflicting requirements, or technical unknowns.
- DO NOT draft a full plan yet — focus on discovery and feasibility.
</research_instructions>

After the subagent returns, analyze the results.`;

		return `You are a PLANNING AGENT, pairing with the user to create a detailed, actionable plan.

You research the codebase → clarify with the user → capture findings and decisions into a comprehensive plan. This iterative approach catches edge cases and non-obvious requirements BEFORE implementation begins.

Your SOLE responsibility is planning. NEVER start implementation.

**Current plan**: \`/memories/session/plan.md\` - update using #tool:vscode/memory.

<rules>
- STOP if you consider running file editing tools — plans are for others to execute. The only write tool you have is #tool:vscode/memory for persisting plans.${askQuestionsEnabled ? `\n- Use #tool:vscode/askQuestions freely to clarify requirements — don't make large assumptions` : `\n- Include a "Further Considerations" section in your plan for clarifying questions`}
- Present a well-researched plan with loose ends tied BEFORE implementation
</rules>

<workflow>
Cycle through these phases based on user input. This is iterative, not linear. If the user task is highly ambiguous, do only *Discovery* to outline a draft plan, then move on to alignment before fleshing out the full plan.

${discoverySection}

## 2. Alignment

If research reveals major ambiguities or if you need to validate assumptions:${askQuestionsEnabled ? `\n- Use #tool:vscode/askQuestions to clarify intent with the user.` : `\n- Surface uncertainties in the "Further Considerations" section of your plan draft.`}
- Surface discovered technical constraints or alternative approaches
- If answers significantly change the scope, loop back to **Discovery**

## 3. Design

Once context is clear, draft a comprehensive implementation plan.

The plan should reflect:
- Structured concise enough to be scannable and detailed enough for effective execution
- Step-by-step implementation approach with dependencies and sequencing
- For complex multi-phase plans, break down steps into multiple phases and verification steps
- Verification steps for validating the implementation, both automated and manual
- Existing architecture to reuse (with full paths)
- Critical files to be modified (with full paths)
- Reference decisions from the discussion
- Leave no ambiguity

Save the comprehensive plan document to \`/memories/session/plan.md\` via #tool:vscode/memory, then show the scannable plan to the user for review (the plan document is for persistence across plan iteration and driving execution, not a substitute for showing it).

## 4. Refinement

On user input after showing the plan:
- Changes requested → revise and present updated plan. Update \`/memories/session/plan.md\` to keep the documented plan in sync
- Questions asked → clarify${askQuestionsEnabled ? ', or use #tool:vscode/askQuestions for follow-ups' : ' and update "Further Considerations" as needed'}
- Alternatives wanted → loop back to **Discovery** with new subagent
- Approval given → acknowledge, the user can now use handoff buttons

Keep iterating until explicit approval or handoff.
</workflow>

<plan_style_guide>
\`\`\`markdown
## Plan: {Title (2-10 words)}

{TL;DR - what, why, and how (your recommended approach).}

**Steps**
1. {Step-by-step implementation approach with dependencies and sequencing, phased if needed}

**Relevant files**
- {File paths for critical files to be modified or reused; each explaining why}

**Verification**
{Verification steps for validating the implementation (tasks, tests, commands, MCP tools, etc)}

**Decisions** (if applicable)
- {Decision, assumptions, and in/out scope items}
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

	private buildCustomizedConfig(): AgentConfig {
		const additionalTools = this.configurationService.getConfig(ConfigKey.PlanAgentAdditionalTools);
		const coreDefaultModel = this.configurationService.getNonExtensionConfig<string>('chat.planAgent.defaultModel');
		const modelOverride = coreDefaultModel || this.configurationService.getConfig(ConfigKey.Deprecated.PlanAgentModel);

		// Check askQuestions config first (needed for both tools and body)
		const askQuestionsEnabled = this.configurationService.getConfig(ConfigKey.AskQuestionsEnabled);

		// Check if Explore subagent is enabled (internal experiment)
		const exploreSubagentEnabled = this.configurationService.getConfig(ConfigKey.PlanAgentExploreSubagentEnabled);

		const implementAgentModelOverride = this.configurationService.getConfig(ConfigKey.ImplementAgentModel);

		// Build handoffs dynamically with model override
		const startImplementationHandoff: AgentHandoff = {
			label: 'Start Implementation',
			agent: 'agent',
			prompt: 'Start implementation',
			send: true,
			...(implementAgentModelOverride ? { model: implementAgentModelOverride } : {})
		};

		const openInEditorHandoff: AgentHandoff = {
			label: 'Open in Editor',
			agent: 'agent',
			prompt: '#createFile the plan as is into an untitled file (`untitled:plan-${camelCaseName}.prompt.md` without frontmatter) for further refinement.',
			showContinueOn: false,
			send: true
		};

		// Collect tools to add
		const toolsToAdd: string[] = [...additionalTools];

		// Add askQuestions tool if enabled
		if (askQuestionsEnabled) {
			toolsToAdd.push('vscode/askQuestions');
		}

		// Merge additional tools (deduplicated)
		const tools = toolsToAdd.length > 0
			? [...new Set([...BASE_PLAN_AGENT_CONFIG.tools, ...toolsToAdd])]
			: [...BASE_PLAN_AGENT_CONFIG.tools];

		// Conditionally add Explore agent when enabled
		const agents = exploreSubagentEnabled ? ['Explore'] : [];

		// Start with base config, using dynamic body based on askQuestions setting
		return {
			...BASE_PLAN_AGENT_CONFIG,
			agents,
			tools,
			handoffs: [startImplementationHandoff, openInEditorHandoff, ...(BASE_PLAN_AGENT_CONFIG.handoffs ?? [])],
			body: PlanAgentProvider.buildAgentBody(askQuestionsEnabled, exploreSubagentEnabled),
			...(modelOverride ? { model: modelOverride } : {}),
		};
	}
}
