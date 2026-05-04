/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { createServiceIdentifier } from '../../../util/common/services';
import { LanguageModelTextPart } from '../../../vscodeTypes';

export const IToolResultCompressor = createServiceIdentifier<IToolResultCompressor>('IToolResultCompressor');

/**
 * Result of running a {@link IToolResultFilter}.
 *
 * `text` is the new text to substitute back into the corresponding text part.
 * `compressed` is `true` if any compression actually happened — used purely
 * for telemetry / accounting.
 */
export interface IToolResultFilterOutput {
	readonly text: string;
	readonly compressed: boolean;
}

/**
 * A pure function that compresses a single text part of a tool result.
 *
 * Implementations MUST never make output worse than the input. If a filter
 * cannot improve a piece of text, it should return the original `text` and
 * `compressed: false`.
 */
export interface IToolResultFilter {
	readonly id: string;
	/** Tool names this filter applies to. */
	readonly toolNames: readonly string[];
	/**
	 * Decide whether this filter wants to handle the result. May inspect tool
	 * input (e.g. for `run_in_terminal`, the command being run).
	 */
	matches(toolName: string, input: unknown): boolean;
	apply(text: string, input: unknown): IToolResultFilterOutput;
}

export interface IToolResultCompressor {
	readonly _serviceBrand: undefined;
	registerFilter(filter: IToolResultFilter): void;
	/**
	 * Returns a possibly-compressed copy of `result`, or `undefined` if no
	 * compression was applied (caller should pass through the original).
	 */
	maybeCompress(toolName: string, input: unknown, result: vscode.LanguageModelToolResult | vscode.LanguageModelToolResult2): vscode.LanguageModelToolResult | undefined;
}

/**
 * Outputs at or below this size are not worth compressing.
 * Mirrors ztk's 80-byte minimum.
 */
const MIN_COMPRESSIBLE_LENGTH = 80;

export class ToolResultCompressorService implements IToolResultCompressor {
	declare readonly _serviceBrand: undefined;

	private readonly _filters = new Map<string, IToolResultFilter[]>();

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
	) { }

	registerFilter(filter: IToolResultFilter): void {
		for (const name of filter.toolNames) {
			let bucket = this._filters.get(name);
			if (!bucket) {
				bucket = [];
				this._filters.set(name, bucket);
			}
			bucket.push(filter);
		}
	}

	maybeCompress(toolName: string, input: unknown, result: vscode.LanguageModelToolResult | vscode.LanguageModelToolResult2): vscode.LanguageModelToolResult | undefined {
		if (!this._configurationService.getConfig(ConfigKey.ToolResultCompressionEnabled)) {
			return undefined;
		}

		const filters = this._filters.get(toolName);
		if (!filters || filters.length === 0) {
			return undefined;
		}

		const matchingFilters = filters.filter(f => f.matches(toolName, input));
		if (matchingFilters.length === 0) {
			return undefined;
		}

		let totalBefore = 0;
		let totalAfter = 0;
		let anyCompressed = false;
		const usedFilterIds = new Set<string>();

		const newContent = result.content.map(part => {
			if (!(part instanceof LanguageModelTextPart)) {
				return part;
			}
			const original = part.value;
			if (original.length < MIN_COMPRESSIBLE_LENGTH) {
				return part;
			}

			let current = original;
			for (const filter of matchingFilters) {
				try {
					const out = filter.apply(current, input);
					if (out.compressed && out.text.length < current.length) {
						current = out.text;
						usedFilterIds.add(filter.id);
					}
				} catch (err) {
					// "Never make it worse." Drop the filter on error and keep going.
					this._logService.warn(`[ToolResultCompressor] filter ${filter.id} threw on tool ${toolName}: ${err}`);
				}
			}

			totalBefore += original.length;
			totalAfter += current.length;
			if (current !== original) {
				anyCompressed = true;
				return new LanguageModelTextPart(current);
			}
			return part;
		});

		if (!anyCompressed) {
			return undefined;
		}

		this._sendTelemetry(toolName, [...usedFilterIds], totalBefore, totalAfter);

		// Preserve `toolResultMessage`/`toolResultDetails` if present (ExtendedLanguageModelToolResult shape).
		const compressed: vscode.LanguageModelToolResult & { toolResultMessage?: unknown; toolResultDetails?: unknown } =
			Object.assign(Object.create(Object.getPrototypeOf(result)), result, { content: newContent });
		return compressed as vscode.LanguageModelToolResult;
	}

	private _sendTelemetry(toolName: string, filterIds: string[], beforeBytes: number, afterBytes: number) {
		/* __GDPR__
			"toolResultCompressed" : {
				"owner": "meganrogge",
				"comment": "Reports tool output compression savings.",
				"toolName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The tool whose output was compressed." },
				"filters": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Comma-separated filter ids that fired." },
				"beforeBytes": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Total text part bytes before compression." },
				"afterBytes": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Total text part bytes after compression." }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent(
			'toolResultCompressed',
			{ toolName, filters: filterIds.join(',') },
			{ beforeBytes, afterBytes },
		);
	}
}
