/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptElementProps, PromptPiece, PromptReference, PromptSizing, TextChunk } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ILanguageFeaturesService } from '../../../platform/languages/common/languageFeaturesService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtendedLanguageModelToolResult, LanguageModelPromptTsxPart, Location, MarkdownString } from '../../../vscodeTypes';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { Tag } from '../../prompts/node/base/tag';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { NormalizedSymbolPosition, SymbolAmbiguityError, SymbolCandidate, assertFileOkForTool, checkCancellation, normalizeSymbolPosition, resolveToolInputPath } from './toolUtils';

interface IDefinitionsToolParams {
	filePath: string;
	line: number;
	symbolName: string;
	expectedKind: string;
	symbolId?: string;
}

class DefinitionsTool implements ICopilotTool<IDefinitionsToolParams> {
	public static readonly toolName = ToolName.Definitions;

	constructor(
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathService: IPromptPathRepresentationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IDefinitionsToolParams>, token: CancellationToken) {
		const { input } = options;
		const uri = resolveToolInputPath(input.filePath, this.promptPathService);

		await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, uri));

		const document = await this.workspaceService.openTextDocument(uri);
		let normalizedPosition: NormalizedSymbolPosition;
		try {
			normalizedPosition = await this.normalizePosition(document, input.line, input.symbolName, input.expectedKind, input.symbolId, token);
		} catch (error) {
			if (error instanceof SymbolAmbiguityError) {
				return this.returnAmbiguityError(error, uri, input.line, options.tokenizationOptions, token);
			}
			throw error;
		}

		checkCancellation(token);

		const definitionsRaw = await this.languageFeaturesService.getDefinitions(uri, normalizedPosition.position) ?? [];
		checkCancellation(token);
		const locations = normalizeLocations(definitionsRaw);
		const filePath = this.promptPathService.getFilePath(uri);

		const prompt = await renderPromptElementJSON(
			this.instantiationService,
			DefinitionsResult,
			{
				definitions: locations,
				filePath,
				requestedLine: normalizedPosition.line,
				requestedColumn: normalizedPosition.column,
				sourceUri: uri
			},
			options.tokenizationOptions,
			token
		);

		const result = new ExtendedLanguageModelToolResult([
			new LanguageModelPromptTsxPart(prompt)
		]);
		result.toolResultDetails = locations;
		result.toolResultMessage = new MarkdownString(buildDefinitionsMessage(uri, normalizedPosition.line, normalizedPosition.column, locations.length));

		return result;
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IDefinitionsToolParams>, _token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation | undefined> {
		const { input } = options;
		if (!input.filePath) {
			return;
		}

		try {
			const uri = resolveToolInputPath(input.filePath, this.promptPathService);
			await this.instantiationService.invokeFunction(accessor => assertFileOkForTool(accessor, uri));
			const document = await this.workspaceService.openTextDocument(uri);
			const normalized = await this.normalizePosition(document, input.line, input.symbolName, input.expectedKind, input.symbolId, CancellationToken.None);
			const filePath = this.promptPathService.getFilePath(uri);

			return {
				invocationMessage: new MarkdownString(l10n.t('Locating definitions for "{0}" in {1} at line {2}, column {3}.', input.symbolName, filePath, normalized.line, normalized.column)),
				pastTenseMessage: new MarkdownString(l10n.t('Located definitions for "{0}" in {1}.', input.symbolName, filePath))
			};
		} catch {
			return;
		}
	}

	private async normalizePosition(document: vscode.TextDocument, line: number, symbolName: string, expectedKind: string, symbolId: string | undefined, token: CancellationToken): Promise<NormalizedSymbolPosition> {
		return await normalizeSymbolPosition(document, line, symbolName, expectedKind, symbolId, this.promptPathService, this.languageFeaturesService, token);
	}

	private async returnAmbiguityError(
		error: SymbolAmbiguityError,
		uri: URI,
		line: number,
		tokenizationOptions: vscode.LanguageModelToolInvocationOptions<IDefinitionsToolParams>['tokenizationOptions'],
		token: CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const filePath = this.promptPathService.getFilePath(uri);
		const prompt = await renderPromptElementJSON(
			this.instantiationService,
			AmbiguityResult,
			{
				error: error.message,
				candidates: error.candidates,
				filePath,
				line
			},
			tokenizationOptions,
			token
		);

		const result = new ExtendedLanguageModelToolResult([
			new LanguageModelPromptTsxPart(prompt)
		]);
		result.toolResultMessage = new MarkdownString(error.message);
		return result;
	}
}

ToolRegistry.registerTool(DefinitionsTool);

interface DefinitionsResultProps extends BasePromptElementProps {
	readonly definitions: readonly Location[];
	readonly filePath: string;
	readonly requestedLine: number;
	readonly requestedColumn: number;
	readonly sourceUri: URI;
}

class DefinitionsResult extends PromptElement<DefinitionsResultProps> {
	constructor(
		props: PromptElementProps<DefinitionsResultProps>,
		@IPromptPathRepresentationService private readonly promptPathService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	override render(state: void, sizing: PromptSizing): PromptPiece | undefined {
		const { definitions, requestedLine, requestedColumn, filePath } = this.props;

		if (definitions.length === 0) {
			return <Tag name='definitions' attrs={{ path: filePath, line: `${requestedLine}`, column: `${requestedColumn}` }}>
				<TextChunk priority={50}>{l10n.t('No definitions found near line {0}, column {1}.', requestedLine, requestedColumn)}</TextChunk>
			</Tag>;
		}

		const header = definitions.length === 1 ?
			l10n.t('Found 1 definition near line {0}, column {1}.', requestedLine, requestedColumn) :
			l10n.t('Found {0} definitions near line {1}, column {2}.', definitions.length, requestedLine, requestedColumn);

		return <Tag name='definitions' attrs={{ path: filePath, line: `${requestedLine}`, column: `${requestedColumn}` }}>
			<TextChunk priority={120}>{header}</TextChunk>
			{definitions.map((definition, index) => this.renderDefinition(definition, index))}
		</Tag>;
	}

	private renderDefinition(definition: Location, index: number): PromptPiece {
		const targetPath = this.promptPathService.getFilePath(definition.uri);
		const line = definition.range.start.line + 1;
		const column = definition.range.start.character + 1;

		return <TextChunk priority={110 - index}>
			<references value={[new PromptReference(definition, undefined, { isFromTool: true })]} />
			{targetPath}, line {line}, col {column}
		</TextChunk>;
	}
}

function normalizeLocations(locations: readonly (vscode.Location | vscode.LocationLink)[]): Location[] {
	return locations.map(location => location instanceof Location ? location : new Location(location.targetUri, location.targetSelectionRange ?? location.targetRange));
}

function buildDefinitionsMessage(uri: URI, line: number, column: number, count: number): string {
	const filePath = uri.toString(true);
	if (count === 0) {
		return l10n.t('No definitions found near line {0}, column {1} in {2}.', line, column, filePath);
	}

	if (count === 1) {
		return l10n.t('Found 1 definition near line {0}, column {1} in {2}.', line, column, filePath);
	}

	return l10n.t('Found {0} definitions near line {1}, column {2} in {3}.', count, line, column, filePath);
}

interface AmbiguityResultProps extends BasePromptElementProps {
	readonly error: string;
	readonly candidates: readonly SymbolCandidate[];
	readonly filePath: string;
	readonly line: number;
}

class AmbiguityResult extends PromptElement<AmbiguityResultProps> {
	override render(): PromptPiece {
		const { error, candidates, filePath, line } = this.props;

		return <Tag name='ambiguous-symbols' attrs={{ path: filePath, line: `${line}`, status: 'ambiguous' }}>
			<TextChunk priority={50}>{error}</TextChunk>
			<TextChunk priority={40}>Candidates:</TextChunk>
			{candidates.map((candidate, index) => (
				<TextChunk priority={30 - index}>
					- symbolId: {candidate.symbolId}, kind: {candidate.kind}, name: {candidate.name}, column: {candidate.column + 1}
				</TextChunk>
			))}
		</Tag>;
	}
}
