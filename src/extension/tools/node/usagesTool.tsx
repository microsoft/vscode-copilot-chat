/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptElementProps, PromptReference, TextChunk } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ILanguageFeaturesService } from '../../../platform/languages/common/languageFeaturesService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { ResourceSet } from '../../../util/vs/base/common/map';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtendedLanguageModelToolResult, LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult, Location, MarkdownString } from '../../../vscodeTypes';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { Tag } from '../../prompts/node/base/tag';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { resolveToolInputPath } from './toolUtils';

interface IUsagesToolParams {
	symbolName: string;
	filePaths?: string[];
}

class GetUsagesTool implements ICopilotTool<IUsagesToolParams> {

	static readonly toolName = ToolName.Usages;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IPromptPathRepresentationService private readonly _promptPathService: IPromptPathRepresentationService,
	) { }

	private async _getDefinitionLocation(symbolName: string, filePaths: string[]) {
		const seen = new ResourceSet();
		for (const filePath of filePaths) {
			const uri = resolveToolInputPath(filePath, this._promptPathService);
			if (seen.has(uri)) {
				continue;
			}

			seen.add(uri);
			const symbols = await this.languageFeaturesService.getDocumentSymbols(uri);
			const symbol = symbols.find(value => value.name === symbolName);
			if (symbol) {
				return new Location(uri, symbol.selectionRange);
			}
		}
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IUsagesToolParams>, token: vscode.CancellationToken): Promise<LanguageModelToolResult> {
		let def: vscode.Location | undefined;
		if (options.input.filePaths?.length) {
			def = await this._getDefinitionLocation(options.input.symbolName, options.input.filePaths);
		}

		if (!def) {
			const symbols = await this.languageFeaturesService.getWorkspaceSymbols(options.input.symbolName);
			const filePaths = symbols.map(s => this._promptPathService.getFilePath(s.location.uri));
			def = await this._getDefinitionLocation(options.input.symbolName, filePaths);
		}

		if (!def) {
			const message = `Symbol \`${options.input.symbolName}\` not found`;
			const toolResult = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(message)]);
			toolResult.toolResultMessage = new MarkdownString(message);
			return toolResult;
		}

		const [definitions, references, implementations] = await Promise.all([
			this.languageFeaturesService.getDefinitions(def.uri, def.range.start),
			this.languageFeaturesService.getReferences(def.uri, def.range.start),
			this.languageFeaturesService.getImplementations(def.uri, def.range.start)
		]);

		const result = await renderPromptElementJSON(this.instantiationService, UsagesOutput, { definitions, references, implementations }, options.tokenizationOptions, token);
		const toolResult = new ExtendedLanguageModelToolResult([new LanguageModelPromptTsxPart(result)]);
		toolResult.toolResultDetails = references;

		const query = `\`${options.input.symbolName}\``;

		toolResult.toolResultMessage = references.length === 0
			? new MarkdownString(l10n.t`Analyzed usages of ${query}, no results`)
			: references.length === 1
				? new MarkdownString(l10n.t`Analyzed usages of ${query}, 1 result`)
				: new MarkdownString(l10n.t`Analyzed usages of ${query}, ${references.length} results`);

		return toolResult;

	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IUsagesToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const query = `\`${options.input.symbolName}\``;
		return {
			invocationMessage: l10n.t`Analyzing usages of ${query}`,
		};
	}
}

ToolRegistry.registerTool(GetUsagesTool);

interface IUsagesOutputProps extends BasePromptElementProps {
	readonly definitions: (vscode.Location | vscode.LocationLink)[];
	readonly references: (vscode.Location | vscode.LocationLink)[];
	readonly implementations: (vscode.Location | vscode.LocationLink)[];
}

class UsagesOutput extends PromptElement<IUsagesOutputProps> {
	constructor(
		props: PromptElementProps<IUsagesOutputProps>,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	render() {
		const { references, definitions, implementations } = this.props;

		if (references.length === 0) {
			return <>No usages found.</>;
		}

		function isEqual(a: vscode.Location | vscode.LocationLink, b: vscode.Location | vscode.LocationLink): boolean {
			const [uriA, rangeA] = a instanceof Location ? [a.uri, a.range] : [a.targetUri, a.targetRange];
			const [uriB, rangeB] = b instanceof Location ? [b.uri, b.range] : [b.targetUri, b.targetRange];
			return uriA.toString() === uriB.toString() && (
				rangeA.isEqual(rangeB) ||
				rangeA.contains(rangeB) ||
				rangeB.contains(rangeA)
			);
		}

		return <>
			{<TextChunk>{references.length} usages</TextChunk>}
			{references.map((ref, i) => {

				let referenceType = 'usage';
				if (definitions.find(candidate => isEqual(candidate, ref))) {
					referenceType = 'definition';
				} else if (implementations.find(candidate => isEqual(candidate, ref))) {
					referenceType = 'implementation';
				}

				const [uri, range] = ref instanceof Location ? [ref.uri, ref.range] : [ref.targetUri, ref.targetRange];
				const filePath = this.promptPathRepresentationService.getFilePath(uri);
				return <>
					<Tag name={referenceType} priority={references.length - i}>
						<references value={[new PromptReference(new Location(uri, range), undefined, { isFromTool: true })]} />
						{filePath}, line {range.start.line}, column {range.start.character}
					</Tag><br />
				</>;
			})}
		</>;
	}
}
