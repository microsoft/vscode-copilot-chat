/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { Tag } from '../../prompts/node/base/tag';
import { IAgentMemoryService, normalizeCitations, RepoMemoryEntry } from '../common/agentMemoryService';

export interface RepoMemoryContextPromptProps extends BasePromptElementProps {
}

/**
 * A wrapper prompt element that provides repo memory context.
 * Fetches memories from both CAPI (if enabled) and local filesystem,
 * merging and deduplicating them with CAPI as the source of truth.
 */
export class RepoMemoryContextPrompt extends PromptElement<RepoMemoryContextPromptProps> {
	constructor(
		props: any,
		@IAgentMemoryService private readonly agentMemoryService: IAgentMemoryService,
	) {
		super(props);
	}

	async render() {
		// Fetch from both CAPI and local, merge and deduplicate
		const memories = await this.fetchAndMergeMemories();
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
				If you come across a memory that you're able to verify and that you find useful, you should use the copilot_memory tool to store the same fact again. Only recent memories are retained, so storing the fact again will cause it to be retained longer.<br />
				If you come across a fact that's incorrect or outdated, you should use the copilot_memory tool to store a new fact that reflects the current reality.<br />
			</Tag>
		);
	}

	/**
	 * Fetch memories from both CAPI and local filesystem, merge them, and deduplicate.
	 * CAPI memories take precedence over local memories in case of conflicts.
	 */
	private async fetchAndMergeMemories(): Promise<RepoMemoryEntry[] | undefined> {
		try {
			// Fetch from CAPI first (returns undefined if disabled or unavailable)
			const capiMemories = await this.agentMemoryService.fetchMemoriesFromCAPI();

			// Fetch from local filesystem
			const localMemories = await this.agentMemoryService.getRepoMemoryContext();

			// If neither source has memories, return undefined
			if ((!capiMemories || capiMemories.length === 0) &&
				(!localMemories || localMemories.length === 0)) {
				return undefined;
			}

			// Merge and deduplicate
			const allMemories = [
				...(capiMemories ?? []),
				...(localMemories ?? [])
			];

			return this.deduplicateMemories(allMemories);
		} catch (error) {
			// On error, fallback to local memories only
			console.warn(`[RepoMemoryContextPrompt] Error fetching memories: ${error}`);
			return await this.agentMemoryService.getRepoMemoryContext();
		}
	}

	/**
	 * Deduplicate memories by (subject, fact) tuple.
	 * Keeps the first occurrence (CAPI memories are added first, so they take precedence).
	 */
	private deduplicateMemories(memories: RepoMemoryEntry[]): RepoMemoryEntry[] {
		const seen = new Set<string>();
		const deduplicated: RepoMemoryEntry[] = [];

		for (const memory of memories) {
			// Create unique key from subject and fact (case-insensitive)
			const key = `${memory.subject.toLowerCase()}|${memory.fact.toLowerCase()}`;

			if (!seen.has(key)) {
				seen.add(key);
				deduplicated.push(memory);
			}
		}

		return deduplicated;
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
