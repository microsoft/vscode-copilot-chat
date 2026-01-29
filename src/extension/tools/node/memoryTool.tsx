/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../vscodeTypes';
import { IAgentMemoryService, RepoMemoryEntry } from '../common/agentMemoryService';
import { ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';

/**
 * Simplified memory parameters for non-Anthropic models (direct store interface).
 */
interface ISimplifiedMemoryParams {
	subject: string;
	fact: string;
	citations: string;
	reason: string;
	category: string;
}


interface MemoryResult {
	success?: string;
	error?: string;
}

/**
 * Simplified memory tool for non-Claude models.
 * Stores facts directly using the simplified schema defined in package.json.
 * Tool definition is in package.json, enabled when copilotMemory.enabled is true.
 */
class MemoryTool implements ICopilotTool<ISimplifiedMemoryParams> {
	public static readonly toolName = ToolName.Memory;

	constructor(
		@IAgentMemoryService private readonly agentMemoryService: IAgentMemoryService
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<ISimplifiedMemoryParams>, _token: CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const params = options.input;
		const result = await this._storeMemory(params);

		const resultText = result.error
			? `Error: ${result.error}`
			: result.success || '';

		return new LanguageModelToolResult([
			new LanguageModelTextPart(resultText)
		]);
	}

	/**
	 * Store a memory fact using the Copilot Memory service.
	 */
	private async _storeMemory(params: ISimplifiedMemoryParams): Promise<MemoryResult> {
		try {
			const isEnabled = await this.agentMemoryService.checkMemoryEnabled();
			if (!isEnabled) {
				return { error: 'Copilot Memory is not enabled. Memory storage requires Copilot Memory to be enabled.' };
			}

			const entry: RepoMemoryEntry = {
				subject: params.subject,
				fact: params.fact,
				citations: params.citations,
				reason: params.reason,
				category: params.category,
			};

			const success = await this.agentMemoryService.storeRepoMemory(entry);
			if (success) {
				return { success: `Successfully stored memory: "${params.subject}"` };
			} else {
				return { error: 'Failed to store memory entry' };
			}
		} catch (error) {
			return { error: `Cannot store memory: ${error.message}` };
		}
	}
}

ToolRegistry.registerTool(MemoryTool);