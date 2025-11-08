/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MicroPython script runner process
 * This runs as a separate Node.js child process with restricted permissions.
 * Communication happens over stdio using JSON messages.
 */

import MicroPythonRuntime, { type PythonGlobals } from '@vscode/micropython-wasm';

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

class MicroPythonScriptRunner {
	private runtime: MicroPythonRuntime | undefined;
	private pendingToolCalls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	constructor() {
		this.setupIpc();
	}

	private setupIpc(): void {
		let buffer = '';

		process.stdin.on('data', (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (line.trim()) {
					try {
						const message = JSON.parse(line) as IpcMessage;
						this.handleMessage(message);
					} catch (error) {
						this.sendError(`Failed to parse message: ${error}`);
					}
				}
			}
		});

		process.stdin.on('end', () => {
			this.cleanup();
		});
	}

	private async handleMessage(message: IpcMessage): Promise<void> {
		try {
			if (message.type === 'execute') {
				await this.executeScript(message);
			} else if (message.type === 'tool_call_response') {
				this.handleToolCallResponse(message);
			}
		} catch (error) {
			this.sendError(`Error handling message: ${error}`);
		}
	}

	private async executeScript(request: ExecuteScriptRequest): Promise<void> {
		try {
			// Initialize MicroPython runtime if not already done
			if (!this.runtime) {
				// Point to the copied WASM files in the same directory as this script
				const wasmPath = __dirname;
				try {
					const rt = new MicroPythonRuntime({
						wasmPath,
						enableDebug: false,
						heapsize: 2 * 1024 * 1024, // 2MB
					});
					await rt.init();
					this.runtime = rt;
				} catch (initError) {
					throw new Error(`Failed to initialize MicroPython runtime: ${initError instanceof Error ? initError.message : String(initError)}`);
				}

				if (!this.runtime) {
					throw new Error('MicroPython runtime failed to initialize');
				}
			}

			// Create global functions for each tool
			const globals: PythonGlobals = {};

			for (const [toolName] of Object.entries(request.tools)) {
				// All tools are async
				globals[toolName] = async (...args: unknown[]) => {
					const result = await this.callTool(toolName, args.length === 1 ? args[0] : args);
					return result;
				};
			}

			// Execute the script with the tool functions available
			// Wrap the script in a function if it contains 'return' statements
			let scriptToExecute = request.script;
			if (request.script.trim().match(/^\s*return\s+/m)) {
				// Script uses return statements, wrap it in a function and call it
				scriptToExecute = `async def __main__():\n${request.script.split('\n').map(line => '    ' + line).join('\n')}\nawait __main__()`;
			}

			const result = await this.runtime.evaluate(scriptToExecute, globals);
			// Send the result back
			const response: ExecuteScriptResponse = {
				type: 'result',
				result,
			};
			this.sendMessage(response);
		} catch (error) {
			const response: ExecuteScriptResponse = {
				type: 'result',
				error: error instanceof Error ? error.stack || error.message : String(error),
			};
			this.sendMessage(response);
		}
	}

	private callTool(toolName: string, input: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const callbackId = Math.random().toString(36).substring(7);
			this.pendingToolCalls.set(callbackId, { resolve, reject });

			const request: ToolCallRequest = {
				type: 'tool_call',
				toolName,
				input,
				callbackId,
			};

			this.sendMessage(request);

			// Timeout after 60 seconds
			setTimeout(() => {
				const pending = this.pendingToolCalls.get(callbackId);
				if (pending) {
					this.pendingToolCalls.delete(callbackId);
					pending.reject(new Error(`Tool call timeout: ${toolName}`));
				}
			}, 60000);
		});
	}

	private handleToolCallResponse(response: ToolCallResponse): void {
		const pending = this.pendingToolCalls.get(response.callbackId);
		if (pending) {
			this.pendingToolCalls.delete(response.callbackId);
			if (response.error) {
				pending.reject(new Error(response.error));
			} else {
				pending.resolve(response.result);
			}
		}
	}

	private sendMessage(message: IpcMessage): void {
		process.stdout.write(JSON.stringify(message) + '\n');
	}

	private sendError(error: string): void {
		const response: ExecuteScriptResponse = {
			type: 'result',
			error,
		};
		this.sendMessage(response);
	}

	private cleanup(): void {
		if (this.runtime) {
			this.runtime.destroy();
			this.runtime = undefined;
		}
	}
}

// Start the runner
new MicroPythonScriptRunner();
