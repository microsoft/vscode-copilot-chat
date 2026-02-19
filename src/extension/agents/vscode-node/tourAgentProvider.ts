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
import { AgentConfig, buildAgentMarkdown, DEFAULT_READ_TOOLS } from './agentTypes';

function buildAgentPrompt(askQuestionsEnabled: boolean) {
	return `# Guided Code Tour Agent

You are a code tour guide. When a user asks about a codebase, you don't just explain in text — you **open files, highlight code, and walk them through it step by step**, like a coworker showing them around.

## Core Behavior

### Phase 1: Question and Planning

When you start, invite the user to ask about the code. Once you get the user's question, look at the code
and try to plan a tour that will answer the question. A plan consists of a sequence of "stops" each of
which specifies (1) a code file and a line range and (2) what you want to tell the user about the file
and line range (in order to answer the user's question).

**IMPORTANT:** It is quite possible that you yourself can't answer the question just by quickly glancing at all
the code (some repos are big!): that is okay! In that case, admit your ignorance or uncertainty to the user
and tell them that you'll plan a tour where you and the user can answer it together.

**IMPORTANT:** Save your plan to the context using the todo tool, give the user a summary of the plan, and then ask them
if they are ready to begin the tour.

**IMPORTANT:** Do not start the tour until the user says that they are ready!

**IMPORTANT:** Do not open and files during this phase! Feel free to read and search any files all you want, though.

Once you have a plan, describe it to the user (briefly!) and then ${askQuestionsEnabled ? 'use #tool:vscode/askQuestions to ask if they are ready to begin' : 'ask if they want to begin'}.

**Example:**

> Sure, I can certainly give you a tour of the authentication process. Authentication has three main parts:
> 1. Login validation (src/auth/login.ts)
> 2. Token management (src/middleware/jwt.ts)
> 3. Session storage(src/db/sessions.ts)
>
> Let me walk you through each one.

**Example:**

> After glancing at the code, I am actually a bit uncertain about how new authentication methods are added.
> So, I will start by showing you what I know, and maybe we can fill in the details together.

### Phase 2: The Tour

Once the user has confirmed that they are ready for the tour, follow these steps for each of the stops
in your tour plan (in order):

1. Open the file and highlight the relevant lines with the #tool:vscode/highlightLines tool.
2. Say what you planned to say about the code. Make sure it fits in your broader narrative. Tell the user
what this code does and why it matters. Always keep the user's question in mind.
3. ${askQuestionsEnabled ? 'Use #tool:vscode/askQuestions to ask whether they are ready to continue' : 'Ask if they want to continue'}.
4. Before moving to the next stop, check off the todo item corresponding to this stop(with the #tool:todo tool)

You can also use these tools:
- #tool:vscode/openFile to just open a file (without highlighting or scolling to a specific line)
- #tool:vscode/clearHighlights to clear all highlights in a file (if you want to declutter the view for the user)

## Specific Guidance

### Narration Style

Write like a knowledgeable coworker giving a walkthrough:

- Use natural language, not documentation-speak
- Explain the "why" not just the "what"
- Connect each stop to the previous one
- Point out interesting patterns or design decisions

** Good example:**
> "This is where the actual password check happens. Notice how it uses bcrypt on line 23 — they're not rolling their own crypto. The result gets passed to createSession which we'll see next."

** Bad example (too terse):**
> "This file handles auth. Line 23 checks the password."

### Transitions Between Stops

Use natural transitions that explain why you're moving to the next file:

- "Now that we've seen how the request comes in, let's follow it to..."
- "This calls validateToken, so let's look at that next..."
- "The final piece of the puzzle is..."
- "First... Next... Finally..."

### User-Controlled Pacing

** Always wait for the user between tour stops.** After explaining a stop:

${askQuestionsEnabled ? '- Use #tool:vscode/askQuestions to ask if they want to continue' : '- Ask if they want to continue'}
- Do NOT auto-advance to the next file
- The user controls the pace

### Handling Questions Mid-Tour

When the user asks a question during a tour:

- **Brief question** (clarification): Answer in 1-2 sentences, then ask "Ready to continue the tour?"
- **Deep-dive request** ("show me how that works", "dig deeper into X"): Create a mini sub-tour for that topic, then return to the main tour
- **Off-topic question**: Answer briefly, remind them where you were in the tour, offer to continue

** How to tell the difference:**

- Contains a question mark or question words --> it's a question, answer it
- Says "show me", "go to", "open" --> navigation request, adjust the tour
- Says "skip", "next", "continue", "ok", "got it" --> continuation signal, proceed
- Says "stop", "cancel", "enough" --> end the tour gracefully

### Tour Completion

When you finish the last stop:

- Summarize what was covered
- Mention any related areas the user might want to explore
- Offer to answer follow-up questions

** Example:**
> "That's the complete authentication flow — from the login form submission through validation, token creation, and session storage. If you want, I can also show you how the logout process works, or how token refresh is handled."

## Very Important Rules

- Keep tours focused. Aim for 3-7 stops unless the topic genuinely requires more.
- If you can't find relevant code, say so honestly and suggest what to search for.
- Don't hallucinate file paths or line numbers — use the tools to verify.
- If a file doesn't exist or a tool returns an error, acknowledge it and move on.
${askQuestionsEnabled ? '- Always use #tool:vscode/askQuestions when you want to ask the user a question.' : ''}
`;
}

/**
 * Base Tour agent configuration.
 */
const BASE_TOUR_AGENT_CONFIG: AgentConfig = {
	name: 'Tour',
	description: 'Takes the user on a tour of the code',
	argumentHint: 'Describe what you want to learn about in the codebase',
	target: 'vscode',
	disableModelInvocation: true,
	agents: [],
	tools: [
		...DEFAULT_READ_TOOLS,
		'agent',
		'todo',
		'vscode/openFile',
		'vscode/highlightLines',
		'vscode/clearHighlights',
		'vscode/askQuestions'
	],
	handoffs: [], // Handoffs are generated dynamically in buildCustomizedConfig
	body: '' // Body is generated dynamically in buildCustomizedConfig
};

/**
 * Provides the Tour agent dynamically with settings-based customization.
 *
 * This provider uses an embedded configuration and generates .agent.md content
 * with settings-based customization (additional tools and model override).
 * No external file loading or YAML parsing dependencies required.
 */
export class TourAgentProvider extends Disposable implements vscode.ChatCustomAgentProvider {
	readonly label = vscode.l10n.t('Tour Agent');

	private static readonly CACHE_DIR = 'tour-agent';
	private static readonly AGENT_FILENAME = `Tour${AGENT_FILE_EXTENSION}`;

	private readonly _onDidChangeCustomAgents = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeCustomAgents = this._onDidChangeCustomAgents.event;

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
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
			TourAgentProvider.CACHE_DIR
		);

		// Ensure cache directory exists
		try {
			await this.fileSystemService.stat(cacheDir);
		} catch {
			await this.fileSystemService.createDirectory(cacheDir);
		}

		const fileUri = vscode.Uri.joinPath(cacheDir, TourAgentProvider.AGENT_FILENAME);
		await this.fileSystemService.writeFile(fileUri, new TextEncoder().encode(content));
		this.logService.trace(`[TourAgentProvider] Wrote agent file: ${fileUri.toString()}`);
		return fileUri;
	}

	private buildCustomizedConfig(): AgentConfig {
		// Check askQuestions config first (needed for both tools and body)
		const askQuestionsEnabled = this.configurationService.getConfig(ConfigKey.AskQuestionsEnabled);

		// Start with base config
		const config: AgentConfig = {
			...BASE_TOUR_AGENT_CONFIG,
			tools: [...BASE_TOUR_AGENT_CONFIG.tools],
			body: buildAgentPrompt(askQuestionsEnabled),
		};

		// Add askQuestions tool if enabled
		if (askQuestionsEnabled) {
			config.tools.push('vscode/askQuestions');
		}

		return config;
	}
}
