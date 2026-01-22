/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assertNever } from '../../../../util/vs/base/common/assert';
import { IValidator, vBoolean, vEnum, vNumber, vObj, vRequired, vString, vUndefined, vUnion } from '../../../configuration/common/validator';

export type RecentlyViewedDocumentsOptions = {
	readonly nDocuments: number;
	readonly maxTokens: number;
	readonly includeViewedFiles: boolean;
	readonly includeLineNumbers: boolean;
}

export type LanguageContextLanguages = { [languageId: string]: boolean };

export type LanguageContextOptions = {
	readonly enabled: boolean;
	readonly maxTokens: number;
	readonly traitPosition: 'before' | 'after';
}

export type DiffHistoryOptions = {
	readonly nEntries: number;
	readonly maxTokens: number;
	readonly onlyForDocsInPrompt: boolean;
	readonly useRelativePaths: boolean;
}

export type PagedClipping = { pageSize: number };

export type CurrentFileOptions = {
	readonly maxTokens: number;
	readonly includeTags: boolean;
	readonly prioritizeAboveCursor: boolean;
}

export enum LintOptionWarning {
	YES = 'yes',
	NO = 'no',
	YES_IF_NO_ERRORS = 'yesIfNoErrors',
}
export enum LintOptionShowCode {
	YES = 'yes',
	NO = 'no',
	YES_WITH_SURROUNDING = 'yesWithSurroundingLines',
}
export type LintOptions = {
	tagName: string; // name to use in tag e.g "linter diagnostics" => <|linter diagnostics|>...</|linter diagnostics|>
	warnings: LintOptionWarning;
	showCode: LintOptionShowCode;
	maxLints: number;
	maxLineDistance: number;
}

export enum AggressivenessLevel {
	Low = 'low',
	Medium = 'medium',
	High = 'high',
}

export type PromptOptions = {
	readonly promptingStrategy: PromptingStrategy | undefined /* default */;
	readonly currentFile: CurrentFileOptions;
	readonly pagedClipping: PagedClipping;
	readonly recentlyViewedDocuments: RecentlyViewedDocumentsOptions;
	readonly languageContext: LanguageContextOptions;
	readonly diffHistory: DiffHistoryOptions;
	readonly includePostScript: boolean;
	readonly lintOptions: LintOptions | undefined;
}

/**
 * Prompt strategies that tweak prompt in a way that's different from current prod prompting strategy.
 */
export enum PromptingStrategy {
	/**
	 * Original Xtab unified model prompting strategy.
	 */
	CopilotNesXtab = 'copilotNesXtab',
	UnifiedModel = 'xtabUnifiedModel',
	Codexv21NesUnified = 'codexv21nesUnified',
	Nes41Miniv3 = 'nes41miniv3',
	SimplifiedSystemPrompt = 'simplifiedSystemPrompt',
	Xtab275 = 'xtab275',
	XtabAggressiveness = 'xtabAggressiveness',
	PatchBased = 'patchBased',
}

export function isPromptingStrategy(value: string): value is PromptingStrategy {
	return (Object.values(PromptingStrategy) as string[]).includes(value);
}

export enum ResponseFormat {
	CodeBlock = 'codeBlock',
	UnifiedWithXml = 'unifiedWithXml',
	EditWindowOnly = 'editWindowOnly',
	CustomDiffPatch = 'customDiffPatch',
}

export namespace ResponseFormat {
	export function fromPromptingStrategy(strategy: PromptingStrategy | undefined): ResponseFormat {
		switch (strategy) {
			case PromptingStrategy.UnifiedModel:
			case PromptingStrategy.Codexv21NesUnified:
			case PromptingStrategy.Nes41Miniv3:
				return ResponseFormat.UnifiedWithXml;
			case PromptingStrategy.Xtab275:
			case PromptingStrategy.XtabAggressiveness:
				return ResponseFormat.EditWindowOnly;
			case PromptingStrategy.PatchBased:
				return ResponseFormat.CustomDiffPatch;
			case PromptingStrategy.SimplifiedSystemPrompt:
			case PromptingStrategy.CopilotNesXtab:
			case undefined:
				return ResponseFormat.CodeBlock;
			default:
				assertNever(strategy);
		}
	}
}

export const DEFAULT_OPTIONS: PromptOptions = {
	promptingStrategy: undefined,
	currentFile: {
		maxTokens: 2000,
		includeTags: true,
		prioritizeAboveCursor: false,
	},
	pagedClipping: {
		pageSize: 10,
	},
	recentlyViewedDocuments: {
		nDocuments: 5,
		maxTokens: 2000,
		includeViewedFiles: false,
		includeLineNumbers: false,
	},
	languageContext: {
		enabled: false,
		maxTokens: 2000,
		traitPosition: 'after',
	},
	diffHistory: {
		nEntries: 25,
		maxTokens: 1000,
		onlyForDocsInPrompt: false,
		useRelativePaths: false,
	},
	lintOptions: undefined,
	includePostScript: true,
};

// TODO: consider a better per language setting/experiment approach
export const LANGUAGE_CONTEXT_ENABLED_LANGUAGES: LanguageContextLanguages = {
	'prompt': true,
	'instructions': true,
	'chatagent': true,
};

export interface ModelConfiguration {
	modelName: string;
	promptingStrategy: PromptingStrategy | undefined /* default */;
	includeTagsInCurrentFile: boolean;
	lintOptions: LintOptions | undefined;
}

export const LINT_OPTIONS_VALIDATOR: IValidator<LintOptions> = vObj({
	'tagName': vRequired(vString()),
	'warnings': vRequired(vEnum(LintOptionWarning.YES, LintOptionWarning.NO, LintOptionWarning.YES_IF_NO_ERRORS)),
	'showCode': vRequired(vEnum(LintOptionShowCode.NO, LintOptionShowCode.YES, LintOptionShowCode.YES_WITH_SURROUNDING)),
	'maxLints': vRequired(vNumber()),
	'maxLineDistance': vRequired(vNumber()),
});

export const MODEL_CONFIGURATION_VALIDATOR: IValidator<ModelConfiguration> = vObj({
	'modelName': vRequired(vString()),
	'promptingStrategy': vUnion(vEnum(...Object.values(PromptingStrategy)), vUndefined()),
	'includeTagsInCurrentFile': vRequired(vBoolean()),
	'lintOptions': vUnion(LINT_OPTIONS_VALIDATOR, vUndefined()),
});

export interface UserHappinessScoreConfiguration {
	/** Score for accepted actions (0-1, default: 1) */
	acceptedScore: number;
	/** Score for rejected actions (0-1, default: 0.2) */
	rejectedScore: number;
	/** Score for ignored/notAccepted actions (0-1, default: 0.5) */
	ignoredScore: number;
	/** Threshold for high aggressiveness level (default: 0.6) */
	highThreshold: number;
	/** Threshold for medium aggressiveness level (default: 0.4) */
	mediumThreshold: number;
	/** Whether to include ignored/notAccepted actions in score calculation (default: false) */
	includeIgnored: boolean;
	/** Maximum number of ignored/notAccepted actions to consider (default: 5) */
	ignoredLimit: number;
	/** Whether to limit consecutive ignored actions (default: false) */
	limitConsecutiveIgnored: boolean;
	/** Whether to limit total ignored actions (default: true) */
	limitTotalIgnored: boolean;
}

export const USER_HAPPINESS_SCORE_CONFIGURATION_VALIDATOR: IValidator<UserHappinessScoreConfiguration> = vObj({
	'acceptedScore': vRequired(vNumber()),
	'rejectedScore': vRequired(vNumber()),
	'ignoredScore': vRequired(vNumber()),
	'highThreshold': vRequired(vNumber()),
	'mediumThreshold': vRequired(vNumber()),
	'includeIgnored': vRequired(vBoolean()),
	'ignoredLimit': vRequired(vNumber()),
	'limitConsecutiveIgnored': vRequired(vBoolean()),
	'limitTotalIgnored': vRequired(vBoolean()),
});

/**
 * Default configuration for user happiness score calculation. Mimics v1 behavior.
 */
export const DEFAULT_USER_HAPPINESS_SCORE_CONFIGURATION: UserHappinessScoreConfiguration = {
	acceptedScore: 1,
	rejectedScore: 0,
	ignoredScore: 0.5,
	highThreshold: 0.7,
	mediumThreshold: 0.4,
	includeIgnored: false,
	ignoredLimit: 0,
	limitConsecutiveIgnored: false,
	limitTotalIgnored: true,
};

export function parseLintOptionString(optionString: string): LintOptions | undefined {
	try {
		const parsed = JSON.parse(optionString);

		const lintValidation = LINT_OPTIONS_VALIDATOR.validate(parsed);
		if (lintValidation.error) {
			throw new Error(`Lint options validation failed: ${lintValidation.error.message}`);
		}

		return lintValidation.content;
	} catch (e) {
		throw new Error(`Failed to parse lint options string: ${e}`);
	}
}
