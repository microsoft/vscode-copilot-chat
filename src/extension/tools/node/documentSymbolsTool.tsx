/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptPiece, PromptReference, PromptSizing, TextChunk } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ILanguageFeaturesService } from '../../../platform/languages/common/languageFeaturesService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtendedLanguageModelToolResult, LanguageModelPromptTsxPart, Location, MarkdownString, SymbolKind } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { Tag } from '../../prompts/node/base/tag';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { assertFileOkForTool, checkCancellation, resolveToolInputPath } from './toolUtils';

interface IDocumentSymbolsToolParams {
	filePath: string;
	maxItems?: number;
	pageSize?: number;
	page?: number;
	reset?: boolean;
}

const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 200;
interface FlattenedSymbol {
	readonly name: string;
	readonly kind: SymbolKind;
	readonly detail: string | undefined;
	readonly range: vscode.Range;
	readonly depth: number;
}

interface CachedSymbols {
	readonly version: number;
	readonly flattened: readonly FlattenedSymbol[];
}

class DocumentSymbolsTool implements ICopilotTool<IDocumentSymbolsToolParams> {
	public static readonly toolName = ToolName.DocumentSymbols;
	private _promptContext: IBuildPromptContext | undefined;
	private readonly _symbolCache = new Map<string, CachedSymbols>();

	constructor(
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathService: IPromptPathRepresentationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDocumentSymbolsToolParams>, token: CancellationToken) {
		const { input } = options;
		const uri = resolveToolInputPath(input.filePath, this.promptPathService);
		const paging = normalizePagingOptions(input);

		await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, uri));

		const document = await this.workspaceService.openTextDocument(uri);
		const flattened = await this.getFlattenedSymbols(uri, document, paging.reset, token);
		const totalSymbols = flattened.length;
		const totalPages = Math.max(1, Math.ceil(totalSymbols / paging.pageSize));
		const currentPage = Math.min(paging.page, totalPages);
		const pageStartIndex = totalSymbols === 0 ? 0 : (currentPage - 1) * paging.pageSize;
		const pageEndExclusive = totalSymbols === 0 ? 0 : Math.min(pageStartIndex + paging.pageSize, totalSymbols);
		const pageSymbols = flattened.slice(pageStartIndex, pageEndExclusive);
		const hasMore = currentPage < totalPages;
		const rangeStart = pageSymbols.length ? pageStartIndex + 1 : 0;
		const rangeEnd = pageSymbols.length ? pageStartIndex + pageSymbols.length : 0;
		const remainingPages = hasMore ? totalPages - currentPage : 0;
		const filePath = this.promptPathService.getFilePath(uri);

		const prompt = await renderPromptElementJSON(
			this.instantiationService,
			DocumentSymbolsResult,
			{
				uri,
				symbols: pageSymbols,
				truncated: hasMore,
				requested: totalSymbols,
				maxItems: paging.pageSize,
				filePath,
				promptContext: this._promptContext,
				page: currentPage,
				totalPages,
				totalSymbols,
				pageSize: paging.pageSize,
				rangeStart,
				rangeEnd,
				hasMore,
				remainingPages,
			},
			options.tokenizationOptions,
			token
		);

		const result = new ExtendedLanguageModelToolResult([
			new LanguageModelPromptTsxPart(prompt)
		]);

		const toolMessage = buildResultMessage(uri, currentPage, totalPages, rangeStart, rangeEnd, totalSymbols, hasMore, remainingPages);
		result.toolResultMessage = new MarkdownString(toolMessage);
		result.toolResultDetails = pageSymbols.map(entry => new Location(uri, entry.range));

		return result;
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDocumentSymbolsToolParams>, _token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation | undefined> {
		const { input } = options;
		if (!input.filePath) {
			return;
		}
		try {
			const uri = resolveToolInputPath(input.filePath, this.promptPathService);
			await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, uri));
			const document = await this.workspaceService.openTextDocument(uri);
			const languageId = document.languageId;
			const paging = normalizePagingOptions(input);
			const filePath = this.promptPathService.getFilePath(uri);
			return {
				invocationMessage: new MarkdownString(l10n.t('Listing page {0} (size {1}) of document symbols from {2} ({3}).', paging.page, paging.pageSize, filePath, languageId)),
				pastTenseMessage: new MarkdownString(l10n.t('Listed document symbols from {0}.', filePath))
			};
		} catch {
			return;
		}
	}

	async resolveInput(input: IDocumentSymbolsToolParams, promptContext: IBuildPromptContext, _mode: unknown): Promise<IDocumentSymbolsToolParams> {
		this._promptContext = promptContext;
		const paging = normalizePagingOptions(input);
		return {
			...input,
			maxItems: paging.pageSize,
			pageSize: paging.pageSize,
			page: paging.page,
			reset: paging.reset
		};
	}

	private async getFlattenedSymbols(uri: URI, document: vscode.TextDocument, reset: boolean, token: CancellationToken): Promise<readonly FlattenedSymbol[]> {
		const cacheKey = uri.toString(true);
		const cached = this._symbolCache.get(cacheKey);
		if (!reset && cached && cached.version === document.version) {
			return cached.flattened;
		}

		checkCancellation(token);
		const symbols = await this.languageFeaturesService.getDocumentSymbols(uri) ?? [];
		checkCancellation(token);
		const flattened = flattenDocumentSymbols(symbols);
		this._symbolCache.set(cacheKey, { version: document.version, flattened });
		return flattened;
	}
}

ToolRegistry.registerTool(DocumentSymbolsTool);

interface DocumentSymbolsResultProps extends BasePromptElementProps {
	readonly uri: URI;
	readonly symbols: readonly FlattenedSymbol[];
	readonly truncated: boolean;
	readonly requested: number;
	readonly maxItems: number;
	readonly filePath: string;
	readonly promptContext: IBuildPromptContext | undefined;
	readonly page: number;
	readonly totalPages: number;
	readonly totalSymbols: number;
	readonly pageSize: number;
	readonly rangeStart: number;
	readonly rangeEnd: number;
	readonly hasMore: boolean;
	readonly remainingPages: number;
}

class DocumentSymbolsResult extends PromptElement<DocumentSymbolsResultProps> {
	override render(state: void, sizing: PromptSizing): PromptPiece | undefined {
		if (this.props.totalSymbols === 0) {
			return <>
				<Tag name='documentSymbols' attrs={{ path: this.props.filePath }}>
					<TextChunk priority={50}>{l10n.t('No document symbols were found in {0}.', this.props.filePath)}</TextChunk>
				</Tag>
			</>;
		}

		const header = this.props.rangeStart > 0 && this.props.rangeEnd > 0 ?
			l10n.t('Page {0}/{1}: showing symbols {2}-{3} of {4}.', this.props.page, this.props.totalPages, this.props.rangeStart, this.props.rangeEnd, this.props.totalSymbols) :
			l10n.t('Page {0}/{1}: no symbols in the requested range.', this.props.page, this.props.totalPages);

		return <Tag name='documentSymbols' attrs={{ path: this.props.filePath }}>
			<TextChunk priority={120}>{header}</TextChunk>
			{this.props.symbols.map((symbol: FlattenedSymbol, index: number) => this.renderSymbol(symbol, index))}
			{this.props.hasMore && <TextChunk priority={60}>{l10n.t('More pages available ({0} remaining). Use "page": {1} to load the next page.', this.props.remainingPages, Math.min(this.props.page + 1, this.props.totalPages))}</TextChunk>}
			{this.props.page > 1 && <TextChunk priority={50}>{l10n.t('To refresh from the beginning, request "page": 1 or set "reset": true.')}</TextChunk>}
		</Tag>;
	}

	private renderSymbol(symbol: FlattenedSymbol, index: number): PromptPiece {
		const line = symbol.range.start.line + 1;
		const character = symbol.range.start.character + 1;
		const indent = '  '.repeat(symbol.depth);
		const kind = symbolKindToString(symbol.kind);
		const detail = symbol.detail ? ` – ${symbol.detail}` : '';

		return <TextChunk priority={110 - index}>
			<references value={[new PromptReference(new Location(this.props.uri, symbol.range), undefined, { isFromTool: true })]} />
			{indent}- {symbol.name} ({kind}) at line {line}, col {character}{detail}
		</TextChunk>;
	}
}

function flattenDocumentSymbols(symbols: readonly vscode.DocumentSymbol[], depth = 0): FlattenedSymbol[] {
	const result: FlattenedSymbol[] = [];
	for (const symbol of symbols) {
		result.push({
			name: symbol.name,
			kind: symbol.kind,
			detail: symbol.detail,
			range: symbol.range,
			depth,
		});

		if (symbol.children && symbol.children.length) {
			result.push(...flattenDocumentSymbols(symbol.children, depth + 1));
		}
	}

	return result;
}

function clampPageSize(value: number): number {
	const normalized = Math.max(1, Math.floor(value));
	return Math.min(normalized, MAX_PAGE_SIZE);
}

function clampPageNumber(value: number): number {
	return Math.max(1, Math.floor(value));
}

function symbolKindToString(kind: vscode.SymbolKind): string {
	const name = SymbolKind[kind];
	return name ?? 'Symbol';
}

function buildResultMessage(uri: URI, page: number, totalPages: number, rangeStart: number, rangeEnd: number, totalSymbols: number, hasMore: boolean, remainingPages: number): string {
	const filePath = uri.toString(true);
	if (totalSymbols === 0) {
		return l10n.t('No document symbols found for {0}.', filePath);
	}

	if (rangeStart === 0 || rangeEnd === 0) {
		return l10n.t('Listed document symbols from {0} (page {1}/{2}).', filePath, page, totalPages);
	}

	if (hasMore) {
		return l10n.t('Listed symbols {0}-{1} of {2} from {3} (page {4}/{5}, {6} more pages available).', rangeStart, rangeEnd, totalSymbols, filePath, page, totalPages, remainingPages);
	}

	return l10n.t('Listed symbols {0}-{1} of {2} from {3} (page {4}/{5}).', rangeStart, rangeEnd, totalSymbols, filePath, page, totalPages);
}

interface NormalizedPagingOptions {
	readonly pageSize: number;
	readonly page: number;
	readonly reset: boolean;
}

function normalizePagingOptions(input: IDocumentSymbolsToolParams): NormalizedPagingOptions {
	const requestedPageSize = input.pageSize ?? input.maxItems ?? DEFAULT_PAGE_SIZE;
	const pageSize = clampPageSize(requestedPageSize);
	const requestedPage = input.page ?? 1;
	const page = clampPageNumber(requestedPage);
	const reset = !!input.reset;
	return { pageSize, page, reset };
}
