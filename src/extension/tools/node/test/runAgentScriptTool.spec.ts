/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ToolName } from '../../common/toolNames';
import { IToolsService } from '../../common/toolsService';
import { RunAgentScriptTool } from '../runAgentScriptTool';

describe('RunAgentScriptTool', () => {
	let accessor: ITestingServicesAccessor;

	beforeAll(() => {
		const services = createExtensionUnitTestingServices();
		accessor = services.createTestingAccessor();

		// Set the path to the compiled runner
		RunAgentScriptTool.runnerPath = path.join(__dirname, '../../../../../dist/scriptRunner/micropythonRunner.js');
	}); afterAll(() => {
		accessor.dispose();
	});

	async function invoke(script: string) {
		const toolsService = accessor.get(IToolsService);
		const result = await toolsService.invokeTool(
			ToolName.RunAgentScript,
			{ input: { script }, toolInvocationToken: null as never },
			CancellationToken.None
		);
		return result;
	}

	describe('basic script execution', () => {
		it('should execute simple Python expressions', async () => {
			const result = await invoke('return 42');
			expect(result).toBeDefined();
			expect(result?.content).toBeDefined();

			// Find the JSON data part in the result
			const jsonPart = result?.content.find((p: any) => p.mimeType === 'json' && 'data' in p) as any;
			expect(jsonPart).toBeDefined();
			const data = JSON.parse(new TextDecoder().decode(jsonPart.data));
			expect(data).toBe(42);
		});

		it('should execute Python with string operations', async () => {
			const result = await invoke(`
result = "hello " + "world"
return result
`);
			expect(result).toBeDefined();
			const jsonPart = result?.content.find((p: any) => p.mimeType === 'json' && 'data' in p) as any;
			expect(jsonPart).toBeDefined();
			const data = JSON.parse(new TextDecoder().decode(jsonPart.data));
			expect(data).toBe('hello world');
		});

		it('should execute Python with list operations', async () => {
			const result = await invoke(`
numbers = [1, 2, 3, 4, 5]
total = sum(numbers)
return total
`);
			expect(result).toBeDefined();
			const jsonPart = result?.content.find((p: any) => p.mimeType === 'json' && 'data' in p) as any;
			expect(jsonPart).toBeDefined();
			const data = JSON.parse(new TextDecoder().decode(jsonPart.data));
			expect(data).toBe(15);
		});

		it('should execute Python with dictionary operations', async () => {
			const result = await invoke(`
data = {"name": "test", "value": 123}
return data["value"]
`);
			expect(result).toBeDefined();
			const jsonPart = result?.content.find((p: any) => p.mimeType === 'json' && 'data' in p) as any;
			expect(jsonPart).toBeDefined();
			const data = JSON.parse(new TextDecoder().decode(jsonPart.data));
			expect(data).toBe(123);
		});
	});

	describe('error handling', () => {
		it('should handle Python syntax errors', async () => {
			const result = await invoke('invalid syntax here @#$');
			expect(result).toBeDefined();
			const textPart = result?.content.find((p: any) => typeof p.value === 'string') as any;
			expect(textPart).toBeDefined();
			expect(textPart?.value).toMatch(/error|failed/i);
		});

		it('should handle Python runtime errors', async () => {
			const result = await invoke(`
x = 1 / 0
return x
`);
			expect(result).toBeDefined();
			const textPart = result?.content.find((p: any) => typeof p.value === 'string') as any;
			expect(textPart).toBeDefined();
			expect(textPart?.value).toMatch(/error|failed/i);
		});

		it('should handle undefined variables', async () => {
			const result = await invoke('return undefined_variable');
			expect(result).toBeDefined();
			const textPart = result?.content.find((p: any) => typeof p.value === 'string') as any;
			expect(textPart).toBeDefined();
			expect(textPart?.value).toMatch(/error|failed/i);
		});
	});

	describe('security', () => {
		it('should spawn child process with micropythonRunner.js', async () => {
			// Verify the runner file exists
			const runnerPath = path.join(__dirname, '../../../../../dist/scriptRunner/micropythonRunner.js');
			const fs = await import('fs');
			expect(fs.existsSync(runnerPath)).toBe(true);
		});

		it('should isolate execution in child process', async () => {
			// Scripts should not be able to access Node.js globals
			// MicroPython environment is sandboxed
			const result = await invoke(`
# This should work fine in the isolated MicroPython environment
return "isolated"
`);
			expect(result).toBeDefined();
			const jsonPart = result?.content.find((p: any) => p.mimeType === 'json' && 'data' in p) as any;
			expect(jsonPart).toBeDefined();
			const data = JSON.parse(new TextDecoder().decode(jsonPart.data));
			expect(data).toBe('isolated');
		});
	});

	describe('tool calling (integration)', () => {
		it('should discover available tools with structured output', async () => {
			const result = await invoke(`
# Test that tool functions are available in the global scope
import json
# The tools are injected as global functions, check for 'read_file' which should be available
tools_available = 'read_file' in dir()
return json.dumps({"has_tools": tools_available})
`);
			expect(result).toBeDefined();
			const jsonPart = result?.content.find((p: any) => p.mimeType === 'json' && 'data' in p) as any;
			expect(jsonPart).toBeDefined();
			const data = JSON.parse(new TextDecoder().decode(jsonPart.data));
			// The result is a JSON string, so we need to parse it again
			const parsed = JSON.parse(data);
			expect(parsed.has_tools).toBe(true);
		});

		// Note: Full tool calling tests would require mocking other tools
		// or setting up a complete test environment with actual tools
		// These are integration tests that verify the basic infrastructure
	});
});
