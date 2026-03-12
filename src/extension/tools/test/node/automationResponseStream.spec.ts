/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, expect, it, suite, vi } from 'vitest';
import { IWorkspaceService, NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { URI } from '../../../../util/vs/base/common/uri';
import { Position, Range, TextEdit } from '../../../../vscodeTypes';
import { AutomationResponseStream, createAutomationPromptContext } from '../../node/automationResponseStream';

suite('AutomationResponseStream', () => {
	let stream: AutomationResponseStream;
	let mockWorkspaceService: IWorkspaceService;

	beforeEach(() => {
		stream = new AutomationResponseStream();
		mockWorkspaceService = new NullWorkspaceService();
	});

	it('collects text edits per URI and applies them', async () => {
		const uri = URI.file('/test/file.ts');
		const edit = TextEdit.replace(new Range(new Position(0, 0), new Position(0, 5)), 'hello');
		const applyEditSpy = vi.spyOn(mockWorkspaceService, 'applyEdit');

		stream.textEdit(uri, edit);

		await stream.applyCollectedEdits(mockWorkspaceService);

		expect(applyEditSpy).toHaveBeenCalledTimes(1);
	});

	it('collects text edits from multiple URIs', async () => {
		const uri1 = URI.file('/test/file1.ts');
		const uri2 = URI.file('/test/file2.ts');
		const edit1 = TextEdit.replace(new Range(new Position(0, 0), new Position(0, 5)), 'hello');
		const edit2 = TextEdit.replace(new Range(new Position(1, 0), new Position(1, 5)), 'world');
		const applyEditSpy = vi.spyOn(mockWorkspaceService, 'applyEdit');

		stream.textEdit(uri1, edit1);
		stream.textEdit(uri2, edit2);

		await stream.applyCollectedEdits(mockWorkspaceService);

		expect(applyEditSpy).toHaveBeenCalledTimes(1);
	});

	it('ignores isDone signals', async () => {
		const uri = URI.file('/test/file.ts');
		const edit = TextEdit.replace(new Range(new Position(0, 0), new Position(0, 5)), 'hello');
		const applyEditSpy = vi.spyOn(mockWorkspaceService, 'applyEdit');

		stream.textEdit(uri, edit);
		stream.textEdit(uri, true); // isDone signal

		await stream.applyCollectedEdits(mockWorkspaceService);

		expect(applyEditSpy).toHaveBeenCalledTimes(1);
	});

	it('handles workspace edits for file deletions', async () => {
		const uri = URI.file('/test/file.ts');
		const applyEditSpy = vi.spyOn(mockWorkspaceService, 'applyEdit');

		stream.workspaceEdit([{ oldResource: uri }]);

		await stream.applyCollectedEdits(mockWorkspaceService);

		expect(applyEditSpy).toHaveBeenCalledTimes(1);
	});

	it('silently ignores non-edit part types', async () => {
		const applyEditSpy = vi.spyOn(mockWorkspaceService, 'applyEdit');

		stream.markdown('some markdown');
		stream.progress('processing...');

		await stream.applyCollectedEdits(mockWorkspaceService);

		expect(applyEditSpy).toHaveBeenCalledTimes(1);
	});

	it('applies collected edits then calls applyEdit on workspace service', async () => {
		const uri = URI.file('/test/file.ts');
		const edit = TextEdit.replace(new Range(new Position(0, 0), new Position(0, 5)), 'replaced');
		const applyEditSpy = vi.spyOn(mockWorkspaceService, 'applyEdit');

		stream.textEdit(uri, edit);
		stream.textEdit(uri, true);

		await stream.applyCollectedEdits(mockWorkspaceService);

		expect(applyEditSpy).toHaveBeenCalledTimes(1);
		const submittedEdit = applyEditSpy.mock.calls[0][0];
		const entries = submittedEdit.entries();
		expect(entries.length).toBe(1);
		expect(entries[0][0].toString()).toBe(uri.toString());
		expect(entries[0][1][0].newText).toBe('replaced');
	});
});

suite('createAutomationPromptContext', () => {
	it('returns a context with a stream and required fields', () => {
		const { context, stream } = createAutomationPromptContext();

		expect(context.stream).toBe(stream);
		expect(context.query).toBe('');
		expect(context.history).toEqual([]);
		expect(context.chatVariables).toBeDefined();
	});
});
