/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { suite, test } from 'vitest';
import { URI } from '../../../util/vs/base/common/uri';
import { isAzureDevOpsRemoteRepository, isGitHubRemoteRepository } from '../common/utils';

suite('Remote Repository Utils', () => {
	suite('isGitHubRemoteRepository', () => {
		test('should return true for GitHub remote repository URI', () => {
			const uri = URI.parse('vscode-vfs://github/microsoft/vscode');
			assert.strictEqual(isGitHubRemoteRepository(uri), true);
		});

		test('should return false for non-GitHub vscode-vfs URI', () => {
			const uri = URI.parse('vscode-vfs://azurerepos/org/project/repo');
			assert.strictEqual(isGitHubRemoteRepository(uri), false);
		});

		test('should return false for file URI', () => {
			const uri = URI.parse('file:///path/to/repo');
			assert.strictEqual(isGitHubRemoteRepository(uri), false);
		});

		test('should return false for other schemes', () => {
			const uri = URI.parse('https://github.com/microsoft/vscode');
			assert.strictEqual(isGitHubRemoteRepository(uri), false);
		});
	});

	suite('isAzureDevOpsRemoteRepository', () => {
		test('should return true for Azure DevOps remote repository URI', () => {
			const uri = URI.parse('vscode-vfs://azurerepos/org/project/repo');
			assert.strictEqual(isAzureDevOpsRemoteRepository(uri), true);
		});

		test('should return false for GitHub vscode-vfs URI', () => {
			const uri = URI.parse('vscode-vfs://github/microsoft/vscode');
			assert.strictEqual(isAzureDevOpsRemoteRepository(uri), false);
		});

		test('should return false for file URI', () => {
			const uri = URI.parse('file:///path/to/repo');
			assert.strictEqual(isAzureDevOpsRemoteRepository(uri), false);
		});

		test('should return false for other schemes', () => {
			const uri = URI.parse('https://dev.azure.com/org/project/_git/repo');
			assert.strictEqual(isAzureDevOpsRemoteRepository(uri), false);
		});
	});
});
