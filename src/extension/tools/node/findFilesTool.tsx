/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptElementProps, PromptPiece, PromptReference, PromptSizing, TextChunk } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { URI } from '../../../util/vs/base/common/uri';

import * as l10n from '@vscode/l10n';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ISearchService } from '../../../platform/search/common/searchService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { raceTimeoutAndCancellationError } from '../../../util/common/racePromise';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtendedLanguageModelToolResult, LanguageModelPromptTsxPart, MarkdownString } from '../../../vscodeTypes';
import { IBuildPromptContext } from '../../prompt/common/intents';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { ToolName } from '../common/toolNames';
import { CopilotToolMode, ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { checkCancellation, inputGlobToPattern } from './toolUtils';

export interface IFindFilesToolParams {
	query: string;
	maxResults?: number;
}

export class FindFilesTool implements ICopilotTool<IFindFilesToolParams> {
	public static readonly toolName = ToolName.FindFiles;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IFindFilesToolParams>, token: CancellationToken) {
		checkCancellation(token);

		// TODO strict input validation
		// Certain models just really want to pass incorrect input
		if ((options.input as unknown as Record<string, string>).path) {
			throw new Error('The property "path" is not supported');
		}

		const endpoint = options.model && (await this.endpointProvider.getChatEndpoint(options.model));
		const modelFamily = endpoint?.family;

		// The input _should_ be a pattern matching inside a workspace, folder, but sometimes we get absolute paths, so try to resolve them
		const pattern = inputGlobToPattern(options.input.query, this.workspaceService, modelFamily);

		// try find text with a timeout of 20s
		const timeoutInMs = 20_000;


		const results = await raceTimeoutAndCancellationError(
			(searchToken) => Promise.resolve(this.searchService.findFiles(pattern, undefined, searchToken)),
			token,
			timeoutInMs,
			'Timeout in searching files, try a more specific search pattern'
		);

		checkCancellation(token);

		const maxResults = options.input.maxResults ?? 20;
		const resultsToShow = results.slice(0, maxResults);
		// Render the prompt element with a timeout
		const prompt = await renderPromptElementJSON(this.instantiationService, FindFilesResult, { fileResults: resultsToShow, totalResults: results.length }, options.tokenizationOptions, token);
		const result = new ExtendedLanguageModelToolResult([new LanguageModelPromptTsxPart(prompt)]);
		const query = `\`${options.input.query}\``;
		result.toolResultMessage = resultsToShow.length === 0 ?
			new MarkdownString(l10n.t`Searched for files matching ${query}, no matches`) :
			resultsToShow.length === 1 ?
				new MarkdownString(l10n.t`Searched for files matching ${query}, 1 match`) :
				new MarkdownString(l10n.t`Searched for files matching ${query}, ${resultsToShow.length} matches`);
		result.toolResultDetails = resultsToShow;
		return result;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IFindFilesToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const query = `\`${options.input.query}\``;
		return {
			invocationMessage: new MarkdownString(l10n.t`Searching for files matching ${query}`)
		};
	}

	async resolveInput(input: IFindFilesToolParams, _promptContext: IBuildPromptContext, mode: CopilotToolMode): Promise<IFindFilesToolParams> {
		let query = input.query;
		if (!query.startsWith('**/')) {
			query = `**/${query}`;
		}

		if (query.endsWith('/')) {
			query = `${query}**`;
		}

		return {
			...input,
			query,
			maxResults: mode === CopilotToolMode.FullContext ?
				Math.max(input.maxResults ?? 0, 200) :
				input.maxResults ?? 20,
		};
	}
}

ToolRegistry.registerTool(FindFilesTool);

export interface FindFilesResultProps extends BasePromptElementProps {
	fileResults: URI[];
	totalResults: number;
}

export class FindFilesResult extends PromptElement<FindFilesResultProps> {
	constructor(
		props: PromptElementProps<FindFilesResultProps>,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	override render(state: void, sizing: PromptSizing): PromptPiece<any, any> | undefined {
		if (this.props.fileResults.length === 0) {
			return <>No files found</>;
		}

		return <>
			{<TextChunk priority={20}>{this.props.totalResults === 1 ? '1 total result' : `${this.props.totalResults} total results`}</TextChunk>}
			{this.props.fileResults.map(file => <TextChunk priority={10}>
				<references value={[new PromptReference(file, undefined, { isFromTool: true })]} />
				{this.promptPathRepresentationService.getFilePath(file)}
			</TextChunk>)}
			{this.props.totalResults > this.props.fileResults.length && <TextChunk priority={20}>{'...'}</TextChunk>}
		</>;
	}
}
