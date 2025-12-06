/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterAll, beforeAll, expect, suite, test } from 'vitest';
import type { ChatResponseStream, TextEdit } from 'vscode';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { applyEdits } from '../../../../platform/test/node/simulationWorkspace';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import {
	createTextDocumentData,
	IExtHostDocumentData,
} from '../../../../util/common/test/shims/textDocument';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { ChatResponseTextEditPart, Range } from '../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode } from '../../common/toolsRegistry';
import { IToolsService } from '../../common/toolsService';
import { IInsertAtLineParams } from '../insertAtLineTool';
import { toolResultToString } from './toolTestUtils';

suite('InsertAtLine', () => {
	let accessor: ITestingServicesAccessor;
	const documents = new ResourceMap<IExtHostDocumentData>();

	beforeAll(() => {
		const allDocs = [
			createTextDocumentData(
				URI.file('/workspace/insert_before.ts'),
				'line 1\nline 2\nline 3\nline 4\nline 5',
				'ts',
			),
			createTextDocumentData(
				URI.file('/workspace/insert_after.ts'),
				'line 1\nline 2\nline 3\nline 4\nline 5',
				'ts',
			),
			createTextDocumentData(
				URI.file('/workspace/insert_beginning.ts'),
				'line 1\nline 2\nline 3\nline 4\nline 5',
				'ts',
			),
			createTextDocumentData(
				URI.file('/workspace/error_test.ts'),
				'line 1\nline 2\nline 3\nline 4\nline 5',
				'ts',
			),
			createTextDocumentData(URI.file('/workspace/empty.ts'), '', 'ts'),
			createTextDocumentData(
				URI.file('/workspace/single.ts'),
				'only line',
				'ts',
			),
		];
		for (const doc of allDocs) {
			documents.set(doc.document.uri, doc);
		}

		const services = createExtensionUnitTestingServices();
		services.define(
			IWorkspaceService,
			new SyncDescriptor(TestWorkspaceService, [
				[URI.file('/workspace')],
				allDocs.map((d) => d.document),
			]),
		);
		accessor = services.createTestingAccessor();
	});

	afterAll(() => {
		accessor.dispose();
	});

	async function invoke(params: IInsertAtLineParams) {
		const edits: Record<string, TextEdit[]> = {};
		const stream: Partial<ChatResponseStream> = {
			markdown: () => { },
			codeblockUri: () => { },
			push: (part) => {
				if (part instanceof ChatResponseTextEditPart) {
					edits[part.uri.toString()] ??= [];
					edits[part.uri.toString()].push(...part.edits);
				}
			},
			textEdit: (uri, edit) => {
				if (typeof edit !== 'boolean') {
					edits[uri.toString()] ??= [];
					edits[uri.toString()].push(
						...(Array.isArray(edit) ? edit : [edit]),
					);
				}
			},
		};
		const toolsService = accessor.get(IToolsService);
		toolsService
			.getCopilotTool(ToolName.InsertAtLine)
			?.resolveInput?.(
				params,
				{ stream } as any,
				CopilotToolMode.FullContext,
			);

		const result = await toolsService.invokeTool(
			ToolName.InsertAtLine,
			{ input: params, toolInvocationToken: null as never },
			CancellationToken.None,
		);
		return { result, edits };
	}

	async function applyEditsInMap(r: Record<string, TextEdit[]>) {
		const results: Record<string, string> = {};
		for (const [uriStr, edits] of Object.entries(r)) {
			const doc = documents.get(URI.parse(uriStr));
			if (!doc) {
				throw new Error(`No document found for ${uriStr}`);
			}

			applyEdits(
				doc,
				edits,
				new Range(0, 0, 0, 0),
				new Range(0, 0, 0, 0),
			);
			results[uriStr] = doc.document.getText();
		}
		return results;
	}

	test('inserts content before a line', async () => {
		const input: IInsertAtLineParams = {
			filePath: '/workspace/insert_before.ts',
			line: 3,
			content: 'inserted line',
			position: 'before',
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/insert_before.ts": "line 1
			line 2
			inserted line
			line 3
			line 4
			line 5",
			}
		`);
	});

	test('inserts content after a line', async () => {
		const input: IInsertAtLineParams = {
			filePath: '/workspace/insert_after.ts',
			line: 2,
			content: 'inserted after line 2',
			position: 'after',
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/insert_after.ts": "line 1
			line 2
			inserted after line 2
			line 3
			line 4
			line 5",
			}
		`);
	});

	test('inserts at beginning of file (line 1, before)', async () => {
		const input: IInsertAtLineParams = {
			filePath: '/workspace/insert_beginning.ts',
			line: 1,
			content: '// Copyright header',
			position: 'before',
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/insert_beginning.ts": "// Copyright header
			line 1
			line 2
			line 3
			line 4
			line 5",
			}
		`);
	});

	test('handles file that does not exist', async () => {
		const input: IInsertAtLineParams = {
			filePath: '/workspace/nonexistent.ts',
			line: 1,
			content: 'some content',
		};

		await expect(invoke(input)).rejects.toThrow(/File does not exist/);
	});

	test('throws error for invalid line number', async () => {
		const input: IInsertAtLineParams = {
			filePath: '/workspace/error_test.ts',
			line: 0,
			content: 'content',
		};

		await expect(invoke(input)).rejects.toThrow(
			/Line number must be at least 1/,
		);
	});

	test('throws error for line number out of range', async () => {
		const input: IInsertAtLineParams = {
			filePath: '/workspace/error_test.ts',
			line: 100,
			content: 'content',
		};

		await expect(invoke(input)).rejects.toThrow(/out of range/);
	});

	test('returns result with file info', async () => {
		const input: IInsertAtLineParams = {
			filePath: '/workspace/single.ts',
			line: 1,
			content: 'new first line',
			position: 'before',
		};

		const r = await invoke(input);
		const resultString = await toolResultToString(accessor, r.result);
		expect(resultString).toContain('single.ts');
	});
});
