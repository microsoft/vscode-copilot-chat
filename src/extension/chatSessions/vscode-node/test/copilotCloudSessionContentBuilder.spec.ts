/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IGitService } from '../../../../platform/git/common/gitService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { Event } from '../../../../util/vs/base/common/event';
import { observableValue } from '../../../../util/vs/base/common/observableInternal/observables/observableValue';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ChatSessionContentBuilder } from '../copilotCloudSessionContentBuilder';
import { IPullRequestFileChangesService } from '../pullRequestFileChangesService';

describe('ChatSessionContentBuilder - extractReferencesFromProblemStatement', () => {
	let builder: ChatSessionContentBuilder;
	const store = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	const workspaceFolderUri = URI.file('/project');

	beforeEach(() => {
		const serviceCollection = store.add(createExtensionUnitTestingServices());

		// Set up mock git service with active repository
		const mockGitService: IGitService = {
			_serviceBrand: undefined,
			activeRepository: observableValue('test-git-activeRepo', {
				rootUri: workspaceFolderUri,
				state: {
					workingTreeChanges: [],
					indexChanges: [],
					mergeChanges: [],
					HEAD: undefined
				}
			} as any),
			onDidOpenRepository: Event.None,
			onDidCloseRepository: Event.None,
			onDidFinishInitialization: Event.None,
			getRepositories: vi.fn(),
			getRepository: vi.fn(),
			openRepositoryInFolder: vi.fn(),
			commit: vi.fn(),
			fetch: vi.fn(),
			getMergeBase: vi.fn(),
			add: vi.fn(),
			dispose: vi.fn()
		};
		serviceCollection.define(IGitService, mockGitService);

		// Set up mock pull request file changes service
		const mockPrFileChangesService: IPullRequestFileChangesService = {
			getFileChangesMultiDiffPart: async () => undefined
		} as any;
		serviceCollection.define(IPullRequestFileChangesService, mockPrFileChangesService);

		accessor = serviceCollection.createTestingAccessor();
		const instaService = accessor.get(IInstantiationService);
		builder = instaService.createInstance(ChatSessionContentBuilder, 'test-type');
	});

	afterEach(() => {
		store.clear();
	});

	it('should extract file path references from problem statement', () => {
		const problemStatement = `Fix the bug in authentication

The user has attached the following file paths as relevant context:
 - src/auth/login.ts
 - src/auth/utils.ts

Please review the code and fix the issue.`;

		const result = (builder as any).extractReferencesFromProblemStatement(problemStatement);

		expect(result.prompt).toBe('Fix the bug in authentication');
		expect(result.references).toHaveLength(2);
		expect(result.references[0].value.toString()).toContain('src/auth/login.ts');
		expect(result.references[0].modelDescription).toBe('File: src/auth/login.ts');
		expect(result.references[1].value.toString()).toContain('src/auth/utils.ts');
		expect(result.references[1].modelDescription).toBe('File: src/auth/utils.ts');
	});

	it('should extract full file content references from problem statement', () => {
		const problemStatement = `Add new feature

The user has attached the following uncommitted or modified files as relevant context:
<file-start>src/feature.ts</file-start>
const feature = () => {
  console.log('feature');
};
<file-end>src/feature.ts</file-end>
<file-start>src/test.ts</file-start>
test('feature', () => {
  expect(true).toBe(true);
});
<file-end>src/test.ts</file-end>

Implement the feature.`;

		const result = (builder as any).extractReferencesFromProblemStatement(problemStatement);

		expect(result.prompt).toBe('Add new feature');
		expect(result.references).toHaveLength(2);
		expect(result.references[0].value.toString()).toContain('src/feature.ts');
		expect(result.references[0].modelDescription).toBe('File: src/feature.ts (modified)');
		expect(result.references[1].value.toString()).toContain('src/test.ts');
		expect(result.references[1].modelDescription).toBe('File: src/test.ts (modified)');
	});

	it('should extract both types of references from problem statement', () => {
		const problemStatement = `Refactor authentication system

The user has attached the following uncommitted or modified files as relevant context:
<file-start>src/auth/login.ts</file-start>
export function login() {}
<file-end>src/auth/login.ts</file-end>

The user has attached the following file paths as relevant context:
 - src/auth/types.ts
 - src/utils/validation.ts

Review and refactor.`;

		const result = (builder as any).extractReferencesFromProblemStatement(problemStatement);

		expect(result.prompt).toBe('Refactor authentication system');
		expect(result.references).toHaveLength(3);
		expect(result.references[0].value.toString()).toContain('src/auth/types.ts');
		expect(result.references[1].value.toString()).toContain('src/utils/validation.ts');
		expect(result.references[2].value.toString()).toContain('src/auth/login.ts');
	});

	it('should handle problem statement without references', () => {
		const problemStatement = 'Fix the bug in the authentication system';

		const result = (builder as any).extractReferencesFromProblemStatement(problemStatement);

		expect(result.prompt).toBe('Fix the bug in the authentication system');
		expect(result.references).toHaveLength(0);
	});

	it('should handle empty problem statement', () => {
		const problemStatement = '';

		const result = (builder as any).extractReferencesFromProblemStatement(problemStatement);

		expect(result.prompt).toBe('');
		expect(result.references).toHaveLength(0);
	});

	it('should extract title from TITLE: prefix format', () => {
		const problemStatement = `TITLE: Fix authentication bug

The user has attached the following file paths as relevant context:
 - src/auth/login.ts

Some additional context here.`;

		const result = (builder as any).extractReferencesFromProblemStatement(problemStatement);

		expect(result.prompt).toBe('Fix authentication bug');
		expect(result.references).toHaveLength(1);
		expect(result.references[0].value.toString()).toContain('src/auth/login.ts');
	});

	it('should remove @copilot mentions from prompt', () => {
		const problemStatement = '@copilot fix the authentication bug';

		const result = (builder as any).extractReferencesFromProblemStatement(problemStatement);

		expect(result.prompt).toBe('fix the authentication bug');
		expect(result.references).toHaveLength(0);
	});
});
