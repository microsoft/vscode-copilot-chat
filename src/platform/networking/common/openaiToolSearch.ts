/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { nonDeferredToolNames } from './anthropic';
import { OpenAiFunctionTool, OpenAiResponsesFunctionTool } from './fetch';

export interface OpenAiResponsesDeferredFunctionTool extends OpenAiResponsesFunctionTool {
	defer_loading?: true;
}

export interface OpenAiResponsesHostedToolSearchTool {
	type: 'tool_search';
	execution?: 'server';
	description?: string;
	parameters?: Record<string, unknown>;
}

export interface OpenAiResponsesNamespaceTool {
	type: 'namespace';
	name: string;
	description: string;
	tools: OpenAiResponsesDeferredFunctionTool[];
}

export type OpenAiResponsesTool = OpenAiResponsesDeferredFunctionTool | OpenAiResponsesHostedToolSearchTool | OpenAiResponsesNamespaceTool;

export function isOpenAIToolSearchEnabled(model: string | { family: string }): boolean {
	const family = typeof model === 'string' ? model : model.family;
	const match = family.match(/^gpt-(\d+)\.(\d+)(?:[.-]|$)/i);
	if (!match) {
		return false;
	}

	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	return major > 5 || (major === 5 && minor >= 4);
}

export function getOpenAIToolSearchTools(requestTools: readonly OpenAiFunctionTool[] | undefined, requiredToolName?: string): OpenAiResponsesTool[] | undefined {
	if (!requestTools?.length) {
		return undefined;
	}

	const immediateToolNames = new Set(nonDeferredToolNames);
	if (requiredToolName) {
		immediateToolNames.add(requiredToolName);
	}

	const immediateTools: OpenAiResponsesDeferredFunctionTool[] = [];
	const deferredTools: OpenAiResponsesDeferredFunctionTool[] = [];

	for (const tool of requestTools) {
		const functionTool: OpenAiResponsesDeferredFunctionTool = {
			...tool.function,
			type: 'function',
			strict: false,
			parameters: (tool.function.parameters || {}) as Record<string, unknown>,
		};

		if (immediateToolNames.has(tool.function.name)) {
			immediateTools.push(functionTool);
		} else {
			deferredTools.push({ ...functionTool, defer_loading: true });
		}
	}

	if (!deferredTools.length) {
		return immediateTools;
	}

	return [
		...immediateTools,
		...deferredTools,
		{ type: 'tool_search' },
	];
}