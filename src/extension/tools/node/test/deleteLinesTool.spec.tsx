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
import { IDeleteLinesParams } from '../deleteLinesTool';
import { toolResultToString } from './toolTestUtils';

suite('DeleteLines', () => {
	let accessor: ITestingServicesAccessor;
	const documents = new ResourceMap<IExtHostDocumentData>();

	beforeAll(() => {
		const allDocs = [
			createTextDocumentData(
				URI.file('/workspace/delete_single.ts'),
				'line 1\nline 2\nline 3\nline 4\nline 5',
				'ts',
			),
			createTextDocumentData(
				URI.file('/workspace/delete_range.ts'),
				'line 1\nline 2\nline 3\nline 4\nline 5',
				'ts',
			),
			createTextDocumentData(
				URI.file('/workspace/delete_first.ts'),
				'first\nsecond\nthird',
				'ts',
			),
			createTextDocumentData(
				URI.file('/workspace/delete_last.ts'),
				'first\nsecond\nthird',
				'ts',
			),
			createTextDocumentData(
				URI.file('/workspace/error_test.ts'),
				'line 1\nline 2\nline 3\nline 4\nline 5',
				'ts',
			),
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

	async function invoke(params: IDeleteLinesParams) {
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
			.getCopilotTool(ToolName.DeleteLines)
			?.resolveInput?.(
				params,
				{ stream } as any,
				CopilotToolMode.FullContext,
			);

		const result = await toolsService.invokeTool(
			ToolName.DeleteLines,
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

	test('deletes a single line', async () => {
		const input: IDeleteLinesParams = {
			filePath: '/workspace/delete_single.ts',
			startLine: 3,
			endLine: 3,
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/delete_single.ts": "line 1
			line 2
			line 4
			line 5",
			}
		`);
	});

	test('deletes a range of lines', async () => {
		const input: IDeleteLinesParams = {
			filePath: '/workspace/delete_range.ts',
			startLine: 2,
			endLine: 4,
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/delete_range.ts": "line 1
			line 5",
			}
		`);
	});

	test('deletes first line', async () => {
		const input: IDeleteLinesParams = {
			filePath: '/workspace/delete_first.ts',
			startLine: 1,
			endLine: 1,
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/delete_first.ts": "second
			third",
			}
		`);
	});

	test('deletes last line', async () => {
		const input: IDeleteLinesParams = {
			filePath: '/workspace/delete_last.ts',
			startLine: 3,
			endLine: 3,
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/delete_last.ts": "first
			second",
			}
		`);
	});

	test('handles file that does not exist', async () => {
		const input: IDeleteLinesParams = {
			filePath: '/workspace/nonexistent.ts',
			startLine: 1,
			endLine: 1,
		};

		await expect(invoke(input)).rejects.toThrow(/File does not exist/);
	});

	test('throws error for invalid startLine', async () => {
		const input: IDeleteLinesParams = {
			filePath: '/workspace/error_test.ts',
			startLine: 0,
			endLine: 1,
		};

		await expect(invoke(input)).rejects.toThrow(
			/startLine must be at least 1/,
		);
	});

	test('throws error when endLine is less than startLine', async () => {
		const input: IDeleteLinesParams = {
			filePath: '/workspace/error_test.ts',
			startLine: 3,
			endLine: 2,
		};

		await expect(invoke(input)).rejects.toThrow(
			/must be greater than or equal to startLine/,
		);
	});

	test('throws error for startLine out of range', async () => {
		const input: IDeleteLinesParams = {
			filePath: '/workspace/error_test.ts',
			startLine: 100,
			endLine: 100,
		};

		await expect(invoke(input)).rejects.toThrow(/out of range/);
	});

	test('returns result with file info', async () => {
		const input: IDeleteLinesParams = {
			filePath: '/workspace/single.ts',
			startLine: 1,
			endLine: 1,
		};

		const r = await invoke(input);
		const resultString = await toolResultToString(accessor, r.result);
		expect(resultString).toContain('single.ts');
	});
});
