/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { AGENT_FILE_EXTENSION } from '../../../platform/customInstructions/common/promptTypes';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService } from '../../../platform/filesystem/common/fileSystemService';
import { AdoRepoId, getOrderedRepoInfosFromContext, IGitService } from '../../../platform/git/common/gitService';
import { ILogService } from '../../../platform/log/common/logService';
import * as paths from '../../../util/vs/base/common/path';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';

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
	disableModelInvocation?: boolean;
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
	disableModelInvocation: true,
	agents: [],
	tools: [
		'agent',
		'search',
		'read',
		'execute/getTerminalOutput',
		'execute/testFailure',
		'web',
		'vscode/memory',
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
	if (config.disableModelInvocation) {
		lines.push(`disable-model-invocation: true`);
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
		@IToolsService private readonly toolsService: IToolsService,
		@IGitService private readonly gitService: IGitService,
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
- STOP if you consider running file editing tools — plans are for others to execute. The only write tool you have is #tool:vscode/memory for persisting plans.${askQuestionsEnabled ? `\n- Use #tool:vscode/askQuestions freely to clarify requirements — don't make large assumptions` : `\n- Include a "Further Considerations" section in your plan for clarifying questions`}
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

Save the full plan to session memory using #tool:vscode/memory with the \`create\` command at path \`/memories/session/plan.md\`, then show the complete plan to the user for review (memory is for persistence across follow-ups, not a substitute for showing it).

## 4. Refinement

On user input after showing a draft:
- Changes requested → revise and present updated plan. Update \`/memories/session/plan.md\` via #tool:vscode/memory \`str_replace\` to keep the persisted plan in sync.
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
- Always use a subagent for code research for more comprehensive discovery and reducing context bloat
- Keep scannable
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

		// Build body, appending ADO instructions if ADO tools are registered
		let body = PlanAgentProvider.buildAgentBody(askQuestionsEnabled);
		const adoInstructions = this.buildAzureDevOpsInstructions();
		if (adoInstructions) {
			body += '\n\n' + adoInstructions;
		}

		// Start with base config, using dynamic body based on askQuestions setting
		const config: PlanAgentConfig = {
			...BASE_PLAN_AGENT_CONFIG,
			tools: [...BASE_PLAN_AGENT_CONFIG.tools],
			handoffs: [startImplementationHandoff, openInEditorHandoff, ...BASE_PLAN_AGENT_CONFIG.handoffs],
			body
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

	/**
	 * Builds Azure DevOps instructions for the plan agent body when ADO tools are registered.
	 */
	private buildAzureDevOpsInstructions(): string | undefined {
		const hasAdoTools = this.toolsService.tools.some(tool => tool.name === ToolName.AdoGetWorkItem);
		if (!hasAdoTools) {
			return undefined;
		}

		// Extract ADO repo info from the active git repository
		let repoName: string | undefined;
		const repoContext = this.gitService.activeRepository.get();
		if (repoContext) {
			for (const info of getOrderedRepoInfosFromContext(repoContext)) {
				if (info.repoId instanceof AdoRepoId) {
					repoName = info.repoId.repo;
					break;
				}
			}
			// Fallback: use the workspace folder name if no ADO remote detected
			if (!repoName) {
				repoName = paths.posix.basename(repoContext.rootUri.path);
			}
		}

		const lines: string[] = [
			'<azure_devops_context>',
			'Azure DevOps tools are available. The project is pre-configured in settings — always search and operate within the default project. Do not ask the user which project to use.',
			'When the user asks about work items, bugs, tasks, user stories, sprints, boards, or wikis, use these tools instead of suggesting CLI commands or scripts:',
			`- Use ${ToolName.AdoQueryWorkItems} with a WIQL query to search work items. Use @me in WIQL for the current user.`,
			`- Use ${ToolName.AdoGetWorkItem} to fetch a specific work item by ID.`,
			`- Use ${ToolName.AdoUpdateWorkItem} to update work item fields.`,
			`- Use ${ToolName.AdoCreateWorkItem} to create new work items.`,
			`- Use ${ToolName.AdoAddComment} to add comments to work items.`,
			`- Use ${ToolName.AdoListWikis} to discover available wikis before reading or writing pages.`,
			`- Use ${ToolName.AdoGetWikiPageTree} to browse the full page tree of a wiki (all pages and subpages). Always use this first to understand the wiki structure before reading or writing specific pages.`,
			`- Use ${ToolName.AdoGetWikiPage} to read a specific wiki page's content.`,
			`- Use ${ToolName.AdoCreateOrUpdateWikiPage} to create or edit wiki pages.`,
			'',
			'WORK ITEM HIERARCHY: In this organization, work items follow a specific hierarchy:',
			'- Epic = "Use Case" — the highest-level grouping. Each Epic represents a distinct use case or major initiative.',
			'- Feature = "Release" — Features live under Epics. A Feature represents what the team is usually actively working on (a release or deliverable within a use case).',
			'- Product Backlog Item (PBI) = "Main update" — PBIs live under Features. They represent the significant updates or changes within a release.',
			'- Task — Tasks live under PBIs. Tasks are low-level implementation details and are usually NOT important. Do not focus on Tasks unless the user explicitly asks about them.',
			'',
			'When the user says "use case", they mean an Epic. When they say "release" or "feature", they mean a Feature. When they say "main update" or "PBI", they mean a Product Backlog Item.',
			'When querying the hierarchy, use [System.WorkItemType] = \'Epic\' for use cases, \'Feature\' for releases/features, and \'Product Backlog Item\' for PBIs.',
			'To find child items under a parent, use a link query, for example to find all Features under Epic 123: SELECT [System.Id], [System.Title], [System.State] FROM WorkItemLinks WHERE ([Source].[System.WorkItemType] = \'Epic\' AND [Source].[System.Id] = 123) AND ([Target].[System.WorkItemType] = \'Feature\') AND ([System.Links.LinkType] = \'System.LinkTypes.Hierarchy-Forward\') MODE (Recursive).',
			'To find all PBIs under a Feature, use the same pattern replacing the source type with \'Feature\' and target type with \'Product Backlog Item\'.',
		];

		if (repoName) {
			lines.push(
				'',
				`CURRENT REPOSITORY: The current repository name is "${repoName}".`,
				'The repository name typically contains a use case ID (Epic ID) — for example, "123-my-project" or "UC123-projectname" means the Epic ID is 123.',
				`When the user refers to "this repo's use case", "this use case", "our epic", or "this project's feature/release", you should:`,
				`1. Extract a numeric ID from the repository name "${repoName}". Look for a leading number or a number preceded by prefixes like "UC", "usecase", or "epic" (case-insensitive).`,
				`2. If you find an ID, use ${ToolName.AdoGetWorkItem} to fetch that Epic, then scope subsequent queries to that Epic's hierarchy.`,
				`3. If no numeric ID is found in the repo name, use ${ToolName.ReadFile} to read the README.md file in the repository root — it often contains the use case ID or Epic link.`,
				'4. If neither the repo name nor the README contains a clear Epic ID, ask the user which Epic or use case ID to use.',
			);
		} else {
			lines.push(
				'',
				'REPOSITORY CONTEXT: No active repository was detected. If the user refers to "this repo\'s use case" or similar, ask them for the repository name or Epic/use case ID.',
			);
		}

		lines.push(
			'',
			'IMPORTANT: For any write operation (updating work items, creating work items, adding comments, writing wiki pages), if the user has not clearly specified the target (which work item, which wiki, which page), ALWAYS ask the user to clarify before proceeding. Never guess which item to modify.',
			'</azure_devops_context>',
		);

		return lines.join('\n');
	}
}
