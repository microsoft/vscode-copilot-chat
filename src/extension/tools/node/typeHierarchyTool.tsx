/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { BasePromptElementProps, PromptElement, PromptElementProps, PromptReference, TextChunk } from '@vscode/prompt-tsx';
import type * as vscode from 'vscode';
import { ILanguageFeaturesService } from '../../../platform/languages/common/languageFeaturesService';
import { IPromptPathRepresentationService } from '../../../platform/prompts/common/promptPathRepresentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ExtendedLanguageModelToolResult, LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult, Location, MarkdownString, Position } from '../../../vscodeTypes';
import { renderPromptElementJSON } from '../../prompts/node/base/promptRenderer';
import { Tag } from '../../prompts/node/base/tag';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { resolveToolInputPath } from './toolUtils';

interface ITypeHierarchyToolParams {
	uri: string;
	position: { line: number; character: number };
	includeSupertypes?: boolean;
	includeSubtypes?: boolean;
}

class GetTypeHierarchyTool implements ICopilotTool<ITypeHierarchyToolParams> {

	static readonly toolName = ToolName.TypeHierarchy;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IPromptPathRepresentationService private readonly _promptPathService: IPromptPathRepresentationService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ITypeHierarchyToolParams>, token: vscode.CancellationToken): Promise<LanguageModelToolResult> {
		const uri = resolveToolInputPath(options.input.uri, this._promptPathService);
		const position = new Position(options.input.position.line, options.input.position.character);
		const includeSupertypes = options.input.includeSupertypes ?? true;
		const includeSubtypes = options.input.includeSubtypes ?? true;

		// First, prepare the type hierarchy to get the root items
		const hierarchyItems = await this.languageFeaturesService.prepareTypeHierarchy(uri, position);

		if (hierarchyItems.length === 0) {
			const message = l10n.t`No type hierarchy found at the specified location`;
			const toolResult = new ExtendedLanguageModelToolResult([new LanguageModelTextPart(message)]);
			toolResult.toolResultMessage = new MarkdownString(message);
			return toolResult;
		}

		// Collect supertypes and subtypes for all hierarchy items
		const allSupertypes: vscode.TypeHierarchyItem[] = [];
		const allSubtypes: vscode.TypeHierarchyItem[] = [];

		for (const item of hierarchyItems) {
			if (includeSupertypes) {
				const supertypes = await this.languageFeaturesService.getTypeHierarchySupertypes(item);
				allSupertypes.push(...supertypes);
			}

			if (includeSubtypes) {
				const subtypes = await this.languageFeaturesService.getTypeHierarchySubtypes(item);
				allSubtypes.push(...subtypes);
			}
		}

		const result = await renderPromptElementJSON(
			this.instantiationService,
			TypeHierarchyOutput,
			{
				hierarchyItems,
				supertypes: allSupertypes,
				subtypes: allSubtypes,
				includeSupertypes,
				includeSubtypes
			},
			options.tokenizationOptions,
			token
		);

		const toolResult = new ExtendedLanguageModelToolResult([new LanguageModelPromptTsxPart(result)]);

		// Prepare tool result details with all relevant locations
		const allLocations: vscode.Location[] = [];
		hierarchyItems.forEach(item => allLocations.push(new Location(item.uri, item.selectionRange)));
		allSupertypes.forEach(item => allLocations.push(new Location(item.uri, item.selectionRange)));
		allSubtypes.forEach(item => allLocations.push(new Location(item.uri, item.selectionRange)));

		toolResult.toolResultDetails = allLocations;

		// Create summary message
		const totalItems = hierarchyItems.length + allSupertypes.length + allSubtypes.length;
		const parts: string[] = [];
		if (hierarchyItems.length > 0) {
			parts.push(`${hierarchyItems.length} type${hierarchyItems.length === 1 ? '' : 's'}`);
		}
		if (allSupertypes.length > 0) {
			parts.push(`${allSupertypes.length} supertype${allSupertypes.length === 1 ? '' : 's'}`);
		}
		if (allSubtypes.length > 0) {
			parts.push(`${allSubtypes.length} subtype${allSubtypes.length === 1 ? '' : 's'}`);
		}

		const summaryText = parts.length > 0 ? `Found ${parts.join(', ')}` : 'No type hierarchy found';
		toolResult.toolResultMessage = new MarkdownString(summaryText);

		return toolResult;
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ITypeHierarchyToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		const fileName = this._promptPathService.getFilePath(resolveToolInputPath(options.input.uri, this._promptPathService));
		return {
			invocationMessage: l10n.t`Getting type hierarchy for ${fileName}:${options.input.position.line + 1}:${options.input.position.character + 1}`,
		};
	}
}

ToolRegistry.registerTool(GetTypeHierarchyTool);

interface ITypeHierarchyOutputProps extends BasePromptElementProps {
	readonly hierarchyItems: vscode.TypeHierarchyItem[];
	readonly supertypes: vscode.TypeHierarchyItem[];
	readonly subtypes: vscode.TypeHierarchyItem[];
	readonly includeSupertypes: boolean;
	readonly includeSubtypes: boolean;
}

class TypeHierarchyOutput extends PromptElement<ITypeHierarchyOutputProps> {
	constructor(
		props: PromptElementProps<ITypeHierarchyOutputProps>,
		@IPromptPathRepresentationService private readonly promptPathRepresentationService: IPromptPathRepresentationService,
	) {
		super(props);
	}

	render() {
		const { hierarchyItems, supertypes, subtypes, includeSupertypes, includeSubtypes } = this.props;

		if (hierarchyItems.length === 0) {
			return <>No type hierarchy found.</>;
		}

		const renderTypeHierarchyItem = (item: vscode.TypeHierarchyItem, prefix: string, priority: number) => {
			const filePath = this.promptPathRepresentationService.getFilePath(item.uri);
			const location = new Location(item.uri, item.selectionRange);

			return <>
				<Tag name="type" priority={priority}>
					<references value={[new PromptReference(location, undefined, { isFromTool: true })]} />
					{prefix}{item.name} ({item.kind}) - {filePath}, line {item.selectionRange.start.line + 1}
				</Tag><br />
			</>;
		};

		let priority = 1000; // Start with high priority for better ordering

		return <>
			<TextChunk>Type Hierarchy</TextChunk><br /><br />

			{hierarchyItems.length > 0 && <>
				<TextChunk>Current Type{hierarchyItems.length > 1 ? 's' : ''}:</TextChunk><br />
				{hierarchyItems.map(item => renderTypeHierarchyItem(item, '• ', priority--))}
				<br />
			</>}

			{includeSupertypes && supertypes.length > 0 && <>
				<TextChunk>Supertypes ({supertypes.length}):</TextChunk><br />
				{supertypes.map(item => renderTypeHierarchyItem(item, '↑ ', priority--))}
				<br />
			</>}

			{includeSubtypes && subtypes.length > 0 && <>
				<TextChunk>Subtypes ({subtypes.length}):</TextChunk><br />
				{subtypes.map(item => renderTypeHierarchyItem(item, '↓ ', priority--))}
				<br />
			</>}

			{!includeSupertypes && !includeSubtypes && <>
				<TextChunk>Note: Both supertypes and subtypes were excluded from the results.</TextChunk><br />
			</>}
		</>;
	}
}
