/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelToolInformation } from 'vscode';
import { ConfigKey, HARD_TOOL_LIMIT, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { equals as arraysEqual } from '../../../../util/vs/base/common/arrays';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Iterable } from '../../../../util/vs/base/common/iterator';
import { IObservable } from '../../../../util/vs/base/common/observableInternal';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../../vscodeTypes';
import { VIRTUAL_TOOL_NAME_PREFIX, VirtualTool } from './virtualTool';
import { VirtualToolGrouper } from './virtualToolGrouper';
import * as Constant from './virtualToolsConstants';
import { IToolCategorization, IToolGrouping } from './virtualToolTypes';

export function computeToolGroupingMinThreshold(experimentationService: IExperimentationService, configurationService: IConfigurationService): IObservable<number> {
	return configurationService.getExperimentBasedConfigObservable(ConfigKey.VirtualToolThreshold, experimentationService).map(configured => {
		const value = configured ?? HARD_TOOL_LIMIT;
		return value <= 0 ? Infinity : value;
	});
}

export class ToolGrouping implements IToolGrouping {

	private readonly _root = new VirtualTool(VIRTUAL_TOOL_NAME_PREFIX, '', Infinity, { groups: [], toolsetKey: '', preExpanded: true });
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

	public get isEnabled() {
		return this._tools.length >= computeToolGroupingMinThreshold(this._experimentationService, this._configurationService).get();
	}

	constructor(
		private _tools: readonly LanguageModelToolInformation[],
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService
	) {
		this._root.isExpanded = true;
	}

	didCall(localTurnNumber: number, toolCallName: string): LanguageModelToolResult | undefined {
		const result = this._root.find(toolCallName);
		if (!result) {
			return;
		}

		const { path, tool } = result;
		for (const part of path) {
			part.lastUsedOnTurn = this._turnNo;
		}

		if (path.length > 1) { // only for tools in groups under the root
			/* __GDPR__
				"virtualTools.called" : {
					"owner": "connor4312",
					"comment": "Reports information about the usage of virtual tools.",
					"callName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Name of the categorized group (MCP or extension)" },
					"isVirtual": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Whether this called a virtual tool", "isMeasurement": true },
					"turnNo": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "comment": "Number of turns into the loop when this expansion was made", "isMeasurement": true },
					"depth": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Nesting depth of the tool", "isMeasurement": true },
					"preExpanded": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Whether the tool was pre-expanded or expanded on demand", "isMeasurement": true }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('virtualTools.called', {
				owner: 'connor4312',
				callName: tool.name,
			}, {
				turnNo: localTurnNumber,
				isVirtual: tool instanceof VirtualTool ? 1 : 0,
				depth: path.length - 1,
				preExpanded: path.every(p => p.metadata.preExpanded) ? 1 : 0,
			});
		}

		if (!(tool instanceof VirtualTool)) {
			return;
		}

		tool.isExpanded = true;
		return new LanguageModelToolResult([
			new LanguageModelTextPart(`Tools activated: ${[...tool.tools()].map(t => t.name).join(', ')}`),
		]);
	}

	getContainerFor(tool: string): VirtualTool | undefined {
		const result = this._root.find(tool);
		const last = result?.path.at(-1);
		return last === this._root ? undefined : last;
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
			lowest.metadata.preExpanded = false;
		}
		this._trimOnNextCompute = false;
	}
}
