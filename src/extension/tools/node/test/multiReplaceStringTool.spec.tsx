/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
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
import { IMultiReplaceStringToolParams } from '../multiReplaceStringTool';

suite('MultiReplaceString', () => {
	let accessor: ITestingServicesAccessor;
	const documents = new ResourceMap<IExtHostDocumentData>();

	beforeAll(() => {
		// Create a large document for testing truncation (3000 lines to exceed MAX_LINES_PER_READ)
		const largeContent = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
		const allDocs = [
			createTextDocumentData(URI.file('/workspace/file.ts'), 'line 1\nline 2\n\nline 4\nline 5', 'ts'),
			createTextDocumentData(URI.file('/workspace/empty.ts'), '', 'ts'),
			createTextDocumentData(URI.file('/workspace/whitespace.ts'), ' \t\n', 'ts'),
			createTextDocumentData(URI.file('/workspace/large.ts'), largeContent, 'ts'),
			createTextDocumentData(URI.file('/workspace/multi-sr-bug.ts'), readFileSync(__dirname + '/editFileToolUtilsFixtures/multi-sr-bug-original.txt', 'utf-8'), 'ts')
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


	async function invoke(params: IMultiReplaceStringToolParams) {
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
		toolsService.getCopilotTool(ToolName.MultiReplaceString)?.resolveInput?.(params, { stream } as any, CopilotToolMode.FullContext);

		const result = await toolsService.invokeTool(ToolName.MultiReplaceString, { input: params, toolInvocationToken: null as never }, CancellationToken.None);
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

	test('replaces a simple string', async () => {
		const input: IMultiReplaceStringToolParams = {
			explanation: 'Replace line 2 with "new line 2"',
			replacements: [{
				filePath: '/workspace/file.ts',
				explanation: 'Replace line 2 with "new line 2"',
				newString: 'new line 2',
				oldString: 'line 2',
			}]
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchInlineSnapshot(`
			{
			  "file:///workspace/file.ts": "line 1
			new line 2

			line 4
			line 5",
			}
		`);
	});

	test('multi-sr bug', async () => {
		const input: IMultiReplaceStringToolParams = {
			"explanation": "Update session imports and type annotations to use IModifiedFileEntryInternal",
			"replacements": [
				{
					"explanation": "Update imports to include IModifiedFileEntryInternal",
					"filePath": "/workspace/multi-sr-bug.ts",
					"newString": "import { ChatEditingSessionState, ChatEditKind, getMultiDiffSourceUri, IChatEditingSession, IModifiedEntryTelemetryInfo, IModifiedFileEntry, IModifiedFileEntryInternal, IPendingFileOperation, ISnapshotEntry, IStreamingEdits, ModifiedFileEntryState } from '../../common/chatEditingService.js';",
					"oldString": "import { ChatEditingSessionState, ChatEditKind, getMultiDiffSourceUri, IChatEditingSession, IModifiedEntryTelemetryInfo, IModifiedFileEntry, IPendingFileOperation, ISnapshotEntry, IStreamingEdits, ModifiedFileEntryState } from '../../common/chatEditingService.js';"
				},
				{
					"explanation": "Remove unused IFile import",
					"filePath": "/workspace/multi-sr-bug.ts",
					"newString": `import { URI } from '../../../../../base/common/uri.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';`,
					"oldString": `import { URI } from '../../../../../base/common/uri.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { IFile } from '../../../../../base/node/zip.js';`
				},
				{
					"explanation": "Update _entriesObs type to use IModifiedFileEntryInternal",
					"filePath": "/workspace/multi-sr-bug.ts",
					"newString": `	private readonly _entriesObs = observableValue<readonly IModifiedFileEntryInternal[]>(this, []);
	public get entries(): IObservable<readonly IModifiedFileEntry[]> {
		return this._entriesObs;
	}`,
					"oldString": `	private readonly _entriesObs = observableValue<readonly AbstractChatEditingModifiedFileEntry[]>(this, []);
	public get entries(): IObservable<readonly IModifiedFileEntry[]> {
		return this._entriesObs;
	}`
				}
			]
		};

		const r = await invoke(input);
		expect(await applyEditsInMap(r.edits)).toMatchFileSnapshot(__dirname + '/editFileToolUtilsFixtures/multi-sr-bug-actual.txt');
	});
});
