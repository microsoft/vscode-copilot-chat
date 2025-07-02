/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { suite, test } from 'vitest';
import type { ChatVulnerability } from 'vscode';
import { URI } from '../../../../util/vs/base/common/uri';
import { MarkdownString } from '../../../../vscodeTypes';
import { CodeBlockInfo, CodeBlockProcessor } from '../codeBlockProcessor';

suite('CodeBlockProcessor - Inline Chat Fix Bug Tests', () => {

	interface MockOutputRecord {
		type: 'markdown' | 'codeblockUri';
		content: string;
		codeBlockInfo?: CodeBlockInfo;
		vulnerabilities?: ChatVulnerability[];
	}

	/**
	 * Test for the specific bug where codeblock contents would disappear
	 * when applyCodeBlock was true or when not in first sentence.
	 * This ensures the fix maintains proper content output.
	 */
	test('codeblock content should never disappear due to early returns', () => {
		const mockOutput: MockOutputRecord[] = [];

		// Create a processor that simulates the inline chat fix scenario
		const processor = new CodeBlockProcessor(
			(path) => URI.file(path),
			(markdown, codeBlockInfo, vulnerabilities) => {
				// This should ALWAYS be called to prevent content from disappearing
				mockOutput.push({
					type: 'markdown',
					content: markdown.value,
					codeBlockInfo,
					vulnerabilities
				});
			},
			() => { }, // codeblock callback not relevant for this test
		);

		// Test case 1: Process a codeblock that would previously cause content to disappear
		const testMarkdown = [
			'Here is how to contribute settings:\n',
			'```typescript\n',
			'// In your package.json\n',
			'"contributes": {\n',
			'  "configuration": {\n',
			'    "type": "object",\n',
			'    "title": "My Extension"\n',
			'  }\n',
			'}\n',
			'```\n',
			'This shows the basic structure.\n'
		].join('');

		processor.processMarkdown(testMarkdown);
		processor.flush();

		// Verify that ALL content was output (no content disappeared)
		const allContent = mockOutput.map(record => record.content).join('');
		
		// The key assertion: all original content should be preserved
		assert.include(allContent, 'Here is how to contribute settings:');
		assert.include(allContent, '```typescript');
		assert.include(allContent, '"contributes"');
		assert.include(allContent, '"configuration"');
		assert.include(allContent, '```');
		assert.include(allContent, 'This shows the basic structure.');

		// Verify we have the expected number of markdown calls (no missing content)
		assert.isAbove(mockOutput.length, 0, 'Should have markdown output records');
		
		// Ensure no content was lost - the total length should match expectation
		const expectedMinimumCalls = 6; // At least: intro text, opening fence, code lines, closing fence, closing text
		assert.isAtLeast(mockOutput.length, expectedMinimumCalls, 
			`Expected at least ${expectedMinimumCalls} markdown calls but got ${mockOutput.length}. This indicates content may have been lost.`);
	});

	/**
	 * Test the specific scenario mentioned in the bug report:
	 * VS Code chat participant responding to "how does one contribute settings from a vscode extension?"
	 */
	test('vscode extension settings question response should preserve all content', () => {
		const mockOutput: MockOutputRecord[] = [];

		const processor = new CodeBlockProcessor(
			(path) => URI.file(path),
			(markdown, codeBlockInfo, vulnerabilities) => {
				mockOutput.push({
					type: 'markdown',
					content: markdown.value,
					codeBlockInfo,
					vulnerabilities
				});
			},
			() => { },
		);

		// Simulate the type of response that would cause the bug
		const vscodeSettingsResponse = [
			'To contribute settings from a VS Code extension, you need to:\n',
			'\n',
			'1. Define your configuration in `package.json`:\n',
			'\n',
			'```json\n',
			'{\n',
			'  "contributes": {\n',
			'    "configuration": {\n',
			'      "type": "object",\n',
			'      "title": "My Extension Configuration",\n',
			'      "properties": {\n',
			'        "myExtension.enable": {\n',
			'          "type": "boolean",\n',
			'          "default": true,\n',
			'          "description": "Enable my extension"\n',
			'        }\n',
			'      }\n',
			'    }\n',
			'  }\n',
			'}\n',
			'```\n',
			'\n',
			'2. Access the settings in your extension code:\n',
			'\n',
			'```typescript\n',
			'import * as vscode from "vscode";\n',
			'\n',
			'const config = vscode.workspace.getConfiguration("myExtension");\n',
			'const isEnabled = config.get("enable");\n',
			'```\n',
			'\n',
			'This approach allows users to customize your extension behavior.\n'
		].join('');

		processor.processMarkdown(vscodeSettingsResponse);
		processor.flush();

		const allContent = mockOutput.map(record => record.content).join('');

		// Verify all parts of the response are preserved
		assert.include(allContent, 'To contribute settings from a VS Code extension');
		assert.include(allContent, '"contributes"');
		assert.include(allContent, '"configuration"');
		assert.include(allContent, '"myExtension.enable"');
		assert.include(allContent, 'import * as vscode');
		assert.include(allContent, 'vscode.workspace.getConfiguration');
		assert.include(allContent, 'This approach allows users to customize');

		// Ensure we have substantial content (not just fragments)
		assert.isAbove(allContent.length, 500, 'Response should contain substantial content');
		
		// Check that both JSON and TypeScript code blocks are preserved
		const jsonBlockCount = (allContent.match(/```json/g) || []).length;
		const tsBlockCount = (allContent.match(/```typescript/g) || []).length;
		
		assert.equal(jsonBlockCount, 1, 'Should preserve JSON code block');
		assert.equal(tsBlockCount, 1, 'Should preserve TypeScript code block');
	});

});