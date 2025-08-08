/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptRenderer, RenderPromptResult, SystemMessage, UserMessage } from '@vscode/prompt-tsx';
import * as JSONC from 'jsonc-parser';
import type { LanguageModelToolInformation } from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { ObjectJsonSchema } from '../../../../platform/configuration/common/jsonSchema';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { extractCodeBlocks } from '../../../../util/common/markdown';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { isDefined } from '../../../../util/vs/base/common/types';
import { ISummarizedToolCategory, SummarizerError } from './virtualToolTypes';
import { UNCATEGORIZED_TOOLS_GROUP_NAME, UNCATEGORIZED_TOOLS_GROUP_SUMMARY } from './virtualToolsConstants';

function normalizeGroupName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

function deduplicateTools(tools: LanguageModelToolInformation[], seen = new Set<string>()): LanguageModelToolInformation[] {
	return tools.filter(tool => {
		const had = seen.has(tool.name);
		seen.add(tool.name);
		return !had;
	});
}

function validateCategoriesWithoutToolsResponse(json: unknown, context: string): asserts json is { name: string; summary: string }[] {
	if (!Array.isArray(json)) {
		throw new SummarizerError(`Invalid response from ${context}: ${JSON.stringify(json)}`);
	}

	if (!json.every((item: any) => typeof item.name === 'string' && typeof item.summary === 'string')) {
		throw new SummarizerError(`Invalid response from ${context}: ${JSON.stringify(json)}`);
	}
}

function validateCategorizationResponse(json: unknown, context: string): asserts json is { name: string; summary: string; tools: string[] }[] {
	validateCategoriesWithoutToolsResponse(json, context);

	if (!json.every((item: any) => Array.isArray(item.tools) && item.tools.every((t: any) => typeof t === 'string'))) {
		throw new SummarizerError(`Invalid response from ${context}: ${JSON.stringify(json)}`);
	}
}

function processCategorizationResponse(json: { name: string; summary: string; tools: string[] }[], toolMap: Map<string, LanguageModelToolInformation>): ISummarizedToolCategory[] {
	const categories = json.map((item): ISummarizedToolCategory => ({
		name: item.name,
		summary: item.summary,
		tools: item.tools.map(toolName => toolMap.get(toolName)).filter(isDefined),
	}));

	return validateAndCleanupCategories(categories);
}

function validateAndCleanupCategories(categories: ISummarizedToolCategory[]): ISummarizedToolCategory[] {
	const byName = new Map<string, ISummarizedToolCategory>();
	for (const category of categories) {
		const name = normalizeGroupName(category.name);
		const existing = byName.get(name);
		if (!existing) {
			byName.set(category.name, { tools: category.tools, name, summary: category.summary });
		} else {
			if (category.summary && category.summary !== existing.summary) {
				existing.summary = `${existing.summary}\n\n${category.summary}`;
			}
			existing.tools = existing.tools.concat(category.tools);
		}
	}

	for (const category of byName.values()) {
		category.tools = deduplicateTools(category.tools);
	}

	return [...byName.values()];
}

/**
 * Adds uncategorized tools to the categories list if any tools are missing.
 */
function addUncategorizedToolsIfNeeded(categories: ISummarizedToolCategory[], toolMap: Map<string, LanguageModelToolInformation>): ISummarizedToolCategory[] {
	const uncategorizedTools = new Map(toolMap);

	// Use toolMap keys to find uncategorized tools efficiently
	for (const cat of categories) {
		for (const tool of cat.tools) {
			uncategorizedTools.delete(tool.name);
		}
	}

	if (uncategorizedTools.size > 0) {
		categories.push({
			name: UNCATEGORIZED_TOOLS_GROUP_NAME,
			summary: UNCATEGORIZED_TOOLS_GROUP_SUMMARY,
			tools: [...uncategorizedTools.values()],
		});
	}

	return categories;
}

export async function summarizeToolGroup(endpoint: IChatEndpoint, tools: LanguageModelToolInformation[], token: CancellationToken): Promise<ISummarizedToolCategory | undefined> {
	const renderer = new PromptRenderer(endpoint, GeneralSummaryPrompt, { tools }, endpoint.acquireTokenizer());
	const result = await renderer.render(undefined, token);
	const json = await getJsonResponse(endpoint, result, token);
	if (!json) {
		return undefined;
	}

	const jsonArr = [json];
	validateCategoriesWithoutToolsResponse(jsonArr, 'categorizer');

	return { ...jsonArr[0], tools: deduplicateTools(tools), name: normalizeGroupName(jsonArr[0].name) };
}

export async function divideToolsIntoGroups(endpoint: IChatEndpoint, tools: LanguageModelToolInformation[], token: CancellationToken): Promise<ISummarizedToolCategory[] | undefined> {
	const renderer = new PromptRenderer(endpoint, CategorizerSummaryPrompt, { tools }, endpoint.acquireTokenizer());
	const result = await renderer.render(undefined, token);
	const json = await getJsonResponse(endpoint, result, token);
	if (!json) {
		return undefined;
	}

	validateCategorizationResponse(json, 'categorizer');
	const toolMap = new Map(tools.map(tool => [tool.name, tool]));
	let categories = processCategorizationResponse(json, toolMap);

	// Check if any tools were forgotten by the model
	const categorizedToolNames = new Set(categories.flatMap((cat: ISummarizedToolCategory) => cat.tools.map((tool: LanguageModelToolInformation) => tool.name)));
	const uncategorizedTools = tools.filter(tool => !categorizedToolNames.has(tool.name));

	if (uncategorizedTools.length > 0) {
		// Try once more using the existing groups function to categorize the missed tools
		const retryResult = await divideToolsIntoExistingGroups(endpoint, categories, uncategorizedTools, token);
		if (retryResult) {
			categories = retryResult;
			// Use the helper to add any remaining uncategorized tools
			categories = addUncategorizedToolsIfNeeded(categories, toolMap);
		} else {
			// If retry failed, add all uncategorized tools to an "uncategorized" group
			categories = addUncategorizedToolsIfNeeded(categories, toolMap);
		}
	}

	return categories;
}

/**
 * Categorizes new tools into existing groups or creates new groups as appropriate.
 * This function takes a set of existing tool categories and new tools, then asks the AI model
 * to decide whether each new tool fits into an existing category or requires a new category.
 *
 * @param endpoint The chat endpoint to use for AI categorization
 * @param existingGroups The current tool categories with their tools
 * @param newTools The new tools that need to be categorized
 * @param token Cancellation token
 * @returns Promise that resolves to updated tool categories including both existing and new tools
 */
export async function divideToolsIntoExistingGroups(endpoint: IChatEndpoint, existingGroups: ISummarizedToolCategory[], newTools: LanguageModelToolInformation[], token: CancellationToken): Promise<ISummarizedToolCategory[] | undefined> {

	// todo: try using embeddings here to sort high-confidence tools automatically

	const renderer = new PromptRenderer(endpoint, ExistingGroupCategorizerPrompt, { existingGroups, newTools }, endpoint.acquireTokenizer());
	const result = await renderer.render(undefined, token);
	const json = await getJsonResponse(endpoint, result, token);
	if (!json) {
		return undefined;
	}

	validateCategorizationResponse(json, 'existing group categorizer');

	// Create a map of all available tools (existing + new) for lookup
	const allTools = [...existingGroups.flatMap(group => group.tools), ...newTools];
	const toolMap = new Map(allTools.map(tool => [tool.name, tool]));

	const categories = processCategorizationResponse(json, toolMap);

	// Use the helper to add any uncategorized tools
	return addUncategorizedToolsIfNeeded(categories, toolMap);
}

class ToolInformation extends PromptElement<BasePromptElementProps & { tool: LanguageModelToolInformation }> {
	render() {
		const { tool } = this.props;
		return <>{`<tool name=${JSON.stringify(tool.name)}>${tool.description}</tool>`}<br /></>;
	}
}

class GeneralSummaryPrompt extends PromptElement<BasePromptElementProps & { tools: LanguageModelToolInformation[] }> {
	render() {
		return <>
			<SystemMessage>
				Context: There are many tools available for a user. However, the number of tools can be large, and it is not always practical to present all of them at once. We need to create a summary of them that accurately reflects the capabilities they provide.<br />
				<br />
				The user present you with the tools available to them, and you must create a summary of the tools that is accurate and comprehensive. The summary should include the capabilities of the tools and when they should be used.<br />
			</SystemMessage>
			<UserMessage>
				{this.props.tools.map(tool => <ToolInformation tool={tool} />)}<br />
				<br />
				Your response must follow the JSON schema:<br />
				<br />
				```<br />
				{JSON.stringify({
					type: 'object',
					required: ['name', 'summary'],
					properties: {
						summary: {
							type: 'string',
							description: 'A summary of the tool capabilities, including their capabilities and how they can be used together. This may be up to five pararaphs long, be careful not to leave out important details.',
							example: 'These tools assist with authoring the "foo" language. They can provide diagnostics, run tests, and provide refactoring actions for the foo language.'
						},
						name: {
							type: 'string',
							description: 'A short name for the group. It may only contain the characters a-z, A-Z, 0-9, and underscores.',
							example: 'foo_language_tools'
						}
					}
				} satisfies ObjectJsonSchema, null, 2)}
			</UserMessage>
		</>;
	}
}

class CategorizerSummaryPrompt extends PromptElement<BasePromptElementProps & { tools: LanguageModelToolInformation[] }> {
	render() {
		return <>
			<SystemMessage>
				Context: There are many tools available for a user. However, the number of tools can be large, and it is not always practical to present all of them at once. We need to create logical groups for the user to pick from at a glance.<br />
				<br />
				The user present you with the tools available to them, and you must group them into logical categories and provide a summary of each one. The summary should include the capabilities of the tools and when they should be used. Every tool MUST be a part of EXACTLY one category. Category names in your response MUST be unique—do not reuse the same name for different categories. If two categories would share a base name, append a short, descriptive suffix to disambiguate (e.g., python_tools_testing vs python_tools_packaging).<br />
			</SystemMessage>
			<UserMessage>
				{this.props.tools.map(tool => <ToolInformation tool={tool} />)}<br />
				<br />
				You MUST make sure every tool is part of a category. Your response must follow the JSON schema:<br />
				<br />
				```<br />
				{JSON.stringify({
					type: 'array',
					items: {
						type: 'object',
						required: ['name', 'tools', 'summary'],
						properties: {
							name: {
								type: 'string',
								description: 'A short, unique name for the category across this response. It may only contain the characters a-z, A-Z, 0-9, and underscores. If a potential collision exists, add a short suffix to keep names unique (e.g., _testing, _packaging).',
								example: 'foo_language_tools'
							},
							tools: {
								type: 'array',
								description: 'The tool names that are part of this category.',
								items: { type: 'string' },
							},
							summary: {
								type: 'string',
								description: 'A summary of the tool capabilities, including their capabilities and how they can be used together. This may be up to five pararaphs long, be careful not to leave out important details.',
								example: 'These tools assist with authoring the "foo" language. They can provide diagnostics, run tests, and provide refactoring actions for the foo language.'
							},
						}
					} satisfies ObjectJsonSchema
				}, null, 2)}
			</UserMessage>
		</>;
	}
}

class ExistingGroupInformation extends PromptElement<BasePromptElementProps & { group: ISummarizedToolCategory }> {
	render() {
		const { group } = this.props;
		return <>
			{`<group name=${JSON.stringify(group.name)}>`}<br />
			{`<summary>${group.summary}</summary>`}<br />
			{group.tools.map(t => `<tool name=${JSON.stringify(t.name)} />\n`)}
			{`</group>`}<br />
		</>;
	}
}

class ExistingGroupCategorizerPrompt extends PromptElement<BasePromptElementProps & { existingGroups: ISummarizedToolCategory[]; newTools: LanguageModelToolInformation[] }> {
	render() {
		return <>
			<SystemMessage>
				Context: There are existing tool categories that have been previously established. New tools have become available and need to be categorized. You must decide whether each new tool fits into an existing category or requires a new category to be created.<br />
				<br />
				The user will provide you with the existing categories and their current tools, as well as the new tools that need to be categorized. You must assign each new tool to either an existing category (if it fits well) or create new categories as needed. You should also return all existing tools in their current categories unless there's a compelling reason to reorganize them.<br />
				<br />
				Every tool (both existing and new) MUST be part of EXACTLY one category in your response. Category names MUST be unique within the response. If a new category would conflict with an existing category name, choose a distinct, disambiguating name.<br />
			</SystemMessage>
			<UserMessage>
				**Existing Categories:**<br />
				{this.props.existingGroups.map(group => <ExistingGroupInformation group={group} />)}<br />

				**New Tools to Categorize:**<br />
				{this.props.newTools.map(tool => <ToolInformation tool={tool} />)}<br />
				<br />

				Instructions:<br />
				1. For each new tool, determine if it fits well into an existing category or if it needs a new category<br />
				2. Keep existing tools in their current categories unless there's a strong reason to move them<br />
				3. Create new categories only when new tools don't fit well into existing ones<br />
				4. Every tool (existing + new) MUST appear in exactly one category<br />
				<br />
				Your response must follow the JSON schema:<br />
				<br />
				```<br />
				{JSON.stringify({
					type: 'array',
					items: {
						type: 'object',
						required: ['name', 'tools', 'summary'],
						properties: {
							name: {
								type: 'string',
								description: 'A short, unique name for the category across this response. It may only contain the characters a-z, A-Z, 0-9, and underscores. Do not reuse names; add a short suffix if needed to avoid collisions.',
								example: 'foo_language_tools'
							},
							tools: {
								type: 'array',
								description: 'The tool names that are part of this category.',
								items: { type: 'string' },
							},
							summary: {
								type: 'string',
								description: 'A summary of the tool capabilities, including their capabilities and how they can be used together. This may be up to five pararaphs long, be careful not to leave out important details.',
								example: 'These tools assist with authoring the "foo" language. They can provide diagnostics, run tests, and provide refactoring actions for the foo language.'
							},
						}
					} satisfies ObjectJsonSchema
				}, null, 2)}
			</UserMessage>
		</>;
	}
}

async function getJsonResponse(endpoint: IChatEndpoint, rendered: RenderPromptResult, token: CancellationToken): Promise<unknown | undefined> {

	const result = await endpoint.makeChatRequest(
		'summarizeVirtualTools',
		rendered.messages,
		undefined,
		token,
		ChatLocation.Other
	);

	if (result.type !== ChatFetchResponseType.Success) {
		return undefined;
	}

	for (const block of extractCodeBlocks(result.value)) {
		try {
			return JSONC.parse(block.code);
		} catch {
			// ignored
		}
	}

	const idx = result.value.indexOf('{');
	return JSONC.parse(result.value.slice(idx)) || undefined;
}
