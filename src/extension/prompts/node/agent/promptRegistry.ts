/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import type { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { DefaultAgentPromptProps } from './defaultAgentInstructions';

export type PromptConstructor = new (props: DefaultAgentPromptProps, ...args: any[]) => PromptElement<DefaultAgentPromptProps>;

export interface IAgentPrompt {
	resolvePrompt(endpoint: IChatEndpoint): PromptConstructor | undefined;
}

export interface IAgentPromptCtor {
	readonly familyPrefixes: readonly string[];
	new(...args: any[]): IAgentPrompt;
}

export type AgentPromptClass = IAgentPromptCtor & (new (...args: any[]) => IAgentPrompt);

export const PromptRegistry = new class {
	private familyPrefixList: { prefix: string; prompt: IAgentPromptCtor }[] = [];

	registerPrompt(prompt: IAgentPromptCtor): void {
		for (const prefix of prompt.familyPrefixes) {
			this.familyPrefixList.push({ prefix, prompt });
		}
	}

	getPrompt(
		endpoint: IChatEndpoint
	): IAgentPromptCtor | undefined {
		// Check family prefix match
		for (const { prefix, prompt } of this.familyPrefixList) {
			if (endpoint.family.startsWith(prefix)) {
				return prompt;
			}
		}

		return undefined;
	}
}();
