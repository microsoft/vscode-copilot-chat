/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';
import { RelativePattern } from '../../../../platform/filesystem/common/fileTypes';
import { IRemoteRepositoriesService } from '../../../../platform/remoteRepositories/vscode/remoteRepositories';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { ExtensionTextDocumentManager } from '../../../../platform/workspace/vscode/workspaceServiceImpl';
import { inputGlobToPattern } from '../../node/toolUtils';

suite('inputGlobToPattern - integration', () => {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	let service: ExtensionTextDocumentManager;

	suiteSetup(() => {
		service = new ExtensionTextDocumentManager(
			new TestLogService(),
			{ _serviceBrand: undefined, loadWorkspaceContents: () => Promise.resolve(false) } satisfies IRemoteRepositoriesService,
		);
	});

	// These tests require a workspace to be open. They will be skipped
	// when run without a workspace (e.g. in CI with --profile-temp).

	test('absolute path to workspace folder root produces ** pattern', function () {
		if (!workspaceFolders?.length) {
			return this.skip();
		}

		const folder = workspaceFolders[0];
		const result = inputGlobToPattern(folder.uri.fsPath, service, undefined);

		assert.strictEqual(result.patterns.length, 1);
		const pattern = result.patterns[0] as RelativePattern;
		assert.strictEqual(pattern.pattern, '**');
		assert.strictEqual(result.folderName, folder.name);
	});

	test('absolute path to subfolder within workspace', function () {
		if (!workspaceFolders?.length) {
			return this.skip();
		}

		const folder = workspaceFolders[0];
		const subPath = `${folder.uri.fsPath}/src`;
		const result = inputGlobToPattern(subPath, service, undefined);

		assert.strictEqual(result.patterns.length, 1);
		const pattern = result.patterns[0] as RelativePattern;
		assert.strictEqual(pattern.pattern, 'src');
		assert.strictEqual(result.folderName, folder.name);
	});

	test('absolute path with glob pattern within workspace', function () {
		if (!workspaceFolders?.length) {
			return this.skip();
		}

		const folder = workspaceFolders[0];
		const globPath = `${folder.uri.fsPath}/src/**/*.ts`;
		const result = inputGlobToPattern(globPath, service, undefined);

		assert.strictEqual(result.patterns.length, 1);
		const pattern = result.patterns[0] as RelativePattern;
		assert.strictEqual(pattern.pattern, 'src/**/*.ts');
		assert.strictEqual(result.folderName, folder.name);
	});

	test('absolute path outside workspace is not rewritten', function () {
		if (!workspaceFolders?.length) {
			return this.skip();
		}

		const result = inputGlobToPattern('/tmp/nonexistent/path', service, undefined);

		assert.strictEqual(result.patterns.length, 1);
		assert.strictEqual(result.patterns[0], '/tmp/nonexistent/path');
		assert.strictEqual(result.folderName, undefined);
	});
});
