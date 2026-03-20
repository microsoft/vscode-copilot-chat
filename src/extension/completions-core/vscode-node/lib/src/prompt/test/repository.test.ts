/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { createLibTestingContext } from '../../test/context';
import { makeFsUri } from '../../util/uri';
import { extractRepoInfo } from '../repository';
import { IInstantiationService } from '../../../../../../../util/vs/platform/instantiation/common/instantiation';

function findGitRoot(startDir: string): string {
	let dir = startDir;
	while (!fs.existsSync(path.join(dir, '.git'))) {
		const parent = path.dirname(dir);
		if (parent === dir) {
			throw new Error('Could not find git root');
		}
		dir = parent;
	}
	return dir;
}

suite('Extract repo info tests', function () {
	const baseFolder = { uri: makeFsUri(findGitRoot(__dirname)) };

	test('Extract repo info', async function () {
		const accessor = createLibTestingContext().createTestingAccessor();
		const info = await extractRepoInfo(accessor, baseFolder.uri);

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

		assert.deepStrictEqual(await extractRepoInfo(accessor, 'file:///tmp/does/not/exist/.git/config'), undefined);
	});

	test('Extract repo info - Jupyter Notebook vscode-notebook-cell ', async function () {
		const cellUri = baseFolder.uri.replace(/^file:/, 'vscode-notebook-cell:');
		assert.ok(cellUri.startsWith('vscode-notebook-cell:'));
		const accessor = createLibTestingContext().createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);
		const info = await extractRepoInfo(accessor, cellUri);

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

		assert.deepStrictEqual(await instantiationService.invokeFunction(extractRepoInfo, 'file:///tmp/does/not/exist/.git/config'), undefined);
	});
});
