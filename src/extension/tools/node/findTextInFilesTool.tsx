/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptElementProps, PromptPiece, PromptReference, PromptSizing, TextChunk } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { OffsetLineColumnConverter } from '../../../platform/editing/common/offsetLineColumnConverter';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ISearchService } from '../../../platform/search/common/searchService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { asArray } from '../../../util/vs/base/common/arrays';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { count } from '../../../util/vs/base/common/strings';
import { URI } from '../../../util/vs/base/common/uri';
import { Position as EditorPosition } from '../../../util/vs/editor/common/core/position';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtendedLanguageModelToolResult, LanguageModelPromptTsxPart, Location, MarkdownString, Range } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { Tag } from '../../prompts/node/base/tag';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { checkCancellation, inputGlobToPattern } from './toolUtils';

interface IFindTextInFilesToolParams {
	query: string;
	isRegexp?: boolean;
	includePattern?: string;
	maxResults?: number;
}

const MaxResultsCap = 200;

export class FindTextInFilesTool implements ICopilotTool<IFindTextInFilesToolParams> {
	public static readonly toolName = ToolName.FindTextInFiles;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IFindTextInFilesToolParams>, token: CancellationToken) {
		// The input _should_ be a pattern matching inside a workspace, folder, but sometimes we get absolute paths, so try to resolve them
		const patterns = options.input.includePattern ? inputGlobToPattern(options.input.includePattern, this.workspaceService) : undefined;

		checkCancellation(token);
		const askedForTooManyResults = options.input.maxResults && options.input.maxResults > MaxResultsCap;
		const maxResults = Math.min(options.input.maxResults ?? 20, MaxResultsCap);
		const isRegExp = options.input.isRegexp ?? true;
		let results = await this.searchAndCollectResults(options.input.query, isRegExp, patterns, maxResults, token);
		if (!results.length) {
			results = await this.searchAndCollectResults(options.input.query, !isRegExp, patterns, maxResults, token);
		}

		const result = new ExtendedLanguageModelToolResult([
			new LanguageModelPromptTsxPart(
				await renderPromptElementJSON(this.instantiationService, FindTextInFilesResult, { textResults: results, maxResults, askedForTooManyResults: Boolean(askedForTooManyResults) }, options.tokenizationOptions, token))]);
		const textMatches = results.flatMap(r => {
			if ('ranges' in r) {
				return asArray(r.ranges).map(rangeInfo => new Location(r.uri, rangeInfo.sourceRange));
			}

			return [];
		}).slice(0, maxResults);
		const query = this.formatQueryString(options.input);
		result.toolResultMessage = textMatches.length === 0 ?
			new MarkdownString(l10n.t`Searched text for ${query}, no results`) :
			textMatches.length === 1 ?
				new MarkdownString(l10n.t`Searched text for ${query}, 1 result`) :
				new MarkdownString(l10n.t`Searched text for ${query}, ${textMatches.length} results`);

		result.toolResultDetails = textMatches;
		return result;
	}

	private async searchAndCollectResults(query: string, isRegExp: boolean, patterns: vscode.GlobPattern[] | undefined, maxResults: number, token: CancellationToken): Promise<vscode.TextSearchResult2[]> {
		const searchResult = this.searchService.findTextInFiles2(
			{
				pattern: query,
				isRegExp,
			},
			{
				include: patterns ? patterns : undefined,
				maxResults: maxResults + 1
			},
			token);
		const results: vscode.TextSearchResult2[] = [];
		for await (const item of searchResult.results) {
			checkCancellation(token);
			results.push(item);
		}

		return results;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IFindTextInFilesToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: new MarkdownString(l10n.t`Searching text for ${this.formatQueryString(options.input)}`),
		};
	}

	/**
	 * Formats text as a Markdown inline code span that is resilient to backticks within the text.
	 * It chooses a backtick fence one longer than the longest run of backticks in the content,
	 * and pads with a space when the content begins or ends with a backtick as per CommonMark.
	 */
	private formatCodeSpan(text: string): string {
		const matches = text.match(/`+/g);
		const maxRun = matches ? matches.reduce((m, s) => Math.max(m, s.length), 0) : 0;
		const fence = '`'.repeat(maxRun + 1);
		const needsPadding = text.startsWith('`') || text.endsWith('`');
		const inner = needsPadding ? ` ${text} ` : text;
		return `${fence}${inner}${fence}`;
	}

	private formatQueryString(input: IFindTextInFilesToolParams): string {
		const querySpan = this.formatCodeSpan(input.query);
		if (input.includePattern && input.includePattern !== '**/*') {
			const patternSpan = this.formatCodeSpan(input.includePattern);
			return `${querySpan} (${patternSpan})`;
		}
		return querySpan;
	}

	async resolveInput(input: IFindTextInFilesToolParams, _promptContext: IBuildPromptContext, mode: CopilotToolMode): Promise<IFindTextInFilesToolParams> {
		let includePattern = input.includePattern;
		if (includePattern && !includePattern.startsWith('**/')) {
			includePattern = `**/${includePattern}`;
		}
		if (includePattern && includePattern.endsWith('/')) {
			includePattern = `${includePattern}**`;
		}

		return {
			maxResults: mode === CopilotToolMode.FullContext ? 200 : 20,
			...input,
			includePattern,
		};
	}
}

ToolRegistry.registerTool(FindTextInFilesTool);
export interface FindTextInFilesResultProps extends BasePromptElementProps {
	textResults: vscode.TextSearchResult2[];
	maxResults: number;
	askedForTooManyResults?: boolean;
}

/** Max number of characters between matching ranges. */
const MAX_CHARS_BETWEEN_MATCHES = 500;

/** Start priority for findFiles lines so that context is gradually trimmed. */
const FIND_FILES_START_PRIORITY = 1000;

export class FindTextInFilesResult extends PromptElement<FindTextInFilesResultProps> {
	override async render(state: void, sizing: PromptSizing): Promise<PromptPiece> {
		const textMatches = this.props.textResults.filter(isTextSearchMatch);
		if (textMatches.length === 0) {
			return <>No matches found</>;
		}

		const numResults = textMatches.reduce((acc, result) => acc + result.ranges.length, 0);
		const resultCountToDisplay = Math.min(numResults, this.props.maxResults);
		const numResultsText = numResults === 1 ? '1 match' : `${resultCountToDisplay} matches`;
		const maxResultsTooLargeText = this.props.askedForTooManyResults ? ` (maxResults capped at ${MaxResultsCap})` : '';
		const maxResultsText = numResults > this.props.maxResults ? ` (more results are available)` : '';
		return <>
			{<TextChunk priority={20}>{numResultsText}{maxResultsText}{maxResultsTooLargeText}</TextChunk>}
			{textMatches.flatMap(result => {
				// The result preview line always ends in a newline, I think that makes sense but don't display an extra empty line
				const previewText = result.previewText.replace(/\n$/, '');
				return result.ranges.map((rangeInfo, i) => {
					return <FindMatch
						passPriority
						preview={previewText}
						rangeInPreview={rangeInfo.previewRange}
						rangeInDocument={rangeInfo.sourceRange}
						uri={result.uri}
					/>;
				});
			})}
		</>;
	}
}

interface IFindMatchProps extends BasePromptElementProps {
	preview: string;
	rangeInPreview: Range;
	rangeInDocument: Range;
	uri: URI;
}

/**
 * 1. Removes excessive extra character data from the match, e.g. avoiding
 * giant minified lines
 * 2. Wraps the match in a <match> tag
 * 3. Prioritizes lines in the middle of the match where the range lies
 */
export class FindMatch extends PromptElement<IFindMatchProps> {
	constructor(
		props: PromptElementProps<IFindMatchProps>,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	override render(): PromptPiece {
		const { uri, preview, rangeInDocument, rangeInPreview } = this.props;

		const convert = new OffsetLineColumnConverter(preview);

		const start = convert.positionToOffset(new EditorPosition(rangeInPreview.start.line + 1, rangeInPreview.start.character + 1));
		const end = convert.positionToOffset(new EditorPosition(rangeInPreview.end.line + 1, rangeInPreview.end.character + 1));

		let toPreview = preview;
		let lineStartsAt = (rangeInDocument.start.line + 1) - count(preview.slice(0, start), '\n');
		if (preview.length - end > MAX_CHARS_BETWEEN_MATCHES) {
			toPreview = preview.slice(0, end + MAX_CHARS_BETWEEN_MATCHES) + '...';
		}

		if (start > MAX_CHARS_BETWEEN_MATCHES) {
			lineStartsAt += count(preview.slice(0, start - MAX_CHARS_BETWEEN_MATCHES), '\n');
			toPreview = '...' + toPreview.slice(start - MAX_CHARS_BETWEEN_MATCHES);
		}

		const toPreviewLines = toPreview.split('\n');
		const center = Math.floor(toPreviewLines.length / 2);
		return <Tag name="match" attrs={{
			path: this.promptPathRepresentationService.getFilePath(uri),
			line: rangeInDocument.start.line + 1,
		}}>
			<references value={[new PromptReference(new Location(this.props.uri, rangeInDocument), undefined, { isFromTool: true })]} />
			{toPreviewLines.map((line, i) =>
				<TextChunk priority={FIND_FILES_START_PRIORITY - Math.abs(i - center)}>
					{line}
				</TextChunk>
			)}
		</Tag>;
	}
}


export function isTextSearchMatch(obj: vscode.TextSearchResult2): obj is vscode.TextSearchMatch2 {
	return 'ranges' in obj;
}
