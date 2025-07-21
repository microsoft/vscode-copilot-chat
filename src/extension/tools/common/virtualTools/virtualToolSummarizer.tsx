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
import { ISummarizedToolCategory, SummarizerError } from './virtualToolTypes';
import { isDefined } from '../../../../util/vs/base/common/types';

export async function summarizeToolGroup(endpoint: IChatEndpoint, tools: LanguageModelToolInformation[], token: CancellationToken): Promise<ISummarizedToolCategory | undefined> {
	const renderer = new PromptRenderer(endpoint, GeneralSummaryPrompt, { tools }, endpoint.acquireTokenizer());
	const result = await renderer.render(undefined, token);
	const json = await getJsonResponse<{ summary: string; name: string }>(endpoint, result, token);
	if (!json) {
		return undefined;
	}
	if (typeof json.summary !== 'string' || typeof json.name !== 'string') {
		throw new SummarizerError('Invalid response from summarizer: ' + JSON.stringify(json));
	}

	return json ? { ...json, tools } : undefined;
}

export async function divideToolsIntoGroups(endpoint: IChatEndpoint, tools: LanguageModelToolInformation[], token: CancellationToken): Promise<ISummarizedToolCategory[] | undefined> {
	const renderer = new PromptRenderer(endpoint, CategorizerSummaryPrompt, { tools }, endpoint.acquireTokenizer());
	const result = await renderer.render(undefined, token);
	const json = await getJsonResponse<{ name: string; summary: string; tools: string[] }[]>(endpoint, result, token);
	if (!json) {
		return undefined;
	}

	if (!Array.isArray(json)) {
		throw new SummarizerError('Invalid response from categorizer: ' + JSON.stringify(json));
	}

	if (!json.every(item => typeof item.name === 'string' && typeof item.summary === 'string' && Array.isArray(item.tools) && item.tools.every(t => typeof t === 'string'))) {
		throw new SummarizerError('Invalid response from categorizer: ' + JSON.stringify(json));
	}

	// todo: handle tools that did not get assigned to any group

	return json.map((item): ISummarizedToolCategory => ({
		name: item.name,
		summary: item.summary,
		tools: item.tools.map(toolName => tools.find(tool => tool.name === toolName)).filter(isDefined),
	}));
}

class ToolInformation extends PromptElement<BasePromptElementProps & { tool: LanguageModelToolInformation }> {
	render() {
		const { tool } = this.props;
		return <>
			{tool.name}: {tool.description}<br />
		</>;
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
				The user present you with the tools available to them, and you must group them into logical categories and provide a summary of each one. The summary should include the capabilities of the tools and when they should be used. Every tool MUST be a part of EXACTLY one category.<br />
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
								description: 'A short name for the category. It may only contain the characters a-z, A-Z, 0-9, and underscores.',
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

async function getJsonResponse<T>(endpoint: IChatEndpoint, rendered: RenderPromptResult, token: CancellationToken): Promise<T | undefined> {

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
