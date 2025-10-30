/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement, PromptPiece } from '@vscode/prompt-tsx';
import type { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { DefaultAgentPromptProps } from './defaultAgentInstructions';

export interface ModelOptions {
	readonly shouldUseUserQuery?: boolean;
	readonly overrides?: {
		readonly SystemMessageContent?: () => PromptElement | PromptPiece;
		readonly UserMessageContent?: (props: { query: string; hasVariables: boolean }) => PromptElement | PromptPiece;
	};
}

export type PromptConstructor = new (props: DefaultAgentPromptProps, ...args: any[]) => PromptElement<DefaultAgentPromptProps>;

export interface IAgentPrompt {
	resolvePrompt(endpoint: IChatEndpoint): PromptConstructor | undefined;
	resolveModelOptions?(endpoint: IChatEndpoint): ModelOptions | undefined;
}

export interface IAgentPromptCtor {
	readonly familyPrefixes: readonly string[];
	matchesModel?(endpoint: IChatEndpoint): Promise<boolean> | boolean;
	new(...args: any[]): IAgentPrompt;
}

export type AgentPromptClass = IAgentPromptCtor & (new (...args: any[]) => IAgentPrompt);

type PromptWithMatcher = IAgentPromptCtor & {
	matchesModel: (endpoint: IChatEndpoint) => Promise<boolean> | boolean;
};

export const PromptRegistry = new class {
	private readonly promptsWithMatcher: PromptWithMatcher[] = [];
	private readonly familyPrefixList: { prefix: string; prompt: IAgentPromptCtor }[] = [];

	registerPrompt(prompt: IAgentPromptCtor): void {
		if (prompt.matchesModel) {
			this.promptsWithMatcher.push(prompt as PromptWithMatcher);
		}

		for (const prefix of prompt.familyPrefixes) {
			this.familyPrefixList.push({ prefix, prompt });
		}
	}

	async getPrompt(
		endpoint: IChatEndpoint
	): Promise<IAgentPromptCtor | undefined> {

		for (const prompt of this.promptsWithMatcher) {
			const matches = await prompt.matchesModel(endpoint);
			if (matches) {
				return prompt;
			}
		}

		for (const { prefix, prompt } of this.familyPrefixList) {
			if (endpoint.family.startsWith(prefix)) {
				return prompt;
			}
		}

		return undefined;
	}
}();
