/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import { suite, test } from 'vitest';
import { URI } from '../../../../util/vs/base/common/uri';
import { CodeBlocksMetadata } from '../../../codeBlocks/node/codeBlockProcessor';

suite('Launch.json Button Detection', () => {

	test('should detect launch.json in .vscode folder with Unix path', () => {
		const codeBlocks = [{
			code: '{ "version": "0.2.0" }',
			resource: URI.file('/workspace/.vscode/launch.json'),
			language: 'json'
		}];

		const metadata = new CodeBlocksMetadata(codeBlocks);
		const hasLaunchJson = metadata.codeBlocks.some(codeBlock => {
			if (codeBlock.resource) {
				const path = codeBlock.resource.path.toLowerCase();
				return path.endsWith('launch.json') && (path.includes('/.vscode/') || path.includes('\\.vscode\\'));
			}
			return false;
		});

		assert.isTrue(hasLaunchJson, 'Should detect launch.json in .vscode folder');
	});

	test('should detect launch.json in .vscode folder with Windows path', () => {
		const codeBlocks = [{
			code: '{ "version": "0.2.0" }',
			resource: URI.file('C:\\workspace\\.vscode\\launch.json'),
			language: 'json'
		}];

		const metadata = new CodeBlocksMetadata(codeBlocks);
		const hasLaunchJson = metadata.codeBlocks.some(codeBlock => {
			if (codeBlock.resource) {
				const path = codeBlock.resource.path.toLowerCase();
				return path.endsWith('launch.json') && (path.includes('/.vscode/') || path.includes('\\.vscode\\'));
			}
			return false;
		});

		assert.isTrue(hasLaunchJson, 'Should detect launch.json in .vscode folder with Windows path');
	});

	test('should not detect launch.json outside .vscode folder', () => {
		const codeBlocks = [{
			code: '{ "version": "0.2.0" }',
			resource: URI.file('/workspace/launch.json'),
			language: 'json'
		}];

		const metadata = new CodeBlocksMetadata(codeBlocks);
		const hasLaunchJson = metadata.codeBlocks.some(codeBlock => {
			if (codeBlock.resource) {
				const path = codeBlock.resource.path.toLowerCase();
				return path.endsWith('launch.json') && (path.includes('/.vscode/') || path.includes('\\.vscode\\'));
			}
			return false;
		});

		assert.isFalse(hasLaunchJson, 'Should not detect launch.json outside .vscode folder');
	});

	test('should not detect other json files', () => {
		const codeBlocks = [{
			code: '{ "version": "0.2.0" }',
			resource: URI.file('/workspace/.vscode/settings.json'),
			language: 'json'
		}];

		const metadata = new CodeBlocksMetadata(codeBlocks);
		const hasLaunchJson = metadata.codeBlocks.some(codeBlock => {
			if (codeBlock.resource) {
				const path = codeBlock.resource.path.toLowerCase();
				return path.endsWith('launch.json') && (path.includes('/.vscode/') || path.includes('\\.vscode\\'));
			}
			return false;
		});

		assert.isFalse(hasLaunchJson, 'Should not detect other json files');
	});

	test('should handle code blocks without resources', () => {
		const codeBlocks = [{
			code: '{ "version": "0.2.0" }',
			language: 'json'
		}];

		const metadata = new CodeBlocksMetadata(codeBlocks);
		const hasLaunchJson = metadata.codeBlocks.some(codeBlock => {
			if (codeBlock.resource) {
				const path = codeBlock.resource.path.toLowerCase();
				return path.endsWith('launch.json') && (path.includes('/.vscode/') || path.includes('\\.vscode\\'));
			}
			return false;
		});

		assert.isFalse(hasLaunchJson, 'Should handle code blocks without resources');
	});

	test('should detect launch.json in nested .vscode folder', () => {
		const codeBlocks = [{
			code: '{ "version": "0.2.0" }',
			resource: URI.file('/workspace/subfolder/.vscode/launch.json'),
			language: 'json'
		}];

		const metadata = new CodeBlocksMetadata(codeBlocks);
		const hasLaunchJson = metadata.codeBlocks.some(codeBlock => {
			if (codeBlock.resource) {
				const path = codeBlock.resource.path.toLowerCase();
				return path.endsWith('launch.json') && (path.includes('/.vscode/') || path.includes('\\.vscode\\'));
			}
			return false;
		});

		assert.isTrue(hasLaunchJson, 'Should detect launch.json in nested .vscode folder');
	});
});
