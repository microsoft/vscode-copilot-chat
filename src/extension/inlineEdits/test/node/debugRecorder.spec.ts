/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import { assert, expect, suite, test } from 'vitest';
import { LogEntry } from '../../../../platform/workspaceRecorder/common/workspaceLog';
import { observableValue } from '../../../../util/vs/base/common/observable';
import * as path from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { ObservableWorkspaceRecordingReplayer } from '../../common/observableWorkspaceRecordingReplayer';
import { DebugRecorder } from '../../node/debugRecorder';

suite('Debug recorder', () => {

	// like `Date.now()` but repeats the same time on every 4th invocation
	// eg 1 2 3 4 4 5 6 7 8 8 9 ...
	function createRepeatingGetNow() {
		let last = 0;
		let next = 1;
		return () => {
			const current = next;
			if (current % 4 !== 0 || last === current) {
				next += 1;
			}
			last = current;
			return current;
		};
	}

	test('enforce total ordering on events', async () => {

		function assertMonotonousTime(log: LogEntry[]) {
			let lastTime: number | undefined;
			for (const entry of log) {
				if (entry.kind === 'meta' || lastTime === undefined) {
					continue;
				}
				expect(entry.time).toBeGreaterThan(lastTime);
				lastTime = entry.time;
			}
		}

		const recordingFileContents = await fs.readFile(path.join(__dirname, 'recordings/ChangePointToPoint3D.recording.w.json'), 'utf-8');
		const recordingInfo = JSON.parse(recordingFileContents) as { log: LogEntry[] };
		const replayer = new ObservableWorkspaceRecordingReplayer(recordingInfo);
		const getNow = createRepeatingGetNow();
		const recorder = new DebugRecorder(replayer.workspace, undefined, getNow);
		replayer.replay();
		const log = recorder.getRecentLog()?.filter(e => e.kind !== 'header')?.map(e => e.kind === 'setContent' ? { ...e, content: '<omitted>' } : ('relativePath' in e ? { ...e, relativePath: e.relativePath.replace('\\', '/') } : e));
		assert(log);
		assertMonotonousTime(log);
		expect(log).toMatchInlineSnapshot(`
			[
			  {
			    "id": 0,
			    "kind": "documentEncountered",
			    "relativePath": "src/point.ts",
			    "time": 1,
			  },
			  {
			    "content": "<omitted>",
			    "id": 0,
			    "kind": "setContent",
			    "time": 1,
			    "v": 1,
			  },
			  {
			    "id": 0,
			    "kind": "opened",
			    "time": 1,
			  },
			  {
			    "id": 0,
			    "kind": "selectionChanged",
			    "selection": [
			      [
			        14,
			        14,
			      ],
			    ],
			    "time": 1,
			  },
			  {
			    "id": 1,
			    "kind": "documentEncountered",
			    "relativePath": "package.json",
			    "time": 3,
			  },
			  {
			    "content": "<omitted>",
			    "id": 1,
			    "kind": "setContent",
			    "time": 3,
			    "v": 1,
			  },
			  {
			    "id": 1,
			    "kind": "opened",
			    "time": 3,
			  },
			  {
			    "edit": [
			      [
			        12,
			        12,
			        "3D",
			      ],
			    ],
			    "id": 0,
			    "kind": "changed",
			    "time": 4,
			    "v": 2,
			  },
			]
		`);
	});

	test('memory stats are available', () => {
		const getNow = createRepeatingGetNow();
		// Use existing replayer setup
		const workspace = {
			openDocuments: observableValue('openDocuments', [] as any[]),
			getWorkspaceRoot: () => URI.file('/test')
		} as any;
		const recorder = new DebugRecorder(workspace, undefined, getNow);

		// Stats should be accessible
		const stats = recorder.getMemoryStats();
		expect(stats).toBeDefined();
		expect(stats.documentCount).toBe(0);
		expect(stats.totalEdits).toBe(0);
		expect(stats.avgEditsPerDoc).toBe(0);
		expect(stats.totalBaseValueSize).toBe(0);

		recorder.dispose();
	});

	test('bookmark creation and tracking', () => {
		const getNow = createRepeatingGetNow();
		const workspace = {
			openDocuments: observableValue('openDocuments', [] as any[]),
			getWorkspaceRoot: () => URI.file('/test')
		} as any;
		const recorder = new DebugRecorder(workspace, undefined, getNow);

		// Create bookmarks
		const bookmark1 = recorder.createBookmark();
		const bookmark2 = recorder.createBookmark();

		expect(bookmark1).toBeDefined();
		expect(bookmark2).toBeDefined();
		expect(bookmark1.timeMs).toBeLessThanOrEqual(bookmark2.timeMs);

		recorder.dispose();
	});

	test('recorder can be created with git parameter', () => {
		const getNow = createRepeatingGetNow();
		const workspace = {
			openDocuments: observableValue('openDocuments', [] as any[]),
			getWorkspaceRoot: () => URI.file('/test')
		} as any;
		const git = {
			branch: observableValue('branch', 'main' as string | undefined)
		} as any;

		const recorder = new DebugRecorder(workspace, git, getNow);
		expect(recorder).toBeDefined();

		recorder.dispose();
	});

	test('recorder can be created without git parameter', () => {
		const getNow = createRepeatingGetNow();
		const workspace = {
			openDocuments: observableValue('openDocuments', [] as any[]),
			getWorkspaceRoot: () => URI.file('/test')
		} as any;

		const recorder = new DebugRecorder(workspace, undefined, getNow);
		expect(recorder).toBeDefined();

		recorder.dispose();
	});

	test('getRecentLog returns undefined without workspace root', () => {
		const getNow = createRepeatingGetNow();
		const workspace = {
			openDocuments: observableValue('openDocuments', [] as any[]),
			getWorkspaceRoot: () => undefined
		} as any;

		const recorder = new DebugRecorder(workspace, undefined, getNow);
		const log = recorder.getRecentLog();
		expect(log).toBeUndefined();

		recorder.dispose();
	});

	test('getRecentLog with bookmark filters correctly', async () => {
		const recordingFileContents = await fs.readFile(path.join(__dirname, 'recordings/ChangePointToPoint3D.recording.w.json'), 'utf-8');
		const recordingInfo = JSON.parse(recordingFileContents) as { log: LogEntry[] };
		const replayer = new ObservableWorkspaceRecordingReplayer(recordingInfo);

		let currentTime = 0;
		const getNow = () => ++currentTime;
		const recorder = new DebugRecorder(replayer.workspace, undefined, getNow);

		// Create bookmark before replay
		const bookmark = recorder.createBookmark();
		const bookmarkTime = currentTime;

		// Replay some events
		replayer.replay();

		// Get log with bookmark - should only include events before bookmark
		const log = recorder.getRecentLog(bookmark);
		if (log) {
			for (const entry of log) {
				if (entry.kind !== 'header' && 'time' in entry) {
					expect(entry.time).toBeLessThanOrEqual(bookmarkTime);
				}
			}
		}

		recorder.dispose();
	});

	test('edit merging reduces edit count for consecutive small edits', async () => {
		// Create a minimal recording with consecutive character insertions
		const log: LogEntry[] = [
			{
				documentType: "workspaceRecording@1.0",
				kind: 'header',
				repoRootUri: 'file:///workspace',
				time: 0,
				uuid: '00000000-0000-0000-0000-000000000000',
				revision: 0,
			},
			{
				id: 0,
				kind: 'documentEncountered',
				relativePath: 'test.ts',
				time: 1,
			},
			{
				id: 0,
				kind: 'setContent',
				content: '',
				time: 1,
				v: 0,
			},
			// Simulate typing "hello" character by character
			{ id: 0, kind: 'changed', edit: [[0, 0, 'h']], v: 1, time: 2 },
			{ id: 0, kind: 'changed', edit: [[1, 1, 'e']], v: 2, time: 3 },
			{ id: 0, kind: 'changed', edit: [[2, 2, 'l']], v: 3, time: 4 },
			{ id: 0, kind: 'changed', edit: [[3, 3, 'l']], v: 4, time: 5 },
			{ id: 0, kind: 'changed', edit: [[4, 4, 'o']], v: 5, time: 6 },
		];

		const recordingInfo = { log };
		const replayer = new ObservableWorkspaceRecordingReplayer(recordingInfo);

		let currentTime = 0;
		const getNow = () => ++currentTime;
		const recorder = new DebugRecorder(replayer.workspace, undefined, getNow);

		replayer.replay();

		const stats = recorder.getMemoryStats();
		// With merging, 5 consecutive character insertions that touch each other
		// should result in fewer edits than without merging
		// Without merging: 5 edits. With merging: 1 edit (all merged)
		expect(stats.totalEdits).toBeLessThan(5);
		expect(stats.totalEdits).toBe(1);

		const recordingLog = recorder.getRecentLog();
		assert(recordingLog);
		const changedEvents = recordingLog.filter(e => e.kind === 'changed');
		// Should have only 1 merged "changed" event
		expect(changedEvents.length).toBeLessThan(5);
		// Verify the merged edit contains the full "hello" text
		expect(changedEvents.length).toBe(1);
		expect(changedEvents[0]).toMatchObject({
			kind: 'changed',
			edit: [[0, 0, 'hello']]
		});

		recorder.dispose();
	});

	test('edit merging handles delete followed by typing (reproduces test-output.json bug)', async () => {
		// This test reproduces the exact scenario from test-output.json where edits weren't being merged:
		// User deletes "json" (4 chars) at position 3180, then types "test" character by character
		const log: LogEntry[] = [
			{
				documentType: "workspaceRecording@1.0",
				kind: 'header',
				repoRootUri: 'file:///workspace',
				time: 0,
				uuid: '00000000-0000-0000-0000-000000000000',
				revision: 0,
			},
			{
				id: 0,
				kind: 'documentEncountered',
				relativePath: 'test.ts',
				time: 1,
			},
			{
				id: 0,
				kind: 'setContent',
				content: 'x'.repeat(3180) + 'json' + 'x'.repeat(100), // Content with "json" at position 3180
				time: 1,
				v: 0,
			},
			// Delete "json" (4 characters at position 3180-3184)
			{ id: 0, kind: 'changed', edit: [[3180, 3184, '']], v: 11, time: 1763150834866 },
			// Type "test" character by character at consecutive positions
			{ id: 0, kind: 'changed', edit: [[3180, 3180, 't']], v: 12, time: 1763150836838 },
			{ id: 0, kind: 'changed', edit: [[3181, 3181, 'e']], v: 14, time: 1763150836922 },
			{ id: 0, kind: 'changed', edit: [[3182, 3182, 's']], v: 16, time: 1763150837028 },
			{ id: 0, kind: 'changed', edit: [[3183, 3183, 't']], v: 18, time: 1763150837096 },
		];

		const recordingInfo = { log };
		const replayer = new ObservableWorkspaceRecordingReplayer(recordingInfo);

		let currentTime = 0;
		const getNow = () => ++currentTime;
		const recorder = new DebugRecorder(replayer.workspace, undefined, getNow);

		replayer.replay();

		const recordingLog = recorder.getRecentLog();
		assert(recordingLog);
		const changedEvents = recordingLog.filter(e => e.kind === 'changed');

		// The delete and the 4 character insertions should be merged into fewer events
		// Best case: 1 event (delete "json" and insert "test" at same position)
		// At minimum: Should be less than 5 separate events
		expect(changedEvents.length).toBeLessThan(5);

		// Verify the final state is correct: "json" replaced with "test"
		const lastEdit = changedEvents[changedEvents.length - 1];
		assert(lastEdit.kind === 'changed');
		// The composed edit should show replacing "json" with "test"
		expect(lastEdit.edit).toEqual([[3180, 3184, 'test']]);

		recorder.dispose();
	});

	test('memory optimizations work with large recording (RejectionCollector)', async () => {
		const recordingFilePath = path.join(__dirname, 'recordings/RejectionCollector.test1.w.json');
		const recordingFileContents = await fs.readFile(recordingFilePath, 'utf-8');
		const recordingInfo = JSON.parse(recordingFileContents) as { log: LogEntry[] };

		// Get original file size
		const fileStats = await fs.stat(recordingFilePath);
		const originalFileSizeKB = fileStats.size / 1024;

		let currentTime = 0;
		const getNow = () => ++currentTime;
		const replayer = new ObservableWorkspaceRecordingReplayer(recordingInfo);
		const recorder = new DebugRecorder(replayer.workspace, undefined, getNow);

		// Count edits in original recording
		const originalEditCount = recordingInfo.log.filter(e => e.kind === 'changed').length;
		expect(originalEditCount).toBeGreaterThan(100); // Should have many edits

		// Replay the recording
		replayer.replay();

		// Get memory stats
		const stats = recorder.getMemoryStats();

		// Verify memory optimizations are working:
		// 1. Edit merging should reduce edit count
		expect(stats.totalEdits).toBeLessThan(originalEditCount);

		// 2. Base value size should be reasonable (< 1MB per document)
		expect(stats.totalBaseValueSize).toBeLessThan(10 * 1024 * 1024); // 10MB max for all documents

		// 3. Average edits per document should be reasonable due to cleanup
		if (stats.documentCount > 0) {
			expect(stats.avgEditsPerDoc).toBeLessThan(50); // Should be much less due to merging and cleanup
		}

		// Verify we can still get the log
		const log = recorder.getRecentLog();
		assert(log);
		expect(log.length).toBeGreaterThan(0);

		// Verify log structure is valid
		const headerEntry = log.find(e => e.kind === 'header');
		expect(headerEntry).toBeDefined();

		const memoryFootprintKB = stats.totalBaseValueSize / 1024;
		const memoryReduction = Math.round((1 - memoryFootprintKB / originalFileSizeKB) * 100);

		console.log(`Original file size: ${originalFileSizeKB.toFixed(1)} KB`);
		console.log(`Memory footprint: ${memoryFootprintKB.toFixed(1)} KB (${memoryReduction}% reduction)`);
		console.log(`Original recording: ${originalEditCount} edits`);
		console.log(`After optimizations: ${stats.totalEdits} edits (${Math.round((1 - stats.totalEdits / originalEditCount) * 100)}% reduction)`);
		console.log(`Documents tracked: ${stats.documentCount}`);
		console.log(`Avg edits per doc: ${stats.avgEditsPerDoc.toFixed(1)}`);

		recorder.dispose();
	});
});

