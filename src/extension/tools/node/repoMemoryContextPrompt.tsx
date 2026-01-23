/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { Tag } from '../../prompts/node/base/tag';
import { IAgentMemoryService, RepoMemoryEntry } from '../common/agentMemoryService';

export interface RepoMemoryContextPromptProps extends BasePromptElementProps {
}

/**
 * A wrapper prompt element that provides repo memory context
 */
export class RepoMemoryContextPrompt extends PromptElement<RepoMemoryContextPromptProps> {
	constructor(
		props: any,
		@IAgentMemoryService private readonly agentMemoryService: IAgentMemoryService,
	) {
		super(props);
	}

	async render() {
		const memories = await this.agentMemoryService.getRepoMemoryContext();
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
				If you come across a memory that you're able to verify and that you find useful, you should use the store_memory tool to store the same fact again. Only recent memories are retained, so storing the fact again will cause it to be retained longer.<br />
				If you come across a fact that's incorrect or outdated, you should use the store_memory tool to store a new fact that reflects the current reality.<br />
			</Tag>
		);
	}

	private formatMemories(memories: RepoMemoryEntry[]): string {
		return memories.map(m => {
			const lines = [`**${m.subject}**`, `- Fact: ${m.fact}`];
			if (m.citations) {
				lines.push(`- Citations: ${m.citations}`);
			}
			return lines.join('\n');
		}).join('\n\n');
	}
}
