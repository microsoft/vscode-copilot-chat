/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { ObjectJsonSchema } from '../../../platform/configuration/common/jsonSchema';
import { ILogService } from '../../../platform/log/common/logService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { LanguageModelDataPart, LanguageModelTextPart, LanguageModelToolResult, MarkdownString } from '../../../vscodeTypes';
import { getContributedToolName, ToolName } from '../common/toolNames';
import { ICopilotTool, ToolRegistry } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { checkCancellation } from './toolUtils';

interface IRunAgentScriptToolParams {
	script: string;
}

interface ToolCallRequest {
	type: 'tool_call';
	toolName: string;
	input: unknown;
	callbackId: string;
}

interface ToolCallResponse {
	type: 'tool_call_response';
	callbackId: string;
	result?: unknown;
	error?: string;
}

interface ExecuteScriptRequest {
	type: 'execute';
	script: string;
	tools: Record<string, { input: unknown; output: unknown }>;
}

interface ExecuteScriptResponse {
	type: 'result';
	result?: unknown;
	error?: string;
}

type IpcMessage = ToolCallRequest | ToolCallResponse | ExecuteScriptRequest | ExecuteScriptResponse;

export class RunAgentScriptTool implements ICopilotTool<IRunAgentScriptToolParams> {

	public static readonly toolName = ToolName.RunAgentScript;
	public static runnerPath: string | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IToolsService private readonly toolsService: IToolsService
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IRunAgentScriptToolParams>, token: CancellationToken): Promise<vscode.LanguageModelToolResult | null | undefined> {
		checkCancellation(token);

		this.logService.trace(`[RunAgentScriptTool][invoke] Script: ${options.input.script}`);

		try {
			const result = await this.executeScript(options.input.script, token);

			// Return result as structured output using the json helper
			return new LanguageModelToolResult([
				new LanguageModelTextPart(typeof result === 'string' ? result : JSON.stringify(result, null, '\t')),
			]);
		} catch (error) {
			this.logService.error(`[RunAgentScriptTool][invoke] Error:`, error);
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`Error executing script: ${error instanceof Error ? error.message : String(error)}`)
			]);
		}
	}

	private async executeScript(script: string, token: CancellationToken): Promise<unknown> {
		return new Promise((resolve, reject) => {
			checkCancellation(token);

			// Get available tools with structured output
			const availableTools = this.getAvailableToolsWithStructuredOutput();

			// Start the MicroPython runner process with restricted permissions
			// Allow tests to override the runner path
			const runnerPath = RunAgentScriptTool.runnerPath || path.join(__dirname, 'scriptRunner', 'micropythonRunner.js');
			const nodePath = process.execPath;

			this.logService.trace(`[RunAgentScriptTool][executeScript] Starting runner: ${runnerPath}`);

			// Use --experimental-permission and --allow-fs-read to restrict the process
			const extensionPath = path.join(__dirname, '..', '..', '..', '..');
			const child: ChildProcess = spawn(nodePath, [
				'--experimental-permission',
				`--allow-fs-read=${extensionPath}`,
				runnerPath
			], {
				stdio: ['pipe', 'pipe', 'pipe'],
				cwd: __dirname,
			});

			let stdoutBuffer = '';
			let stderrBuffer = '';

			child.stdout!.on('data', (chunk) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split('\n');
				stdoutBuffer = lines.pop() || '';

				for (const line of lines) {
					if (line.trim()) {
						try {
							const message = JSON.parse(line) as IpcMessage;
							this.handleChildMessage(child, message, resolve, reject);
						} catch (error) {
							this.logService.error(`[RunAgentScriptTool][executeScript] Failed to parse message:`, error);
						}
					}
				}
			});

			child.stderr!.on('data', (chunk) => {
				stderrBuffer += chunk.toString();
				this.logService.error(`[RunAgentScriptTool][executeScript] stderr: ${chunk.toString()}`);
			});

			child.on('error', (error) => {
				this.logService.error(`[RunAgentScriptTool][executeScript] Process error: ${error.message}`);
				reject(error);
			});

			child.on('exit', (code) => {
				this.logService.trace(`[RunAgentScriptTool][executeScript] Process exited with code: ${code}`);
				if (code !== 0 && code !== null) {
					const errorMessage = stderrBuffer || `Script runner exited with code ${code}`;
					reject(new Error(errorMessage));
				}
			});

			// Handle cancellation
			token.onCancellationRequested(() => {
				this.logService.trace(`[RunAgentScriptTool][executeScript] Cancellation requested`);
				child.kill();
				reject(new Error('Cancelled'));
			});

			// Send the execute request
			const executeRequest: ExecuteScriptRequest = {
				type: 'execute',
				script,
				tools: availableTools,
			};
			this.sendMessage(child, executeRequest);
		});
	}

	private handleChildMessage(
		child: ChildProcess,
		message: IpcMessage,
		resolve: (value: unknown) => void,
		reject: (error: Error) => void
	): void {
		if (message.type === 'result') {
			if (message.error) {
				reject(new Error(message.error));
			} else {
				resolve(message.result);
			}
			child.kill();
		} else if (message.type === 'tool_call') {
			// Handle tool call from the script
			this.handleToolCall(child, message);
		}
	}

	private async handleToolCall(child: ChildProcess, request: ToolCallRequest): Promise<void> {
		try {
			// Find the tool
			const allTools = ToolRegistry.getTools();
			const toolCtor = allTools.find(t => t.toolName === request.toolName);

			if (!toolCtor) {
				const response: ToolCallResponse = {
					type: 'tool_call_response',
					callbackId: request.callbackId,
					error: `Tool not found: ${request.toolName}`,
				};
				this.sendMessage(child, response);
				return;
			}

			// Instantiate the tool
			const tool = this.instantiationService.createInstance(toolCtor);

			// Invoke the tool
			const result = await tool.invoke({
				input: request.input,
				toolInvocationToken: undefined,
				tokenizationOptions: undefined,
			} as any, CancellationToken.None);

			// Extract structured output if available
			let toolResult: unknown;
			if (result && 'content' in result && Array.isArray(result.content)) {
				const dataPart = result.content.find((part: any) =>
					part instanceof LanguageModelDataPart &&
					part.mimeType === 'application/vnd.code.tool.output'
				);
				if (dataPart) {
					// Access the data field on LanguageModelDataPart
					const dataPartTyped = dataPart as { data: Uint8Array; mimeType: string };
					const decoder = new TextDecoder();
					const jsonStr = decoder.decode(dataPartTyped.data);
					toolResult = JSON.parse(jsonStr);
				} else {
					// Fallback to text content
					toolResult = result.content
						.filter((part: any) => part instanceof LanguageModelTextPart)
						.map((part: any) => (part as LanguageModelTextPart).value)
						.join('\n');
				}
			}

			const response: ToolCallResponse = {
				type: 'tool_call_response',
				callbackId: request.callbackId,
				result: toolResult,
			};
			this.sendMessage(child, response);
		} catch (error) {
			this.logService.error(`[RunAgentScriptTool][handleToolCall] Error:`, error);
			const response: ToolCallResponse = {
				type: 'tool_call_response',
				callbackId: request.callbackId,
				error: error instanceof Error ? error.message : String(error),
			};
			this.sendMessage(child, response);
		}
	}

	private sendMessage(child: ChildProcess, message: IpcMessage): void {
		child.stdin!.write(JSON.stringify(message) + '\n');
	}

	private getAvailableToolsWithStructuredOutput() {
		const result: Record<string, { input: unknown; output: unknown }> = {};
		for (const [toolName, tool] of this.toolsService.copilotTools) {
			// Skip the RunAgentScriptTool itself to avoid recursion
			if (toolName === ToolName.RunAgentScript) {
				continue;
			}

			const found = vscode.lm.tools.find(t => t.name === getContributedToolName(toolName));
			if (tool.structuredOutput && found) {
				result[toolName] = {
					input: found.inputSchema || {},
					output: tool.structuredOutput,
				};
			}
		}

		return result;
	}

	alternativeDefinition(): vscode.LanguageModelToolInformation {
		// Get available tools to include in the description
		const availableTools = this.getAvailableToolsWithStructuredOutput();
		const toolDescriptions = Object.entries(availableTools)
			.map(([name, info]) => {
				return `  - ${name}(args: ${jsonSchemaToPythonType(info.input)}): ${jsonSchemaToPythonType(info.output)} `;
			})
			.join('\n');

		return {
			name: ToolName.RunAgentScript,
			tags: ['core', 'scripting', 'data-processing'],
			source: undefined,
			description: `Execute a Python script to perform complex data processing and filtering tasks. This tool should be preferred for any non-trivial operations that require:
- Filtering, transforming, or analyzing data from other tools
- Complex logic with conditionals and loops
- Processing collections or iterating over results
- Combining results from multiple tool calls

Available tools that can be called from within the script:
${toolDescriptions}

The script should return the final result, which will be automatically captured. All tool functions are async and must be called with 'await'. You do not have access to the filesystem, network, or process execution within this script outside of the provided tools.

Restrictions: this is running in a micropython environment, so some functions like 're.findall' are not implemented. DO NOT import asyncio, you can use top-level await calls in this script.

Example:
\`\`\`python
# Get files and filter them
files = await find_files(pattern="**/*.ts")
# Process and return relevant files
return [f for f in files if "test" not in f]
\`\`\``,
			inputSchema: {
				type: 'object',
				properties: {
					script: {
						type: 'string',
						description: 'Python script to execute. The script can call other tools using await. The last expression or return value will be the result.',
					},
				},
				required: ['script'],
			} as ObjectJsonSchema,
		};
	}

	prepareInvocation?(options: vscode.LanguageModelToolInvocationPrepareOptions<IRunAgentScriptToolParams>, token: vscode.CancellationToken): vscode.ProviderResult<vscode.PreparedToolInvocation> {
		checkCancellation(token);

		return {
			invocationMessage: new MarkdownString(l10n.t`Executing Python script to process data`),
			pastTenseMessage: new MarkdownString(l10n.t`Executed Python script`),
		};
	}
}

ToolRegistry.registerTool(RunAgentScriptTool);

/**
 * Converts a JSON schema to a Python type annotation string.
 * This is used to generate type hints for tool parameters in Python scripts.
 */
function jsonSchemaToPythonType(schema: unknown): string {
	if (!schema || typeof schema !== 'object') {
		return 'Any';
	}

	const s = schema as any;

	// Handle type arrays (union types)
	if (Array.isArray(s.type)) {
		const types = s.type.map((t: string) => jsonSchemaToPythonType({ type: t }));
		return types.join(' | ');
	}

	// Handle basic types
	switch (s.type) {
		case 'string':
			return 'str';
		case 'number':
		case 'integer':
			return 'int';
		case 'boolean':
			return 'bool';
		case 'null':
			return 'None';
		case 'array':
			if (s.items) {
				const itemType = jsonSchemaToPythonType(s.items);
				return `list[${itemType}]`;
			}
			return 'list';
		case 'object':
			if (s.properties) {
				const props = Object.entries(s.properties as Record<string, unknown>)
					.map(([key, value]) => `"${key}": ${jsonSchemaToPythonType(value)}`)
					.join(', ');
				return `dict { ${props} }`; // TypedDict would be more complex to generate
			}
			return 'dict';
		default:
			// Handle anyOf/oneOf/allOf
			if (s.anyOf || s.oneOf) {
				const schemas = s.anyOf || s.oneOf;
				const types = schemas.map((schema: unknown) => jsonSchemaToPythonType(schema));
				return types.join(' | ');
			}
			if (s.allOf) {
				// For allOf, we'd need intersection types which Python doesn't have natively
				// Fall back to Any
				return 'Any';
			}
			return 'Any';
	}
}
