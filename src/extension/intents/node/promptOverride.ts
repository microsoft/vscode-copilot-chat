/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { promises as fs } from 'fs';
import * as yaml from 'js-yaml';
import type { LanguageModelToolInformation } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';

interface PromptOverrideConfig {
	readonly systemPrompt?: string;
	readonly toolDescriptions?: Record<string, { readonly description: string }>;
}

/**
 * Applies debug prompt overrides from a YAML file.
 * Reads the file, parses it, and applies system prompt and/or tool description overrides.
 */
export async function applyPromptOverrides(
	filePath: string,
	messages: readonly Raw.ChatMessage[],
	tools: readonly LanguageModelToolInformation[],
	logService: ILogService,
): Promise<{ messages: Raw.ChatMessage[]; tools: LanguageModelToolInformation[] }> {
	let config: PromptOverrideConfig;
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		config = yaml.load(content) as PromptOverrideConfig;
	} catch (err) {
		logService.warn(`[PromptOverride] Failed to read or parse YAML file "${filePath}": ${err}`);
		return { messages: [...messages], tools: [...tools] };
	}

	if (!config || typeof config !== 'object') {
		return { messages: [...messages], tools: [...tools] };
	}

	let resultMessages = [...messages];
	let resultTools = [...tools];

	if (typeof config.systemPrompt === 'string') {
		resultMessages = applySystemPromptOverride(resultMessages, config.systemPrompt);
		logService.trace('[PromptOverride] Applied system prompt override');
	}

	if (config.toolDescriptions && typeof config.toolDescriptions === 'object') {
		resultTools = applyToolDescriptionOverrides(resultTools, config.toolDescriptions);
		logService.trace('[PromptOverride] Applied tool description overrides');
	}

	return { messages: resultMessages, tools: resultTools };
}

function applySystemPromptOverride(messages: Raw.ChatMessage[], systemPrompt: string): Raw.ChatMessage[] {
	const nonSystemMessages = messages.filter(m => m.role !== Raw.ChatRole.System);
	return [
		{
			role: Raw.ChatRole.System,
			content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: systemPrompt }],
		},
		...nonSystemMessages,
	];
}

function applyToolDescriptionOverrides(
	tools: readonly LanguageModelToolInformation[],
	overrides: Record<string, { readonly description: string }>,
): LanguageModelToolInformation[] {
	return tools.map(tool => {
		const override = overrides[tool.name];
		if (override && typeof override.description === 'string') {
			return { ...tool, description: override.description };
		}
		return tool;
	});
}
