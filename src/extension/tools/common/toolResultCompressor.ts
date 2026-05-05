/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { createServiceIdentifier } from '../../../util/common/services';
import { LanguageModelTextPart, LanguageModelTextPart2 } from '../../../vscodeTypes';

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
 * Outputs at or below this many characters (UTF-16 code units, i.e.
 * `string.length`) are not worth compressing. Mirrors ztk's 80-character
 * minimum.
 */
const MIN_COMPRESSIBLE_LENGTH = 80;

/**
 * Format the banner that gets prepended to compressed text parts so the
 * model knows compression happened, which filters fired, and how to opt out.
 */
function formatCompressionBanner(filterIds: readonly string[], beforeChars: number, afterChars: number): string {
	const ids = filterIds.length > 0 ? filterIds.join(', ') : 'unknown';
	return `[Output compressed by ${ids} (${beforeChars} → ${afterChars} chars). To disable, set chat.tools.compressOutput.enabled to false.]`;
}

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

		// Mutable copy: filters that throw get spliced out so we don't repeatedly
		// invoke a broken filter on every subsequent text part in this pass.
		const activeFilters = matchingFilters.slice();
		const disabledFilterIds = new Set<string>();

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
			const partFilterIds: string[] = [];
			for (let i = 0; i < activeFilters.length; /* manual increment */) {
				const filter = activeFilters[i];
				try {
					const out = filter.apply(current, input);
					if (out.compressed && out.text.length < current.length) {
						current = out.text;
						usedFilterIds.add(filter.id);
						partFilterIds.push(filter.id);
					}
					i++;
				} catch (err) {
					// "Never make it worse." Disable the filter for the rest of this
					// compression pass so it can't repeatedly throw on later text parts,
					// and warn at most once per filter.
					activeFilters.splice(i, 1);
					if (!disabledFilterIds.has(filter.id)) {
						disabledFilterIds.add(filter.id);
						this._logService.warn(`[ToolResultCompressor] filter ${filter.id} threw on tool ${toolName}; disabled for this pass: ${err}`);
					}
				}
			}

			totalBefore += original.length;
			totalAfter += current.length;
			if (current !== original) {
				anyCompressed = true;
				// Prepend a banner so the model knows the output was filtered, by
				// which filters, and how to disable compression. We only annotate
				// the parts we actually changed — non-compressed parts pass through
				// untouched.
				const banner = formatCompressionBanner(partFilterIds, original.length, current.length);
				const annotated = `${banner}\n${current}`;
				// Preserve LanguageModelTextPart2 audience metadata if present.
				if (part instanceof LanguageModelTextPart2) {
					return new LanguageModelTextPart2(annotated, part.audience);
				}
				return new LanguageModelTextPart(annotated);
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

	private _sendTelemetry(toolName: string, filterIds: string[], beforeChars: number, afterChars: number) {
		/* __GDPR__
			"toolResultCompressed" : {
				"owner": "meganrogge",
				"comment": "Reports tool output compression savings.",
				"toolName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The tool whose output was compressed." },
				"filters": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Comma-separated filter ids that fired." },
				"beforeChars": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Total text part length in UTF-16 code units before compression." },
				"afterChars": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "Total text part length in UTF-16 code units after compression." }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent(
			'toolResultCompressed',
			{ toolName, filters: filterIds.join(',') },
			{ beforeChars, afterChars },
		);
	}
}
