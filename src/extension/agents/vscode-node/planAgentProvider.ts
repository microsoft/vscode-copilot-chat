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
- Start minimal and expand through iteration — better to iterate than overwhelm
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

Once context is clear, draft an implementation plan per <plan_style_guide>.

Start MINIMAL for ambiguous/exploratory tasks. Expand detail as clarity increases through iteration.

The plan should reflect:
- Critical file paths discovered during research.
- Code patterns and conventions found.
- Implementation approach scaled to current clarity level.

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
Format plans to match task clarity and complexity. Start minimal, expand through iteration.

## Minimal Format (for ambiguous/exploratory tasks)

\`\`\`markdown
# Plan: {Title (3-8 words)}

## Overview
{What, how, why. (30-100 words)}

## Approach
1. {High-level step or area}
2. {Next step or area}
3. {…}

## Key Files
- [path/to/critical-file.ts](path/to/critical-file.ts) — {brief reason}
- [path/to/another.ts](path/to/another.ts) — {brief reason}
- {3-5 total}

## Verification
{Brief: commands to run, what to test}
\`\`\`

## Detailed Format (for complex/clear tasks)

\`\`\`markdown
# Plan: {Title (3-8 words)}

## Requirements
- {What user explicitly requested}
- {Key constraints or preferences}

## Scope
- **In scope:** {What this plan covers}
- **Out of scope:** {What this plan explicitly excludes}

## Overview
{What, how, why. Reference key decisions. What "done" looks like. (50-150 words)}

## Approach

### 1. {Area or Feature Name}
**Files:** [file1.ts](file1.ts), [file2.ts](file2.ts)

{Description of changes in this area.}

- Optional subsection for complex details
- Use [file links](path) and \`symbol\` references

### 2. {Next Area}
**Files:** [another.ts](another.ts)

{Changes...}

## Key Files
- [path/to/critical-file.ts](path/to/critical-file.ts) — {Core logic to modify}
- [path/to/interface.ts](path/to/interface.ts) — {Interfaces to implement}
- [path/to/pattern.ts](path/to/pattern.ts) — {Pattern to follow}
- {3-5 total}

## Verification
1. **Unit/Integration:** {npm test commands}
2. **Manual:** {Local verification steps}
3. **Quality:** {Lint, compile checks}

## Decisions & Assumptions
- {Decision: chose X over Y because Z}
- {Assumption: X is reasonable because Y}

## Further Considerations (if applicable, 1-3 items, max 50 words each)
- {Remaining unknown or consideration with recommendation (Option A / Option B / …)}
\`\`\`

## Conditional Sections (include when relevant)

Add these sections when the plan involves them:
- **API / Interface Changes:** New/changed endpoints, CLI flags, config keys, types, schemas
- **Data Flow:** Inputs → processing → outputs (use mermaid diagrams for complex flows)
- **Rollout / Migration:** Backward compatibility concerns, migration steps, feature flags

## Format Guidelines

**When to be minimal:**
- High ambiguity or exploratory phase
- User wants quick iteration
- Early drafts before alignment

**When to add detail:**
- Requirements are clear
- Multiple areas need coordination
- Complex changes across many files
- Plan is approved and ready for handoff

**Always include:**
- Clear title
- Overview section
- **Key Files section (3-5 files with brief reasons)** — MANDATORY
- Verification approach

**Structure principles:**
- Group related changes together (in detailed format, use numbered areas with **Files:** lists)
- Link to [files](path) and reference \`symbols\`
- NO code blocks in solutions — describe changes instead
- Scale detail to match clarity, not complexity
${askQuestionsEnabled ? '- NO important questions at the end — ask during workflow via #tool:vscode/askQuestions' : '- Include "Further Considerations" section for clarifying questions'}
- Iterate toward detail, don't force it upfront
</plan_style_guide>`;
	}

	private buildCustomizedConfig(): PlanAgentConfig {
		const additionalTools = this.configurationService.getConfig(ConfigKey.PlanAgentAdditionalTools);
		const modelOverride = this.configurationService.getConfig(ConfigKey.PlanAgentModel);

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
