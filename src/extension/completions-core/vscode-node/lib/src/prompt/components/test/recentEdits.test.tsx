/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** @jsxRuntime automatic */
/** @jsxImportSource ../../../../../prompt/jsx-runtime/ */

import * as assert from 'assert';
import { MutableObservableWorkspace, ObservableWorkspace } from '../../../../../../../../platform/inlineEdits/common/observableWorkspace';
import { VirtualPrompt } from '../../../../../prompt/src/components/virtualPrompt';
import { CopilotContentExclusionManager } from '../../../contentExclusion/contentExclusionManager';
import { ICompletionsContextService } from '../../../context';
import { createCompletionRequestData } from '../../../test/completionsPrompt';
import { createLibTestingContext } from '../../../test/context';
import { querySnapshot } from '../../../test/snapshot';
import { BlockingContentExclusionManager } from '../../../test/testContentExclusion';
import { TestTextDocumentManager } from '../../../test/textDocument';
import { TextDocumentManager } from '../../../textDocumentManager';
import { CompletionRequestDocument } from '../../completionsPromptFactory/componentsCompletionsPromptFactory';
import { FullRecentEditsProvider, RecentEditsProvider } from '../../recentEdits/recentEditsProvider';
import { DiffHunk, RecentEdit, summarizeEdit } from '../../recentEdits/recentEditsReducer';
import { RecentEdits, editIsTooCloseToCursor } from '../recentEdits';

class MockRecentEditsProvider extends FullRecentEditsProvider {
	override getRecentEdits = () => [] as RecentEdit[];

	override getEditSummary(edit: RecentEdit): string | null {
		return summarizeEdit(edit, this.config);
	}
}

suite('Recent Edits Component', function () {
	let ctx: ICompletionsContextService;
	let mockRecentEditsProvider: MockRecentEditsProvider;

	setup(function () {
		ctx = createLibTestingContext();
		ctx.set(ObservableWorkspace, new MutableObservableWorkspace());
		mockRecentEditsProvider = ctx.instantiationService.createInstance(MockRecentEditsProvider, undefined);
		ctx.forceSet(RecentEditsProvider, mockRecentEditsProvider);
	});

	test('renders nothing when recent edits are disabled', async function () {
		mockRecentEditsProvider.isEnabled = () => false;

		const tdm = ctx.get(TextDocumentManager) as TestTextDocumentManager;
		const doc = tdm.setTextDocument('file:///foo.ts', 'typescript', 'const x = |;');

		const snapshot = await createSnapshot(ctx, doc, '|');
		assert.throws(() => querySnapshot(snapshot, 'RecentEdits'));
	});

	test('renders recent edits correctly', async function () {
		mockRecentEditsProvider.config.maxEdits = 5;
		mockRecentEditsProvider.config.diffContextLines = 1;
		mockRecentEditsProvider.config.activeDocDistanceLimitFromCursor = -1;
		mockRecentEditsProvider.config.summarizationFormat = 'diff';
		mockRecentEditsProvider.config.maxFiles = 5;

		const tdm = ctx.get(TextDocumentManager) as TestTextDocumentManager;
		tdm.init([{ uri: 'file:///root/' }]);
		const doc = tdm.setTextDocument(
			'file:///root/relative/main.ts',
			'typescript',
			'function hello() {\n  return "world";\n}\n|'
		);

		const fakeHunk: RecentEdit = {
			file: doc.uri,
			startLine: 2,
			endLine: 2,
			diff: {
				file: doc.uri,
				pre: 1,
				post: 3,
				oldLen: 1,
				newLen: 1,
				before: [],
				removed: ['  return "world";'],
				added: ['  return "hello";'],
				after: [],
			} as DiffHunk,
			timestamp: 1,
		};
		mockRecentEditsProvider.getRecentEdits = () => [fakeHunk];

		const snapshot = await createSnapshot(ctx, doc, '|');
		const text = querySnapshot(snapshot, 'RecentEdits.Chunk.Text') as string;

		assert.ok(text.includes('These are recently edited files. Do not suggest code that has been deleted.'));
		assert.ok(text.includes('File: relative/main.ts'));
		assert.ok(text.includes('@@ -2,1 +2,1 @@'));
		assert.ok(text.includes('-  return "world";'));
		assert.ok(text.includes('+  return "hello";'));
		assert.ok(text.includes('End of recent edits'));
	});

	test('renders recent edits correctly w/o deleted lines', async function () {
		mockRecentEditsProvider.config.maxEdits = 5;
		mockRecentEditsProvider.config.diffContextLines = 1;
		mockRecentEditsProvider.config.activeDocDistanceLimitFromCursor = -1;
		mockRecentEditsProvider.config.summarizationFormat = 'diff';
		mockRecentEditsProvider.config.maxFiles = 5;
		mockRecentEditsProvider.config.removeDeletedLines = true;

		const tdm = ctx.get(TextDocumentManager) as TestTextDocumentManager;
		tdm.init([{ uri: 'file:///root/' }]);
		const doc = tdm.setTextDocument(
			'file:///root/relative/main.ts',
			'typescript',
			'function hello() {\n  return "world";\n}\n|'
		);

		const fakeHunk: RecentEdit = {
			file: doc.uri,
			startLine: 2,
			endLine: 2,
			diff: {
				file: doc.uri,
				pre: 1,
				post: 3,
				oldLen: 0,
				newLen: 1,
				before: [],
				removed: ['  return "world";'],
				added: ['  return "hello";'],
				after: [],
			} as DiffHunk,
			timestamp: 1,
		};
		mockRecentEditsProvider.getRecentEdits = () => [fakeHunk];

		const snapshot = await createSnapshot(ctx, doc, '|');
		const text = querySnapshot(snapshot, 'RecentEdits.Chunk.Text') as string;

		assert.strictEqual(
			text,
			`These are recently edited files. Do not suggest code that has been deleted.
File: relative/main.ts
--- a/file:///root/relative/main.ts
+++ b/file:///root/relative/main.ts
@@ -2,1 +2,1 @@
+  return "hello";
End of recent edits\n`.replace(/\n {12}/g, '\n')
		);
	});

	test('limits the total number of open files from which to source edits', async function () {
		mockRecentEditsProvider.config.maxEdits = 5;
		mockRecentEditsProvider.config.activeDocDistanceLimitFromCursor = -1;
		mockRecentEditsProvider.config.summarizationFormat = 'diff';
		mockRecentEditsProvider.config.maxFiles = 2;

		const tdm = ctx.get(TextDocumentManager) as TestTextDocumentManager;
		tdm.init([{ uri: 'file:///root/' }]);

		const fileUris = ['file:///root/file-1', 'file:///root/file-2', 'file:///root/file-3'];
		for (const uri of fileUris) {
			tdm.setTextDocument(uri, 'typescript', 'dummy\n|');
		}
		const doc = tdm.setTextDocument('file:///root/relative/main.ts', 'typescript', 'dummy\n|');

		const fakeHunks: RecentEdit[] = fileUris.map((uri, idx) => ({
			file: uri,
			startLine: 1,
			endLine: 1,
			diff: {
				file: uri,
				pre: 0,
				post: 1,
				oldLen: 0,
				newLen: 1,
				before: [],
				removed: [],
				added: [`edit-${idx + 1}`],
				after: [],
			} as DiffHunk,
			timestamp: idx + 1,
		}));
		mockRecentEditsProvider.getRecentEdits = () => fakeHunks;

		const snapshot = await createSnapshot(ctx, doc, '|');
		const text = querySnapshot(snapshot, 'RecentEdits.Chunk.Text') as string;

		assert.strictEqual(
			text,
			`These are recently edited files. Do not suggest code that has been deleted.
File: file-2
--- a/file:///root/file-2
+++ b/file:///root/file-2
@@ -1,0 +1,1 @@
+edit-2
File: file-3
--- a/file:///root/file-3
+++ b/file:///root/file-3
@@ -1,0 +1,1 @@
+edit-3
End of recent edits\n`.replace(/\n {12}/g, '\n')
		);
	});

	test('ignores edits over the max line limit', async function () {
		mockRecentEditsProvider.config.diffContextLines = 1;
		mockRecentEditsProvider.config.activeDocDistanceLimitFromCursor = -1;
		mockRecentEditsProvider.config.summarizationFormat = 'diff';
		mockRecentEditsProvider.config.maxFiles = 10;
		mockRecentEditsProvider.config.removeDeletedLines = true;
		mockRecentEditsProvider.config.maxLinesPerEdit = 1;

		const tdm = ctx.get(TextDocumentManager) as TestTextDocumentManager;
		tdm.init([{ uri: 'file:///root/' }]);

		const fileUris = ['file:///root/file-1', 'file:///root/file-2', 'file:///root/file-3'];
		for (const uri of fileUris) {
			tdm.setTextDocument(uri, 'typescript', 'dummy\n|');
		}
		const doc = tdm.setTextDocument('file:///root/relative/main.ts', 'typescript', 'dummy\n|');

		const fakeHunks: RecentEdit[] = fileUris.map((uri, idx) => ({
			file: uri,
			startLine: 1,
			endLine: 1,
			diff: {
				file: uri,
				pre: 0,
				post: 1,
				oldLen: 0,
				newLen: 1,
				before: [],
				removed: [],
				added: [`edit-${idx + 1}`],
				after: [],
			} as DiffHunk,
			timestamp: idx + 1,
		}));

		fakeHunks[0].diff.added.push('a second edit that breaks the 1 line limit');
		mockRecentEditsProvider.getRecentEdits = () => fakeHunks;

		const snapshot = await createSnapshot(ctx, doc, '|');
		const text = querySnapshot(snapshot, 'RecentEdits.Chunk.Text') as string;

		assert.strictEqual(
			text,
			`These are recently edited files. Do not suggest code that has been deleted.
File: file-2
--- a/file:///root/file-2
+++ b/file:///root/file-2
@@ -1,0 +1,1 @@
+edit-2
File: file-3
--- a/file:///root/file-3
+++ b/file:///root/file-3
@@ -1,0 +1,1 @@
+edit-3
End of recent edits\n`.replace(/\n {12}/g, '\n')
		);
	});

	test('returns none if too close to the cursor', async function () {
		mockRecentEditsProvider.config.maxEdits = 5;
		mockRecentEditsProvider.config.diffContextLines = 1;
		mockRecentEditsProvider.config.activeDocDistanceLimitFromCursor = -1;
		mockRecentEditsProvider.config.summarizationFormat = 'diff';
		mockRecentEditsProvider.config.maxFiles = 5;
		mockRecentEditsProvider.config.activeDocDistanceLimitFromCursor = 3;

		const tdm = ctx.get(TextDocumentManager) as TestTextDocumentManager;
		tdm.init([{ uri: 'file:///root/' }]);
		const doc = tdm.setTextDocument(
			'file:///root/relative/main.ts',
			'typescript',
			'function hello() {\n  return "world";\n}\n|'
		);

		const fakeHunk: RecentEdit = {
			file: doc.uri,
			startLine: 2,
			endLine: 2,
			diff: {
				file: doc.uri,
				pre: 1,
				post: 3,
				oldLen: 1,
				newLen: 1,
				before: [],
				removed: ['  return "world";'],
				added: ['  return "hello";'],
				after: [],
			} as DiffHunk,
			timestamp: 1,
		};
		mockRecentEditsProvider.getRecentEdits = () => [fakeHunk];

		const snapshot = await createSnapshot(ctx, doc, '|');
		assert.throws(() => querySnapshot(snapshot, 'RecentEdits'));
	});

	test('editIsTooCloseToCursor function returns true when edit directly intersects', function () {
		const edit: RecentEdit = {
			startLine: 2,
			endLine: 2,
		} as RecentEdit;
		let filterByCursorLine = true;
		let cursorLine = 1;
		let activeDocDistanceLimitFromCursor = 1;
		const editTooClose = editIsTooCloseToCursor(
			edit,
			filterByCursorLine,
			cursorLine,
			activeDocDistanceLimitFromCursor
		);
		assert.strictEqual(editTooClose, true);

		cursorLine = 3;
		activeDocDistanceLimitFromCursor = 4;
		const editTooClose2 = editIsTooCloseToCursor(
			edit,
			filterByCursorLine,
			cursorLine,
			activeDocDistanceLimitFromCursor
		);
		assert.strictEqual(editTooClose2, true);

		filterByCursorLine = false;
		assert.strictEqual(
			editIsTooCloseToCursor(edit, filterByCursorLine, cursorLine, activeDocDistanceLimitFromCursor),
			false
		);
	});

	test('edits from content excluded documents are not included', async function () {
		mockRecentEditsProvider.config.maxEdits = 5;
		mockRecentEditsProvider.config.diffContextLines = 1;
		mockRecentEditsProvider.config.activeDocDistanceLimitFromCursor = -1;
		mockRecentEditsProvider.config.summarizationFormat = 'diff';
		mockRecentEditsProvider.config.maxFiles = 5;

		const tdm = ctx.get(TextDocumentManager) as TestTextDocumentManager;
		tdm.init([{ uri: 'file:///root/' }]);

		const doc = tdm.setTextDocument(
			'file:///root/relative/main.ts',
			'typescript',
			'function hello() {\n  return "world";\n}\n|'
		);
		const excludedDoc = tdm.setTextDocument(
			'file:///root/relative/excluded.ts',
			'typescript',
			'function excluded() {\n  return "excluded";\n}\n|'
		);

		ctx.forceSet(
			CopilotContentExclusionManager,
			ctx.instantiationService.createInstance(BlockingContentExclusionManager, ['file:///root/relative/excluded.ts'])
		);

		const fakeEdits: RecentEdit[] = [
			{
				file: doc.uri,
				startLine: 2,
				endLine: 2,
				diff: {
					file: doc.uri,
					pre: 1,
					post: 3,
					oldLen: 1,
					newLen: 1,
					before: [],
					removed: ['  return "world";'],
					added: ['  return "hello";'],
					after: [],
				} as DiffHunk,
				timestamp: 1,
			},
			{
				file: excludedDoc.uri,
				startLine: 2,
				endLine: 2,
				diff: {
					file: excludedDoc.uri,
					pre: 1,
					post: 3,
					oldLen: 1,
					newLen: 1,
					before: [],
					removed: ['  return "world";'],
					added: ['  return "hello";'],
					after: [],
				} as DiffHunk,
				timestamp: 1,
			},
		];
		mockRecentEditsProvider.getRecentEdits = () => fakeEdits;

		const snapshot = await createSnapshot(ctx, doc, '|');
		const text = querySnapshot(snapshot, 'RecentEdits.Chunk.Text') as string;

		assert.ok(text.includes('These are recently edited files. Do not suggest code that has been deleted.'));
		assert.ok(text.includes('File: relative/main.ts'));
		assert.ok(!text.includes('File: relative/excluded.ts'));
	});

	async function createSnapshot(ctx: ICompletionsContextService, doc: CompletionRequestDocument, marker: string) {
		const position = doc.positionAt(doc.getText().indexOf(marker));
		const virtualPrompt = new VirtualPrompt(<RecentEdits ctx={ctx} />);
		const pipe = virtualPrompt.createPipe();
		await pipe.pump(createCompletionRequestData(ctx, doc, position));
		return virtualPrompt.snapshot().snapshot!;
	}
});
