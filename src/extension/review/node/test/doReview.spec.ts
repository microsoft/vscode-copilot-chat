/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { describe, suite, test } from 'vitest';
import type { TextEditor } from 'vscode';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { URI } from '../../../../util/vs/base/common/uri';
import { combineCancellationTokens, getReviewTitle, ReviewGroup } from '../doReview';

suite('doReview', () => {

	describe('getReviewTitle', () => {

		test('returns title for selection group with editor', () => {
			const mockEditor = {
				document: {
					uri: { path: '/project/src/file.ts' }
				}
			} as unknown as TextEditor;

			const title = getReviewTitle('selection', mockEditor);
			assert.strictEqual(title, 'Reviewing selected code in file.ts...');
		});

		test('returns title for index group', () => {
			const title = getReviewTitle('index');
			assert.strictEqual(title, 'Reviewing staged changes...');
		});

		test('returns title for workingTree group', () => {
			const title = getReviewTitle('workingTree');
			assert.strictEqual(title, 'Reviewing unstaged changes...');
		});

		test('returns title for all group', () => {
			const title = getReviewTitle('all');
			assert.strictEqual(title, 'Reviewing uncommitted changes...');
		});

		test('returns title for PR group (repositoryRoot)', () => {
			const prGroup: ReviewGroup = {
				repositoryRoot: '/project',
				commitMessages: ['Fix bug'],
				patches: [{ patch: 'diff content', fileUri: 'file:///project/file.ts' }]
			};
			const title = getReviewTitle(prGroup);
			assert.strictEqual(title, 'Reviewing changes...');
		});

		test('returns title for file group with index', () => {
			const fileGroup: ReviewGroup = {
				group: 'index',
				file: URI.file('/project/src/component.tsx')
			};
			const title = getReviewTitle(fileGroup);
			assert.strictEqual(title, 'Reviewing staged changes in component.tsx...');
		});

		test('returns title for file group with workingTree', () => {
			const fileGroup: ReviewGroup = {
				group: 'workingTree',
				file: URI.file('/project/src/utils.js')
			};
			const title = getReviewTitle(fileGroup);
			assert.strictEqual(title, 'Reviewing unstaged changes in utils.js...');
		});
	});

	describe('combineCancellationTokens', () => {

		test('returns token that is not cancelled when both inputs are not cancelled', () => {
			const source1 = new CancellationTokenSource();
			const source2 = new CancellationTokenSource();
			const combined = combineCancellationTokens(source1.token, source2.token);
			assert.strictEqual(combined.isCancellationRequested, false);
			source1.dispose();
			source2.dispose();
		});

		test('cancels combined token when first token is cancelled after creation', () => {
			const source1 = new CancellationTokenSource();
			const source2 = new CancellationTokenSource();
			const combined = combineCancellationTokens(source1.token, source2.token);
			assert.strictEqual(combined.isCancellationRequested, false);
			source1.cancel();
			assert.strictEqual(combined.isCancellationRequested, true);
			source2.dispose();
		});

		test('cancels combined token when second token is cancelled after creation', () => {
			const source1 = new CancellationTokenSource();
			const source2 = new CancellationTokenSource();
			const combined = combineCancellationTokens(source1.token, source2.token);
			assert.strictEqual(combined.isCancellationRequested, false);
			source2.cancel();
			assert.strictEqual(combined.isCancellationRequested, true);
			source1.dispose();
		});

		test('only cancels combined token once when both tokens are cancelled', () => {
			const source1 = new CancellationTokenSource();
			const source2 = new CancellationTokenSource();
			const combined = combineCancellationTokens(source1.token, source2.token);
			let cancelCount = 0;
			combined.onCancellationRequested(() => cancelCount++);

			source1.cancel();
			source2.cancel();
			// The combined token should only fire once despite both being cancelled
			assert.strictEqual(cancelCount, 1);
		});
	});
});
