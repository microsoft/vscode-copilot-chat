/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { GitCommitMessageGenerator } from '../../src/extension/prompt/node/gitCommitMessageGenerator';
import { ConfigKey } from '../../src/platform/configuration/common/configurationService';
import { Diff } from '../../src/platform/git/common/gitDiffService';
import { TestWorkspaceService } from '../../src/platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../src/platform/workspace/common/workspaceService';
import { ExtHostDocumentData } from '../../src/util/common/test/shims/textDocument';
import { CancellationToken } from '../../src/util/vs/base/common/cancellation';
import { URI } from '../../src/util/vs/base/common/uri';
import { IInstantiationService } from '../../src/util/vs/platform/instantiation/common/instantiation';
import { ssuite, stest } from '../base/stest';

ssuite({ title: 'git commit message', location: 'external' }, () => {
	stest({ description: 'Generates a simple commit message', language: 'python' }, async (testingServiceCollection) => {
		const content = `
def print_hello_world():
        print("Hello, World!")`;

		const document = ExtHostDocumentData.create(URI.file('main.py'), content, 'python').document;
		testingServiceCollection.define(IWorkspaceService, new TestWorkspaceService(undefined, [document]));

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);

		const diff = `diff --git a/main.py b/main.py
index 0877b83..6260896 100644
--- a/main.py
+++ b/main.py
@@ -1,2 +1,2 @@
-def print_hello_world():
+def greet():
		print("Hello, World!")
\ No newline at end of file`;

		const changes: Diff[] = [
			{
				uri: document.uri,
				originalUri: document.uri,
				renameUri: undefined,
				status: 5 /* Modified */,
				diff
			} satisfies Diff
		];

		const generator = instantiationService.createInstance(GitCommitMessageGenerator);
		const message = await generator.generateGitCommitMessage(changes, { repository: [], user: [] }, {}, 0, CancellationToken.None);
		assert.ok(message !== undefined, 'Failed to generate a commit message');
	});

	stest({ description: 'Generates a conventional commit message for a bug fix', language: 'python' }, async (testingServiceCollection) => {
		const content = `
def print_hello_world():
        print("Hello, World!")`;

		const document = ExtHostDocumentData.create(URI.file('main.py'), content, 'python').document;
		testingServiceCollection.define(IWorkspaceService, new TestWorkspaceService(undefined, [document]));

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);

		const diff = `diff --git a/main.py b/main.py
index 0877b83..6260896 100644
--- a/main.py
+++ b/main.py
@@ -1,2 +1,2 @@
-def print_hello_world():
+def greet():
		print("Hello, World!")
\ No newline at end of file`;

		const repoCommits = [
			'feat: add greet function (by person@example.com)',
			'chore: setup initial project [fixes #3425]'
		];
		const userCommits = [
			'refactor: move logic into main.py',
			'feat: add hello world'
		];

		const changes: Diff[] = [
			{
				uri: document.uri,
				originalUri: document.uri,
				renameUri: undefined,
				status: 5 /* Modified */,
				diff
			} satisfies Diff
		];

		const branchName: string = "abc-perform-refactorings";

		const generator = instantiationService.createInstance(GitCommitMessageGenerator);
		const message = await generator.generateGitCommitMessage(changes, { repository: repoCommits, user: userCommits }, { headBranchName: branchName }, 0, CancellationToken.None);

		assert.ok(message !== undefined, 'Failed to generate a commit message');
		assert.ok(!userCommits.some(commit => message.toLowerCase().includes(commit)), 'Commit message contains a user commit');
		assert.ok(!repoCommits.some(commit => message.toLowerCase().includes(commit)), 'Commit message contains a repo commit');
		assert.ok(['fix:', 'chore:', 'feat:', 'refactor:'].some(prefix => message.toLowerCase().startsWith(prefix)), 'Commit message does not follow the conventional commits format');
		assert.ok(!message.includes(branchName), 'Commit message does not contain branch name');
		assert.ok(!message.includes('example.com'), 'Commit message contains the email address');
		assert.ok(!/#\d+/.test(message), 'Commit message does include an issue reference');

	});

	stest({ description: 'Generated commit messages do not bias to conventional commit style', language: 'python' }, async (testingServiceCollection) => {
		const content = `
def show_exomple():
        print("This is an example.")`;

		const document = ExtHostDocumentData.create(URI.file('main.py'), content, 'python').document;
		testingServiceCollection.define(IWorkspaceService, new TestWorkspaceService(undefined, [document]));

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);

		const diff = `diff --git a/sample.py b/sample.py
index 0877b83..6260896 100644
--- a/sample.py
+++ b/sample.py
@@ -1,3 +1,3 @@
-def show_exomple():
+def show_example():
    print("This is an example.")
\ No newline at end of file`;

		const repoCommits = [
			'Initial project setup',
			'Install dependencies'
		];

		const userCommits = [
			'Add sample'
		];

		const changes: Diff[] = [
			{
				uri: document.uri,
				originalUri: document.uri,
				renameUri: undefined,
				status: 5 /* Modified */,
				diff
			} satisfies Diff
		];

		const generator = instantiationService.createInstance(GitCommitMessageGenerator);
		const message = await generator.generateGitCommitMessage(changes, { repository: repoCommits, user: userCommits }, {}, 0, CancellationToken.None);

		assert.ok(message !== undefined, 'Failed to generate a commit message');
		assert.ok(!userCommits.some(commit => message.toLowerCase().includes(commit)), 'Commit message contains a user commit');
		assert.ok(!repoCommits.some(commit => message.toLowerCase().includes(commit)), 'Commit message contains a repo commit');
		assert.ok(!['fix:', 'feat:', 'chore:', 'docs:', 'style:', 'refactor:'].some(prefix => message.toLowerCase().startsWith(prefix)), 'Commit message should not use conventional commits format');
	});


	const commitMessageConfig = [
		{
			key: ConfigKey.CommitMessageGenerationInstructions,
			value: [
				{ "text": "In this repository, we use conventional commits. The branch name usually encodes the feature currently being worked on. Use the feature name as the conventional commit scope. If the branch is called 'XYZ-1000-setup-project' the commit should start with 'feat(setup):' where the scope 'setup' references the current feature. Keep the scope to one word only." },
				{ "text": "Every commit must reference a ticket number in the very last line with one empty line before. Extract the ticket number from the branch name. Usually, it will be 'XYZ-' followed by a number. If the branch is called 'XYZ-1000-setup-project' the ticket number is 'XYZ-1000'." }
			]
		}
	];

	stest({ description: 'Uses repository context along with custom instructions', configurations: commitMessageConfig, language: 'python' }, async (testingServiceCollection) => {
		const content = `
def show_exomple():
        print("This is an example.")`;

		const document = ExtHostDocumentData.create(URI.file('main.py'), content, 'python').document;
		testingServiceCollection.define(IWorkspaceService, new TestWorkspaceService(undefined, [document]));

		const accessor = testingServiceCollection.createTestingAccessor();
		const instantiationService = accessor.get(IInstantiationService);

		const diff = `diff --git a/sample.py b/sample.py
index 0877b83..6260896 100644
--- a/sample.py
+++ b/sample.py
@@ -1,3 +1,3 @@
-def show_exomple():
+def show_example():
    print("This is an example.")
\ No newline at end of file`;

		const repoCommits = [
			'feat(setup): Initial project setup\n\nXYZ-1000',
			'feat(setup): Install dependencies\n\nXYZ-1000'
		];

		const userCommits = [
			'Add sample'
		];

		const changes: Diff[] = [
			{
				uri: document.uri,
				originalUri: document.uri,
				renameUri: undefined,
				status: 5 /* Modified */,
				diff
			} satisfies Diff
		];

		const headBranchName = "XYZ-1234-implement-login";

		const generator = instantiationService.createInstance(GitCommitMessageGenerator);
		const message = await generator.generateGitCommitMessage(changes, { repository: repoCommits, user: userCommits }, { headBranchName }, 0, CancellationToken.None);

		assert.ok(message !== undefined, 'Failed to generate a commit message');
		assert.ok(message.startsWith('feat(login):'), 'Failed to extract feature from branch name');
		assert.ok(message.includes('XYZ-1234'), 'Failed to extract ticket number from branch name');
	});
});
