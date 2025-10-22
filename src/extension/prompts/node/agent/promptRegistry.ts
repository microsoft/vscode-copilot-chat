/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptElement } from '@vscode/prompt-tsx';
import { DefaultAgentPromptProps } from './defaultAgentInstructions';

export type PromptConstructor = new (props: DefaultAgentPromptProps, ...args: any[]) => PromptElement<DefaultAgentPromptProps>;

export interface IAgentPrompt {
	resolvePrompt(): PromptConstructor | undefined;
}

export interface IAgentPromptCtor {
	readonly models: readonly string[];
	new(...args: any[]): IAgentPrompt;
}

export const PromptRegistry = new class {
	private promptMap = new Map<string, IAgentPromptCtor>();

	registerPrompt(prompt: IAgentPromptCtor): void {
		for (const model of prompt.models) {
			this.promptMap.set(model, prompt);
		}
	}

	getPrompt(
		model: string
	): IAgentPromptCtor | undefined {
		return this.promptMap.get(model);
	}
}();
