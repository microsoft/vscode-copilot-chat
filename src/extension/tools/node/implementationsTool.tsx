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

interface IImplementationsToolParams {
	filePath: string;
	line: number;
	symbolName: string;
	expectedKind: string;
	symbolId?: string;
}

class ImplementationsTool implements ICopilotTool<IImplementationsToolParams> {
	public static readonly toolName = ToolName.Implementations;

	constructor(
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IPromptPathRepresentationService private readonly promptPathService: IPromptPathRepresentationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IImplementationsToolParams>, token: CancellationToken) {
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

		const implementationsRaw = await this.languageFeaturesService.getImplementations(uri, normalizedPosition.position) ?? [];
		checkCancellation(token);
		const locations = normalizeLocations(implementationsRaw);
		const filePath = this.promptPathService.getFilePath(uri);

		const prompt = await renderPromptElementJSON(
			this.instantiationService,
			ImplementationsResult,
			{
				implementations: locations,
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
		result.toolResultMessage = new MarkdownString(buildImplementationsMessage(uri, normalizedPosition.line, normalizedPosition.column, locations.length));

		return result;
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IImplementationsToolParams>, _token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation | undefined> {
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
				invocationMessage: new MarkdownString(l10n.t('Locating implementations for "{0}" in {1} at line {2}, column {3}.', input.symbolName, filePath, normalized.line, normalized.column)),
				pastTenseMessage: new MarkdownString(l10n.t('Located implementations for "{0}" in {1}.', input.symbolName, filePath))
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
		tokenizationOptions: vscode.LanguageModelToolInvocationOptions<IImplementationsToolParams>['tokenizationOptions'],
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

ToolRegistry.registerTool(ImplementationsTool);

interface ImplementationsResultProps extends BasePromptElementProps {
	readonly implementations: readonly Location[];
	readonly filePath: string;
	readonly requestedLine: number;
	readonly requestedColumn: number;
	readonly sourceUri: URI;
}

class ImplementationsResult extends PromptElement<ImplementationsResultProps> {
	constructor(
		props: PromptElementProps<ImplementationsResultProps>,
		@IPromptPathRepresentationService private readonly promptPathService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	override render(state: void, sizing: PromptSizing): PromptPiece | undefined {
		const { implementations, requestedLine, requestedColumn, filePath } = this.props;

		if (implementations.length === 0) {
			return <Tag name='implementations' attrs={{ path: filePath, line: `${requestedLine}`, column: `${requestedColumn}` }}>
				<TextChunk priority={50}>{l10n.t('No implementations found near line {0}, column {1}.', requestedLine, requestedColumn)}</TextChunk>
			</Tag>;
		}

		const header = implementations.length === 1 ?
			l10n.t('Found 1 implementation near line {0}, column {1}.', requestedLine, requestedColumn) :
			l10n.t('Found {0} implementations near line {1}, column {2}.', implementations.length, requestedLine, requestedColumn);

		return <Tag name='implementations' attrs={{ path: filePath, line: `${requestedLine}`, column: `${requestedColumn}` }}>
			<TextChunk priority={120}>{header}</TextChunk>
			{implementations.map((implementation, index) => this.renderImplementation(implementation, index))}
		</Tag>;
	}

	private renderImplementation(implementation: Location, index: number): PromptPiece {
		const targetPath = this.promptPathService.getFilePath(implementation.uri);
		const line = implementation.range.start.line + 1;
		const column = implementation.range.start.character + 1;

		return <TextChunk priority={110 - index}>
			<references value={[new PromptReference(implementation, undefined, { isFromTool: true })]} />
			{targetPath}, line {line}, col {column}
		</TextChunk>;
	}
}

function normalizeLocations(locations: readonly (vscode.Location | vscode.LocationLink)[]): Location[] {
	return locations.map(location => location instanceof Location ? location : new Location(location.targetUri, location.targetSelectionRange ?? location.targetRange));
}

function buildImplementationsMessage(uri: URI, line: number, column: number, count: number): string {
	const filePath = uri.toString(true);
	if (count === 0) {
		return l10n.t('No implementations found near line {0}, column {1} in {2}.', line, column, filePath);
	}

	if (count === 1) {
		return l10n.t('Found 1 implementation near line {0}, column {1} in {2}.', line, column, filePath);
	}

	return l10n.t('Found {0} implementations near line {1}, column {2} in {3}.', count, line, column, filePath);
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
