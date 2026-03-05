/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';

export interface PromptVariable {
	readonly reference: vscode.ChatPromptReference;
	readonly originalName: string;
	readonly uniqueName: string;
	readonly value: string | vscode.Uri | vscode.Location | unknown;
	readonly range?: [start: number, end: number];
	readonly isMarkedReadonly: boolean | undefined;
}

export class ChatVariablesCollection {
	private _variables: PromptVariable[] | null = null;

	static merge(...collections: ChatVariablesCollection[]): ChatVariablesCollection {
		const allReferences: vscode.ChatPromptReference[] = [];
		const seen = new Set<string>();
		for (const collection of collections) {
			for (const variable of collection) {
				const ref = variable.reference;

				// simple dedupe
				let key: string;
				try {
					key = JSON.stringify(ref.value);
				} catch {
					key = ref.id + String(ref.value);
				}

				if (!seen.has(key)) {
					seen.add(key);
					allReferences.push(ref);
				}
			}
		}

		return new ChatVariablesCollection(allReferences);
	}

	constructor(
		private readonly _source: readonly vscode.ChatPromptReference[] = []
	) { }

	private _getVariables(): PromptVariable[] {
		if (!this._variables) {
			this._variables = [];
			for (let i = 0; i < this._source.length; i++) {
				const variable = this._source[i];
				// Rewrite the message to use the variable header name
				if (variable.value) {
					const originalName = variable.name;
					const uniqueName = this.uniqueFileName(originalName, this._source.slice(0, i));
					this._variables.push({ reference: variable, originalName, uniqueName, value: variable.value, range: variable.range, isMarkedReadonly: variable.isReadonly });
				}
			}
		}
		return this._variables;
	}

	public reverse() {
		const sourceCopy = this._source.slice(0);
		sourceCopy.reverse();
		return new ChatVariablesCollection(sourceCopy);
	}

	public find(predicate: (v: PromptVariable) => boolean): PromptVariable | undefined {
		return this._getVariables().find(predicate);
	}

	public filter(predicate: (v: PromptVariable) => boolean): ChatVariablesCollection {
		const resultingReferences: vscode.ChatPromptReference[] = [];
		for (const variable of this._getVariables()) {
			if (predicate(variable)) {
				resultingReferences.push(variable.reference);
			}
		}
		return new ChatVariablesCollection(resultingReferences);
	}

	public *[Symbol.iterator](): IterableIterator<PromptVariable> {
		yield* this._getVariables();
	}

	public substituteVariablesWithReferences(userQuery: string): string {
		// no rewriting at the moment
		return userQuery;
	}

	public hasVariables(): boolean {
		return this._getVariables().length > 0;
	}

	private uniqueFileName(name: string, variables: vscode.ChatPromptReference[]): string {
		const count = variables.filter(v => v.name === name).length;
		return count === 0 ? name : `${name}-${count}`;
	}

}

/**
 * Check if provided variable is a "prompt instruction".
 */
export function isPromptInstruction(variable: PromptVariable): boolean {
	return variable.reference.id.startsWith('vscode.prompt.instructions');
}

/**
 * Check if provided variable is a "prompt instruction text" (index file).
 */
export function isPromptInstructionText(variable: PromptVariable): variable is PromptVariable & { value: string } {
	return variable.reference.id === 'vscode.prompt.instructions.text';
}


/**
 * Check if provided variable is a "prompt file".
 */
export function isPromptFile(variable: PromptVariable): variable is PromptVariable & { value: vscode.Uri } {
	return variable.reference.id.startsWith(PromptFileIdPrefix);
}

export const PromptFileIdPrefix = 'vscode.prompt.file';