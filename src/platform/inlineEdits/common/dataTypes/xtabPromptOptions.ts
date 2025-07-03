/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type RecentlyViewedDocumentsOptions = {
	readonly nDocuments: number;
	readonly maxTokens: number;
	readonly includeViewedFiles: boolean;
}

export type LanguageContextOptions = {
	readonly enabled: boolean;
	readonly maxTokens: number;
}

export type DiffHistoryOptions = {
	readonly nEntries: number;
	readonly maxTokens: number;
	readonly onlyForDocsInPrompt: boolean;
}

export type PagedClipping = { pageSize: number };

export type PromptOptions = {
	readonly promptingStrategy: PromptingStrategy | undefined /* default */;
	readonly currentFileMaxTokens: number;
	readonly includeTagsInCurrentFile: boolean;
	readonly pagedClipping: PagedClipping;
	readonly recentlyViewedDocuments: RecentlyViewedDocumentsOptions;
	readonly languageContext: LanguageContextOptions;
	readonly diffHistory: DiffHistoryOptions;
}

export enum PromptingStrategy {
	UnifiedModel = 'unifiedModel',
	SimplifiedSystemPrompt = 'simplifiedSystemPrompt',
	Xtab275 = 'xtab275',
}

export const DEFAULT_OPTIONS: PromptOptions = {
	promptingStrategy: undefined,
	currentFileMaxTokens: 2000,
	includeTagsInCurrentFile: true,
	pagedClipping: {
		pageSize: 10,
	},
	recentlyViewedDocuments: {
		nDocuments: 5,
		maxTokens: 2000,
		includeViewedFiles: false,
	},
	languageContext: {
		enabled: false,
		maxTokens: 2000,
	},
	diffHistory: {
		nEntries: 25,
		maxTokens: 1000,
		onlyForDocsInPrompt: false,
	},
};
