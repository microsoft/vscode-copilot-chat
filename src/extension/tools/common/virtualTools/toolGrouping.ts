/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { HARD_TOOL_LIMIT } from '../../../../platform/configuration/common/configurationService';
import { equals as arraysEqual } from '../../../../util/vs/base/common/arrays';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Iterable } from '../../../../util/vs/base/common/iterator';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../../vscodeTypes';
import { VIRTUAL_TOOL_NAME_PREFIX, VirtualTool } from './virtualTool';
import { VirtualToolGrouper } from './virtualToolGrouper';
import * as Constant from './virtualToolsConstants';
import { IToolCategorization, IToolGrouping } from './virtualToolTypes';

export class ToolGrouping implements IToolGrouping {

	private readonly _root = new VirtualTool(VIRTUAL_TOOL_NAME_PREFIX, '', Infinity, undefined);
	protected _grouper: IToolCategorization = this._instantiationService.createInstance(VirtualToolGrouper);
	private _didToolsChange = true;
	private _turnNo = 0;
	private _trimOnNextCompute = false;

	public get tools(): readonly LanguageModelToolInformation[] {
		return this._tools;
	}

	public set tools(tools: readonly LanguageModelToolInformation[]) {
		if (!arraysEqual(this._tools, tools, (a, b) => a.name === b.name)) {
			this._tools = tools;
			// Keep the root so that we can still expand any in-flight requests.
			this._didToolsChange = true;
		}
	}

	constructor(
		private _tools: readonly LanguageModelToolInformation[],
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		this._root.isExpanded = true;
	}

	didCall(toolCallName: string): LanguageModelToolResult | undefined {
		const tool = this._root.findAndTouch(toolCallName, this._turnNo);
		if (!(tool instanceof VirtualTool)) {
			return;
		}

		tool.isExpanded = true;
		return new LanguageModelToolResult([
			new LanguageModelTextPart(`Tools activated: ${[...tool.tools()].map(t => t.name).join(', ')}`),
		]);
	}

	didTakeTurn(): void {
		this._turnNo++;
	}

	didInvalidateCache(): void {
		this._trimOnNextCompute = true;
	}

	async compute(token: CancellationToken): Promise<LanguageModelToolInformation[]> {
		await this._doCompute(token);
		return [...this._root.tools()];
	}

	async computeAll(token: CancellationToken): Promise<(LanguageModelToolInformation | VirtualTool)[]> {
		await this._doCompute(token);
		return this._root.contents;
	}

	private async _doCompute(token: CancellationToken) {
		if (this._didToolsChange) {
			await this._grouper.addGroups(this._root, this._tools.slice(), token);
			this._didToolsChange = false;
		}

		let trimDownTo = HARD_TOOL_LIMIT;

		if (this._trimOnNextCompute) {
			trimDownTo = Constant.TRIM_THRESHOLD;
			this._trimOnNextCompute = false;
		}

		this._root.lastUsedOnTurn = Infinity; // ensure the root doesn't get trimmed out

		while (Iterable.length(this._root.tools()) > trimDownTo) {
			const lowest = this._root.getLowestExpandedTool();
			if (!lowest || lowest === this._root) {
				break; // No more tools to trim.
			}

			lowest.isExpanded = false;
		}
		this._trimOnNextCompute = false;
	}
}
