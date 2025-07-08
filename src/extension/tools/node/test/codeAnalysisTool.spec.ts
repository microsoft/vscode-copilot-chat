/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CodeAnalysisTool } from '../codeAnalysisTool';

describe('CodeAnalysisTool', () => {

	it('should have correct tool name', () => {
		const tool = new CodeAnalysisTool(null as any, null as any);
		expect(tool.toolName).toBe('code_analysis');
	});

	it('should analyze basic TypeScript code correctly', async () => {
		const mockWorkspaceService = {
			openTextDocument: async () => ({
				getText: () => `
// This is a comment
function hello(name: string): string {
	if (name) {
		return \`Hello, \${name}!\`;
	}
	return 'Hello, World!';
}

class Person {
	constructor(public name: string) {}

	greet(): string {
		return hello(this.name);
	}
}

// TODO: Add more features
export default Person;
`
			})
		};

		const mockPromptService = {
			resolveFilePath: () => ({ fsPath: '/test/file.ts' })
		};

		const tool = new CodeAnalysisTool(mockPromptService as any, mockWorkspaceService as any);

		const result = await tool.invoke({
			input: { filePath: '/test/file.ts', analysisType: 'detailed' }
		} as any, null as any);

		expect(result.content).toBeDefined();
		expect(result.content.length).toBeGreaterThan(0);

		const content = result.content[0] as any;
		const text = String(content.value || content);

		// Check for basic metrics
		expect(text).toContain('Total Lines');
		expect(text).toContain('Functions');
		expect(text).toContain('Classes');
		expect(text).toContain('TODOs');
	});

	it('should handle Python code', async () => {
		const mockWorkspaceService = {
			openTextDocument: async () => ({
				getText: () => `
# Python example
def calculate_sum(a, b):
    """Calculate sum of two numbers"""
    if a > 0 and b > 0:
        return a + b
    return 0

class Calculator:
    def __init__(self):
        pass

    def add(self, x, y):
        return calculate_sum(x, y)

# FIXME: Handle negative numbers
`
			})
		};

		const mockPromptService = {
			resolveFilePath: () => ({ fsPath: '/test/calc.py' })
		};

		const tool = new CodeAnalysisTool(mockPromptService as any, mockWorkspaceService as any);

		const result = await tool.invoke({
			input: { filePath: '/test/calc.py', analysisType: 'basic' }
		} as any, null as any);

		const content = result.content[0] as any;
		const text = String(content.value || content);

		expect(text).toContain('Total Lines');
		expect(text).toContain('Functions');
		expect(text).toContain('File Type: .py');
	});

	it('should provide quality insights', async () => {
		// Large file with many functions
		const largeCode = Array(60).fill(0).map((_, i) =>
			`function func${i}() { return ${i}; }`
		).join('\n');

		const mockWorkspaceService = {
			openTextDocument: async () => ({
				getText: () => largeCode
			})
		};

		const mockPromptService = {
			resolveFilePath: () => ({ fsPath: '/test/large.js' })
		};

		const tool = new CodeAnalysisTool(mockPromptService as any, mockWorkspaceService as any);

		const result = await tool.invoke({
			input: { filePath: '/test/large.js', analysisType: 'basic' }
		} as any, null as any);

		const content = result.content[0];
		const text = content.toString();

		expect(text).toContain('High function count');
	});

	it('should handle errors gracefully', async () => {
		const mockWorkspaceService = {
			openTextDocument: async () => {
				throw new Error('File not found');
			}
		};

		const mockPromptService = {
			resolveFilePath: () => ({ fsPath: '/test/missing.ts' })
		};

		const tool = new CodeAnalysisTool(mockPromptService as any, mockWorkspaceService as any);

		const result = await tool.invoke({
			input: { filePath: '/test/missing.ts' }
		} as any, null as any);

		const content = result.content[0];
		const text = content.toString();

		expect(text).toContain('Error analyzing file');
		expect(text).toContain('File not found');
	});
});
