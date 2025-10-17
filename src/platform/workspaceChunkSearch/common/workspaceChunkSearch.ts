/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { GlobIncludeOptions } from '../../../util/common/glob';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { FileChunkAndScore } from '../../chunking/common/chunk';
import { Embedding } from '../../embeddings/common/embeddingsComputer';
import { IChatEndpoint } from '../../networking/common/networking';

export interface KeywordItem {
	readonly keyword: string;
	readonly variations: readonly string[];
}

export interface ResolvedWorkspaceChunkQuery {
	/**
	 * The resolved text of the query.
	 *
	 * This resolves ambagious pronouns and words in the query.
	 */
	readonly rephrasedQuery: string;
	readonly keywords: readonly KeywordItem[];
}

export interface WorkspaceChunkQuery {
	/**
	 * The original text of the query.
	 */
	readonly rawQuery: string;

	/**
	 * Only resolves the query part of the query, not the keywords.
	 *
	 * May skip resolving if the query does not appear ambiguous.
	 */
	resolveQuery(token: CancellationToken): Promise<string>;

	/**
	 * Fully resolves the query and generates keywords for it.
	 */
	resolveQueryAndKeywords(token: CancellationToken): Promise<ResolvedWorkspaceChunkQuery>;
}

export interface WorkspaceChunkQueryWithEmbeddings extends WorkspaceChunkQuery {
	resolveQueryEmbeddings(token: CancellationToken): Promise<Embedding>;
}

/**
 * Internal ids used to identify strategies in telemetry.
 */
export enum WorkspaceChunkSearchStrategyId {
	Embeddings = 'ada',// Do not change value as it's used for telemetry
	CodeSearch = 'codesearch',
	Tfidf = 'tfidf',
	FullWorkspace = 'fullWorkspace'
}

/**
 * Sizing hints for the search strategy.
 */
export interface StrategySearchSizing {
	readonly endpoint: IChatEndpoint;
	readonly tokenBudget: number | undefined;
	readonly fullWorkspaceTokenBudget: number | undefined;
	readonly maxResultCountHint: number;
}

export interface WorkspaceChunkSearchOptions {
	readonly globPatterns?: GlobIncludeOptions;
	readonly enableRerank?: boolean;
}

export interface StrategySearchResult {
	readonly chunks: readonly FileChunkAndScore[];
	readonly alerts?: readonly WorkspaceSearchAlert[];
}

export type WorkspaceSearchAlert =
	| vscode.ChatResponseWarningPart
	| vscode.ChatResponseCommandButtonPart
	| vscode.ChatResponseMarkdownPart;

export interface IWorkspaceChunkSearchStrategy {
	readonly id: WorkspaceChunkSearchStrategyId;

	/**
	 * Invoked before the search is performed.
	 *
	 * This can be used to prompt the user or perform other actions.
	 *
	 * Unlike time spent in `searchWorkspace`, this method will not count towards timeouts
	 */
	prepareSearchWorkspace?(
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken,
	): Promise<void>;

	/**
	 * Takes search queries and returns the chunks of text that are most semantically similar to any of the queries.
	 *
	 * @return Either the result (which may have zero chunks) or undefined if the search could not be performed.
	 */
	searchWorkspace(
		sizing: StrategySearchSizing,
		query: WorkspaceChunkQueryWithEmbeddings,
		options: WorkspaceChunkSearchOptions,
		telemetryInfo: TelemetryCorrelationId,
		token: CancellationToken
	): Promise<StrategySearchResult | undefined>;
}
