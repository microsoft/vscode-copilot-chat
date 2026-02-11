/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { DEBUG_ALLOWED_TOOLS, DEBUG_MAX_TOOL_CALLS, DEBUG_SYSTEM_PROMPT } from '../common/debugConstants';
import { IDebugContextService } from '../common/debugContextService';

/**
 * Direct invocation of debug analysis without going through chat UI.
 * Uses vscode.lm API directly to run debug queries silently.
 */
export class DirectDebugInvoker {

	constructor(
		private readonly _debugContextService: IDebugContextService
	) { }

	/**
	 * Execute a debug query directly without showing in chat UI
	 */
	async executeQuery(query: string, token?: CancellationToken): Promise<string> {
		const cts = new CancellationTokenSource(token);

		try {
			// Get a chat model
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			if (models.length === 0) {
				throw new Error('No chat models available');
			}
			const model = models[0];

			// Get debug tools
			const debugTools = this._getDebugTools();
			if (debugTools.length === 0) {
				throw new Error('Debug tools not available');
			}

			// Build initial messages
			const messages: vscode.LanguageModelChatMessage[] = [
				vscode.LanguageModelChatMessage.User(this._buildSystemPrompt()),
				vscode.LanguageModelChatMessage.User(query)
			];

			// Tool calling loop
			let toolCallCount = 0;
			let lastResponse = '';

			while (toolCallCount < DEBUG_MAX_TOOL_CALLS) {
				if (cts.token.isCancellationRequested) {
					throw new Error('Query cancelled');
				}

				const response = await model.sendRequest(messages, {
					tools: debugTools,
				}, cts.token);

				// Collect response parts
				let textContent = '';
				const toolCalls: { callId: string; name: string; input: object }[] = [];

				for await (const part of response.stream) {
					if (part instanceof vscode.LanguageModelTextPart) {
						textContent += part.value;
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						toolCalls.push({
							callId: part.callId,
							name: part.name,
							input: part.input as object
						});
					}
				}

				// If no tool calls, we're done
				if (toolCalls.length === 0) {
					lastResponse = textContent;
					break;
				}

				// Add assistant message with tool calls
				messages.push(vscode.LanguageModelChatMessage.Assistant([
					new vscode.LanguageModelTextPart(textContent),
					...toolCalls.map(tc => new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input))
				]));

				// Execute tool calls and add results
				const toolResults: vscode.LanguageModelToolResultPart[] = [];
				for (const toolCall of toolCalls) {
					toolCallCount++;
					try {
						const result = await vscode.lm.invokeTool(toolCall.name, {
							input: toolCall.input,
							toolInvocationToken: undefined
						}, cts.token);

						// Convert result to text
						let resultText = '';
						for (const part of result.content) {
							if (part instanceof vscode.LanguageModelTextPart) {
								resultText += part.value;
							}
						}
						toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.callId, [
							new vscode.LanguageModelTextPart(resultText)
						]));
					} catch (error) {
						const errorMsg = error instanceof Error ? error.message : String(error);
						toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.callId, [
							new vscode.LanguageModelTextPart(`Error: ${errorMsg}`)
						]));
					}
				}

				// Add tool results message
				messages.push(vscode.LanguageModelChatMessage.User(toolResults));

				// If we got text content with tool calls, that's likely a partial response
				if (textContent) {
					lastResponse = textContent;
				}
			}

			// Fire event with the response
			this._debugContextService.fireDebugSubagentResponse({
				query,
				response: lastResponse,
				success: true,
				timestamp: new Date()
			});

			return lastResponse;

		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const response = `Debug analysis failed: ${errorMsg}`;

			this._debugContextService.fireDebugSubagentResponse({
				query,
				response,
				success: false,
				timestamp: new Date()
			});

			return response;
		} finally {
			cts.dispose();
		}
	}

	private _getDebugTools(): vscode.LanguageModelChatTool[] {
		const allTools = vscode.lm.tools;
		return allTools
			.filter(tool => DEBUG_ALLOWED_TOOLS.has(tool.name))
			.map(tool => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema as Record<string, unknown> | undefined
			}));
	}

	private _buildSystemPrompt(): string {
		return DEBUG_SYSTEM_PROMPT;
	}
}
