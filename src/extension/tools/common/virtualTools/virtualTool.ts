/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';

export const VIRTUAL_TOOL_NAME_PREFIX = 'activate_';

export class VirtualTool<TGroupMetadata = any> {
	public isExpanded = false;
	public contents: (LanguageModelToolInformation | VirtualTool<TGroupMetadata>)[] = [];

	constructor(
		public readonly name: string,
		public readonly description: string,
		public lastUsedOnTurn: number,
		public readonly groupMetadata: TGroupMetadata,
	) {
		if (!name.startsWith(VIRTUAL_TOOL_NAME_PREFIX)) {
			throw new Error(`Virtual tool name must start with '${VIRTUAL_TOOL_NAME_PREFIX}'`);
		}
	}

	/**
	 * Looks up a tool. Update the {@link lastUsedOnTurn} of all virtual tools
	 * it touches.
	 */
	public findAndTouch(name: string, turnNumber: number): VirtualTool<TGroupMetadata> | LanguageModelToolInformation | undefined {
		this.lastUsedOnTurn = turnNumber;

		if (this.name === name) {
			return this;
		}

		for (const content of this.contents) {
			if (content instanceof VirtualTool) {
				const found = content.findAndTouch(name, turnNumber);
				if (found) {
					return found;
				}
			}
		}

		return undefined;
	}

	/**
	 * Gets the tool with the lowest {@link lastUsedOnTurn} that is expanded.
	 */
	public getLowestExpandedTool(): VirtualTool<TGroupMetadata> | undefined {
		let lowest: VirtualTool<TGroupMetadata> | undefined;

		for (const tool of this.all()) {
			if (tool instanceof VirtualTool && tool.isExpanded) {
				if (!lowest || tool.lastUsedOnTurn < lowest.lastUsedOnTurn) {
					lowest = tool;
				}
			}
		}

		return lowest;
	}

	public *all(): Iterable<LanguageModelToolInformation | VirtualTool<TGroupMetadata>> {
		yield this;
		for (const content of this.contents) {
			if (content instanceof VirtualTool) {
				yield* content.all();
			} else {
				yield content;
			}
		}
	}

	public *tools(): Iterable<LanguageModelToolInformation> {
		if (!this.isExpanded) {
			yield {
				name: this.name,
				description: this.description,
				inputSchema: undefined,
				source: undefined,
				tags: [],
			};
			return;
		}

		for (const content of this.contents) {
			if (content instanceof VirtualTool) {
				yield* content.tools();
			} else {
				yield content;
			}
		}
	}
}
