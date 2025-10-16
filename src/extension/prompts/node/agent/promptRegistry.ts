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
	readonly modelFamilies: readonly string[];
	new(...args: any[]): IAgentPrompt;
}

export const PromptRegistry = new class {
	private promptMap = new Map<string, IAgentPromptCtor>();

	registerPrompt(prompt: IAgentPromptCtor): void {
		for (const modelFamily of prompt.modelFamilies) {
			this.promptMap.set(modelFamily, prompt);
		}
	}

	getPrompt(
		modelFamily: string
	): IAgentPromptCtor | undefined {
		return this.promptMap.get(modelFamily);
	}
}();
