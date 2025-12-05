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
import { createTextDocumentData, IExtHostDocumentData } from '../../../../util/common/test/shims/textDocument';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { ResourceMap } from '../../../../util/vs/base/common/map';
import { URI } from '../../../../util/vs/base/common/uri';
import { SyncDescriptor } from '../../../../util/vs/platform/instantiation/common/descriptors';
import { ChatResponseTextEditPart, Range } from '../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { ToolName } from '../../common/toolNames';
import { CopilotToolMode } from '../../common/toolsRegistry';
import { IToolsService } from '../../common/toolsService';
import { IReplaceFileContentsParams } from '../replaceFileContentsTool';
import { toolResultToString } from './toolTestUtils';

suite('ReplaceFileContents', () => {
	let accessor: ITestingServicesAccessor;
	const documents = new ResourceMap<IExtHostDocumentData>();

	beforeAll(() => {
		const allDocs = [
			createTextDocumentData(URI.file('/workspace/file.ts'), 'line 1\nline 2\n\nline 4\nline 5', 'ts'),
			createTextDocumentData(URI.file('/workspace/empty.ts'), '', 'ts'),
			createTextDocumentData(URI.file('/workspace/large.ts'), 'function foo() {\n  return 1;\n}\n\nfunction bar() {\n  return 2;\n}', 'ts'),
		];
		for (const doc of allDocs) {
			documents.set(doc.document.uri, doc);
		}

		const services = createExtensionUnitTestingServices();
		services.define(IWorkspaceService, new SyncDescriptor(
			TestWorkspaceService,
			[
				[URI.file('/workspace')],
				allDocs.map(d => d.document),
			]
		));
		accessor = services.createTestingAccessor();
	});

	afterAll(() => {
		accessor.dispose();
	});

	async function invoke(params: IReplaceFileContentsParams) {
		const edits: Record<string, TextEdit[]> = {};
		const stream: Partial<ChatResponseStream> = {
			markdown: () => { },
			codeblockUri: () => { },
			push: part => {
				if (part instanceof ChatResponseTextEditPart) {
					edits[part.uri.toString()] ??= [];
					edits[part.uri.toString()].push(...part.edits);
				}
			},
			textEdit: (uri, edit) => {
				if (typeof edit !== 'boolean') {
					edits[uri.toString()] ??= [];
					edits[uri.toString()].push(...(Array.isArray(edit) ? edit : [edit]));
				}
			}
		};
		const toolsService = accessor.get(IToolsService);
		toolsService.getCopilotTool(ToolName.ReplaceFileContents)?.resolveInput?.(params, { stream } as any, CopilotToolMode.FullContext);

		const result = await toolsService.invokeTool(ToolName.ReplaceFileContents, { input: params, toolInvocationToken: null as never }, CancellationToken.None);
		return { result, edits };
	}

	async function applyEditsInMap(r: Record<string, TextEdit[]>) {
		const results: Record<string, string> = {};
		for (const [uriStr, edits] of Object.entries(r)) {
			const doc = documents.get(URI.parse(uriStr));
			if (!doc) {
				throw new Error(`No document found for ${uriStr}`);
			}

			applyEdits(doc, edits, new Range(0, 0, 0, 0), new Range(0, 0, 0, 0));
			results[uriStr] = doc.document.getText();
		}
		return results;
	}

	test('replaces entire file contents', async () => {
		const input: IReplaceFileContentsParams = {
			filePath: '/workspace/file.ts',
			newContent: 'completely new content\nwith multiple lines',
			explanation: 'Replace entire file with new content',
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/file.ts": "completely new content
			with multiple lines",
			}
		`);
	});

	test('replaces file with new content structure', async () => {
		const input: IReplaceFileContentsParams = {
			filePath: '/workspace/large.ts',
			newContent: '// Converted to arrow functions\nconst foo = () => 1;\nconst bar = () => 2;',
			explanation: 'Convert functions to arrow syntax',
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/large.ts": "// Converted to arrow functions
			const foo = () => 1;
			const bar = () => 2;",
			}
		`);
	});

	test('handles file that does not exist', async () => {
		const input: IReplaceFileContentsParams = {
			filePath: '/workspace/nonexistent.ts',
			newContent: 'some content',
			explanation: 'Try to replace non-existent file',
		};

		await expect(invoke(input)).rejects.toThrow(/File does not exist/);
	});

	test('returns result with file info', async () => {
		const input: IReplaceFileContentsParams = {
			filePath: '/workspace/empty.ts',
			newContent: 'new content for empty file',
			explanation: 'Add content to empty file',
		};

		const r = await invoke(input);
		const resultString = await toolResultToString(accessor, r.result);
		expect(resultString).toContain('empty.ts');
	});
});
