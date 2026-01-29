/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptElementProps, PromptSizing } from '@vscode/prompt-tsx';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { isAnthropicFamily } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { Tag } from '../../prompts/node/base/tag';
import { IAgentMemoryService, normalizeCitations, RepoMemoryEntry } from '../common/agentMemoryService';
import { ContributedToolName } from '../common/toolNames';
export interface RepoMemoryContextPromptProps extends BasePromptElementProps {
}

/**
 * A wrapper prompt element that provides repo memory context.
 * If Copilot Memory (CAPI) is enabled, fetches from CAPI exclusively.
 * Otherwise, falls back to local filesystem storage.
 */
export class RepoMemoryContextPrompt extends PromptElement<RepoMemoryContextPromptProps> {
	constructor(
		props: any,
		@IAgentMemoryService private readonly agentMemoryService: IAgentMemoryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) {
		super(props);
	}

	async render() {
		const enableCopilotMemory = this.configurationService.getExperimentBasedConfig(ConfigKey.CopilotMemoryEnabled, this.experimentationService);
		if (!enableCopilotMemory) {
			return null;
		}

		// Fetch from CAPI if enabled, otherwise from local filesystem
		const memories = await this.fetchMemories();
		if (!memories || memories.length === 0) {
			return null;
		}

		const formattedMemories = this.formatMemories(memories);

		return (
			<Tag name='repository_memories'>
				The following are recent memories stored for this repository from previous agent interactions. These memories may contain useful context about the codebase conventions, patterns, and practices. However, be aware that memories might be obsolete or incorrect or may not apply to your current task. Use the citations provided to verify the accuracy of any relevant memory before relying on it.<br />
				<br />
				{formattedMemories}
				<br />
				Be sure to consider these stored facts carefully. Consider whether any are relevant to your current task. If they are, verify their current applicability before using them to inform your work.<br />
				<br />
				If you come across a memory that you're able to verify and that you find useful, you should use the {ContributedToolName.Memory} tool to store the same fact again. Only recent memories are retained, so storing the fact again will cause it to be retained longer.<br />
				If you come across a fact that's incorrect or outdated, you should use the {ContributedToolName.Memory} tool to store a new fact that reflects the current reality.<br />
			</Tag>
		);
	}

	/**
	 * Fetch repo memories from Copilot Memory service.
	 * Returns undefined if Copilot Memory is not enabled.
	 */
	private async fetchMemories(): Promise<RepoMemoryEntry[] | undefined> {
		return this.agentMemoryService.getRepoMemories();
	}

	private formatMemories(memories: RepoMemoryEntry[]): string {
		return memories.map(m => {
			const lines = [`**${m.subject}**`, `- Fact: ${m.fact}`];

			// Format citations (handle both string and string[] formats)
			if (m.citations) {
				const citationsArray = normalizeCitations(m.citations) ?? [];
				if (citationsArray.length > 0) {
					lines.push(`- Citations: ${citationsArray.join(', ')}`);
				}
			}

			// Include reason if present (from CAPI format)
			if (m.reason) {
				lines.push(`- Reason: ${m.reason}`);
			}

			return lines.join('\n');
		}).join('\n\n');
	}
}
/**
 * Prompt component that provides instructions for using the memory tool to store repo facts.
 * Only rendered when copilotMemory.enabled is true.
 */
export class RepoMemoryInstructionsPrompt extends PromptElement<BasePromptElementProps> {
	constructor(
		props: PromptElementProps<BasePromptElementProps>,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExperimentationService private readonly experimentationService: IExperimentationService,
	) {
		super(props);
	}

	async render(state: void, sizing: PromptSizing) {
		const enableCopilotMemory = this.configurationService.getExperimentBasedConfig(ConfigKey.CopilotMemoryEnabled, this.experimentationService);
		if (!enableCopilotMemory) {
			return null;
		}

		const endpoint = sizing.endpoint as IChatEndpoint | undefined;
		const isAnthropic = endpoint && isAnthropicFamily(endpoint);

		return <Tag name='repoMemory'>
			If you come across an important fact about the codebase that could help in future code review or generation tasks, beyond the current task, use the {ContributedToolName.Memory} tool to store it{isAnthropic ? ' at /memories/repo/' : ''}. Facts may be gleaned from the codebase itself or learned from user input or feedback. Such facts might include:<br />
			- Conventions, preferences, or best practices specific to this codebase that might be overlooked when inspecting only a limited code sample<br />
			- Important information about the structure or logic of the codebase<br />
			- Commands for linting, building, or running tests that have been verified through a successful run<br />
			<br />
			<Tag name='examples'>
				- "Use ErrKind wrapper for every public API error"<br />
				- "Prefer ExpectNoLog helper over silent nil checks in tests"<br />
				- "Always use Python typing"<br />
				- "Follow the Google JavaScript Style Guide"<br />
				- "Use html_escape as a sanitizer to avoid cross site scripting vulnerabilities"<br />
				- "The code can be built with `npm run build` and tested with `npm run test`"<br />
			</Tag>
			<br />
			Only store facts that meet the following criteria:<br />
			<Tag name='factsCriteria'>
				- Are likely to have actionable implications for a future task<br />
				- Are independent of changes you are making as part of your current task, and will remain relevant if your current code isn't merged<br />
				- Are unlikely to change over time<br />
				- Cannot always be inferred from a limited code sample<br />
				- Contain no secrets or sensitive data<br />
			</Tag>
			<br />
			{isAnthropic && <>
				ALWAYS use the {ContributedToolName.Memory}'s create command to store a new repo fact at /memories/repo/&lt;descriptive-name&gt;.jsonl using JSONL format with these fields: subject (1-2 words), fact (less than 200 chars), citations (file:line or "User input: ..."), reason (2-3 sentences), category (bootstrap_and_build, user_preferences, general, or file_specific).<br />
				Do NOT attempt to view, str_replace, insert, delete, or rename repo memories. Only use the create command for /memories/repo paths.<br />
			</>}
			Always include the reason and citations fields.<br />
			Before storing, ask yourself: Will this help with future coding or code review tasks across the repository? If unsure, skip storing it.<br />
		</Tag>;
	}
}
