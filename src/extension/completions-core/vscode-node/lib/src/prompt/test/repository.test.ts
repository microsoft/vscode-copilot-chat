/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import path from 'path';
import { Context } from '../../context';
import { FileSystem } from '../../fileSystem';
import { createLibTestingContext } from '../../test/context';
import { FakeFileSystem } from '../../test/filesystem';
import { makeFsUri } from '../../util/uri';
import { ComputationStatus, extractRepoInfo, extractRepoInfoInBackground } from '../repository';

suite('Extract repo info tests', function () {
	const baseFolder = { uri: makeFsUri(path.resolve(__dirname, '../../../../../../../../')) };

	class Nested {
		nested: Nested | undefined;
	}

	test('avoid using context as cache key', function () {
		const ctx = new Context();
		ctx.set(FileSystem, new FakeFileSystem({}));
		const n = new Nested();
		ctx.set(Nested, n);
		n.nested = n;

		const maybe = extractRepoInfoInBackground(ctx, makeFsUri(__filename));

		assert.deepStrictEqual(maybe, ComputationStatus.PENDING);
	});

	test('Extract repo info', async function () {
		const ctx = createLibTestingContext();
		const info = await extractRepoInfo(ctx, baseFolder.uri);

		assert.ok(info);

		// url and pathname get their own special treatment because they depend on how the repo was cloned.
		const { url, pathname, repoId, ...repoInfo } = info;

		assert.deepStrictEqual(repoInfo, {
			baseFolder,
			hostname: 'github.com'
		});
		assert.ok(repoId);
		assert.deepStrictEqual(
			{ org: repoId.org, repo: repoId.repo, type: repoId.type },
			{ org: 'microsoft', repo: 'vscode-copilot-chat', type: 'github' }
		);
		assert.ok(
			[
				'git@github.com:microsoft/vscode-copilot-chat',
				'https://github.com/microsoft/vscode-copilot-chat',
				'https://github.com/microsoft/vscode-copilot-chat.git',
			].includes(url),
			`url is ${url}`
		);
		assert.ok(pathname.startsWith('/github/vscode-copilot-chat') || pathname.startsWith('/microsoft/vscode-copilot-chat'));

		assert.deepStrictEqual(await extractRepoInfo(ctx, 'file:///tmp/does/not/exist/.git/config'), undefined);
	});

	test('Extract repo info - Jupyter Notebook vscode-notebook-cell ', async function () {
		const cellUri = baseFolder.uri.replace(/^file:/, 'vscode-notebook-cell:');
		assert.ok(cellUri.startsWith('vscode-notebook-cell:'));
		const ctx = createLibTestingContext();
		const info = await extractRepoInfo(ctx, cellUri);

		assert.ok(info);

		// url and pathname get their own special treatment because they depend on how the repo was cloned.
		const { url, pathname, repoId, ...repoInfo } = info;

		assert.deepStrictEqual(repoInfo, {
			baseFolder,
			hostname: 'github.com'
		});
		assert.ok(repoId);
		assert.deepStrictEqual(
			{ org: repoId.org, repo: repoId.repo, type: repoId.type },
			{ org: 'microsoft', repo: 'vscode-copilot-chat', type: 'github' }
		);
		assert.ok(
			[
				'git@github.com:microsoft/vscode-copilot-chat',
				'https://github.com/microsoft/vscode-copilot-chat',
				'https://github.com/microsoft/vscode-copilot-chat.git',
			].includes(url),
			`url is ${url}`
		);
		assert.ok(pathname.startsWith('/github/vscode-copilot-chat') || pathname.startsWith('/microsoft/vscode-copilot-chat'));

		assert.deepStrictEqual(await extractRepoInfo(ctx, 'file:///tmp/does/not/exist/.git/config'), undefined);
	});
});
