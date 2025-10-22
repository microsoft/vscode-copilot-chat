/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionsExperimentationServiceBridge } from '../../../bridge/src/completionsExperimentationServiceBridge';
import { CopilotToken, CopilotTokenManager } from '../auth/copilotTokenManager';
import { BlockMode } from '../config';
import { Context } from '../context';
import { ExpConfig, ExpTreatmentVariables, ExpTreatmentVariableValue } from './expConfig';
import { Filter, FilterSettings } from './filters';
import { TelemetryData, TelemetryWithExp } from '../telemetry';
import {
	DEFAULT_MAX_COMPLETION_LENGTH,
	DEFAULT_MAX_PROMPT_LENGTH,
	DEFAULT_PROMPT_ALLOCATION_PERCENT,
	DEFAULT_SUFFIX_MATCH_THRESHOLD
} from '../../../prompt/src/prompt';
import { createCompletionsFilters } from './defaultExpFilters';

type CompletionsFiltersInfo = { uri: string; languageId: string };

/** General-purpose API for accessing ExP variable values. */
export class Features {

	constructor(private readonly ctx: Context) { }

	/**
	 * Central logic for obtaining the assignments of treatment groups
	 * for a given set of filters (i.e. descriptors of who is getting the treatment).
	 * Also gets the values of variables controlled by experiment.
	 *
	 * This function should be called **exactly once** at the start of every
	 * 'completion request' in the client (e.g. ghostText, panel request or chat conversation).
	 *
	 * It is called with an initial set of filters, (FeaturesFilterArgs)
	 * but it adds many of its own.
	 * At first the general background filters like extension version.
	 * Then it will check ExP assignments for the first time, to find out
	 * whether there are any assignments of a special granularity
	 * (i.e. the concept that we want to redraw assignments based on
	 * time bucket, or checksum of time, etc).
	 *
	 * On most calls to this function, the assignment fetches will be the
	 * assignments from previously used filters, so they will be cached and return fast.
	 *
	 * @param telemetryData The base telemetry object to which the experimental filters, ExP
	 * variable values, and experimental assignments will be added. All properties and measurements
	 * of the input telemetryData will be present in the output TelemetryWithExp object.
	 * Every telemetry data used to generate ExP scorecards (e.g. ghostText events) must
	 * include the correct experiment assignments in order to properly create those
	 * scorecards.
	 */
	async updateExPValuesAndAssignments(
		filtersInfo?: CompletionsFiltersInfo,
		telemetryData: TelemetryData = TelemetryData.createAndMarkAsIssued()
	): Promise<TelemetryWithExp> {
		// We should not allow accidentally overwriting existing ExP vals/assignments.
		// This doesn't stop all misuse cases, but should prevent some trivial ones.
		if (telemetryData instanceof TelemetryWithExp) {
			throw new Error('updateExPValuesAndAssignments should not be called with TelemetryWithExp');
		}

		const tokenManager = this.ctx.get(CopilotTokenManager);
		const token = tokenManager.token ?? await tokenManager.getToken();
		const { filters, exp } = this.createExpConfigAndFilters(token);

		return new TelemetryWithExp(telemetryData.properties, telemetryData.measurements, telemetryData.issuedTime, {
			filters,
			exp: exp,
		});
	}

	private createExpConfigAndFilters(token: CopilotToken) {
		const expService = this.ctx.get(CompletionsExperimentationServiceBridge).experimentationService;

		const exp2: Partial<Record<ExpTreatmentVariables, ExpTreatmentVariableValue>> = {};
		for (const varName of Object.values<ExpTreatmentVariables>(ExpTreatmentVariables)) {
			const value = expService.getTreatmentVariable(varName);
			if (value !== undefined) {
				exp2[varName] = value;
			}
		}

		const features = Object.entries(exp2).map(([name, value]) => {
			// Based on what tas-client does in https://github.com/microsoft/tas-client/blob/2bd24c976273b671892aad99139af2c7c7dc3b26/tas-client/src/tas-client/FeatureProvider/TasApiFeatureProvider.ts#L59
			return name + (value ? '' : 'cf');
		});
		const exp = new ExpConfig(exp2, features.join(';'));
		const filterMap = createCompletionsFilters(this.ctx, token);
		const filterRecord: Partial<Record<Filter, string>> = {};
		for (const [key, value] of filterMap.entries()) {
			filterRecord[key] = value;
		}

		const filters = new FilterSettings(filterRecord);
		return { filters, exp };
	}

	/** Get the entries from this.assignments corresponding to given settings. */
	async getFallbackExpAndFilters(): Promise<{ filters: FilterSettings; exp: ExpConfig }> {
		const tokenManager = this.ctx.get(CopilotTokenManager);
		const token = tokenManager.token ?? await tokenManager.getToken();
		return this.createExpConfigAndFilters(token);
	}

	disableLogProb(telemetryWithExp: TelemetryWithExp): boolean {
		return (telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.disableLogProb] as boolean) ?? true;
	}

	/** Override for BlockMode to send in the request. */
	overrideBlockMode(telemetryWithExp: TelemetryWithExp): BlockMode | undefined {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.OverrideBlockMode] as BlockMode) ||
			undefined
		);
	}

	/** Functions with arguments, passed via object destructuring */

	/** @returns the string for copilotcustomengine, or "" if none is set. */
	customEngine(telemetryWithExp: TelemetryWithExp): string {
		return (telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.CustomEngine] as string) ?? '';
	}

	/** @returns the string for copilotcustomenginetargetengine, or undefined if none is set. */
	customEngineTargetEngine(telemetryWithExp: TelemetryWithExp): string | undefined {
		return telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.CustomEngineTargetEngine] as string;
	}

	/** @returns the percent of prompt tokens to be allocated to the suffix */
	suffixPercent(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.SuffixPercent] as number) ??
			DEFAULT_PROMPT_ALLOCATION_PERCENT.suffix
		);
	}

	/** @returns the percentage match threshold for using the cached suffix */
	suffixMatchThreshold(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.SuffixMatchThreshold] as number) ??
			DEFAULT_SUFFIX_MATCH_THRESHOLD
		);
	}

	/** @returns whether to enable the inclusion of C++ headers as neighbor files. */
	cppHeadersEnableSwitch(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.CppHeadersEnableSwitch] as boolean) ??
			false
		);
	}

	/** @returns whether to use included related files as neighbor files for C# (vscode experiment). */
	relatedFilesVSCodeCSharp(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.RelatedFilesVSCodeCSharp] as boolean) ??
			false
		);
	}

	/** @returns whether to use included related files as neighbor files for TS/JS (vscode experiment). */
	relatedFilesVSCodeTypeScript(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[
				ExpTreatmentVariables.RelatedFilesVSCodeTypeScript
			] as boolean) ?? false
		);
	}

	/** @returns whether to use included related files as neighbor files (vscode experiment). */
	relatedFilesVSCode(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.RelatedFilesVSCode] as boolean) ?? false
		);
	}

	/** @returns the list of context providers IDs to enable. The special value `*` enables all context providers. */
	contextProviders(telemetryWithExp: TelemetryWithExp): string[] {
		const providers = (telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.ContextProviders] ??
			'') as string;
		if (!providers) {
			return [];
		}
		return providers.split(',').map(provider => provider.trim());
	}

	contextProviderTimeBudget(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.ContextProviderTimeBudget] as number) ??
			150
		);
	}

	includeNeighboringFiles(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.IncludeNeighboringFiles] as boolean) ??
			false
		);
	}

	excludeRelatedFiles(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.ExcludeRelatedFiles] as boolean) ??
			false
		);
	}

	/** @returns the maximal number of tokens of prompt AND completion */
	maxPromptCompletionTokens(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.MaxPromptCompletionTokens] as number) ??
			DEFAULT_MAX_PROMPT_LENGTH + DEFAULT_MAX_COMPLETION_LENGTH
		);
	}

	stableContextPercent(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.StableContextPercent] as number) ??
			DEFAULT_PROMPT_ALLOCATION_PERCENT.stableContext
		);
	}

	volatileContextPercent(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.VolatileContextPercent] as number) ??
			DEFAULT_PROMPT_ALLOCATION_PERCENT.volatileContext
		);
	}

	/** Custom parameters for language specific Context Providers. */
	cppContextProviderParams(telemetryWithExp: TelemetryWithExp): string | undefined {
		const cppContextProviderParams = telemetryWithExp.filtersAndExp.exp.variables[
			ExpTreatmentVariables.CppContextProviderParams
		] as string;
		return cppContextProviderParams;
	}

	csharpContextProviderParams(telemetryWithExp: TelemetryWithExp): string | undefined {
		const csharpContextProviderParams = telemetryWithExp.filtersAndExp.exp.variables[
			ExpTreatmentVariables.CSharpContextProviderParams
		] as string;
		return csharpContextProviderParams;
	}

	javaContextProviderParams(telemetryWithExp: TelemetryWithExp): string | undefined {
		const javaContextProviderParams = telemetryWithExp.filtersAndExp.exp.variables[
			ExpTreatmentVariables.JavaContextProviderParams
		] as string;
		return javaContextProviderParams;
	}

	multiLanguageContextProviderParams(telemetryWithExp: TelemetryWithExp): string | undefined {
		const multiLanguageContextProviderParams = telemetryWithExp.filtersAndExp.exp.variables[
			ExpTreatmentVariables.MultiLanguageContextProviderParams
		] as string;
		return multiLanguageContextProviderParams;
	}

	tsContextProviderParams(telemetryWithExp: TelemetryWithExp): string | undefined {
		const tsContextProviderParams = telemetryWithExp.filtersAndExp.exp.variables[
			ExpTreatmentVariables.TsContextProviderParams
		] as string;
		return tsContextProviderParams;
	}

	completionsDebounce(telemetryWithExp: TelemetryWithExp): number | undefined {
		return telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.CompletionsDebounce] as
			| number
			| undefined;
	}

	enableElectronFetcher(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.ElectronFetcher] as boolean) ?? false
		);
	}

	enableFetchFetcher(telemetryWithExp: TelemetryWithExp): boolean {
		return (telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.FetchFetcher] as boolean) ?? false;
	}

	asyncCompletionsTimeout(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.AsyncCompletionsTimeout] as number) ??
			200
		);
	}

	enablePromptContextProxyField(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[
				ExpTreatmentVariables.EnablePromptContextProxyField
			] as boolean) ?? true // Exp is set to true to 100%
		);
	}

	enableProgressiveReveal(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.ProgressiveReveal] as boolean) ?? false
		);
	}

	modelAlwaysTerminatesSingleline(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[
				ExpTreatmentVariables.ModelAlwaysTerminatesSingleline
			] as boolean) ?? true
		);
	}

	longLookaheadSize(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[
				ExpTreatmentVariables.ProgressiveRevealLongLookaheadSize
			] as number) ?? 9
		);
	}

	shortLookaheadSize(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[
				ExpTreatmentVariables.ProgressiveRevealShortLookaheadSize
			] as number) ?? 3
		);
	}

	maxMultilineTokens(telemetryWithExp: TelemetryWithExp): number {
		// p50 line length is 19 characters (p95 is 73)
		// average token length is around 4 characters
		// the below value has quite a bit of buffer while bringing the limit in significantly from 500
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.MaxMultilineTokens] as number) ?? 200
		);
	}

	multilineAfterAcceptLines(telemetryWithExp: TelemetryWithExp): number {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.MultilineAfterAcceptLines] as number) ??
			1
		);
	}

	completionsDelay(telemetryWithExp: TelemetryWithExp): number {
		return (telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.CompletionsDelay] as number) ?? 200;
	}

	singleLineUnlessAccepted(telemetryWithExp: TelemetryWithExp): boolean {
		return (
			(telemetryWithExp.filtersAndExp.exp.variables[ExpTreatmentVariables.SingleLineUnlessAccepted] as boolean) ??
			false
		);
	}
}
