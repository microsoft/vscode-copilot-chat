/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, assert, beforeEach, suite, test } from 'vitest';
import { TextEditor, type TextDocument } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { ILogService } from '../../../../platform/log/common/logService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { createTextDocumentData } from '../../../../util/common/test/shims/textDocument';
import { ExtHostTextEditor } from '../../../../util/common/test/shims/textEditor';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IReader, observableSignal } from '../../../../util/vs/base/common/observableInternal';
import { Selection, TextEditorSelectionChangeKind, Uri } from '../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { NextEditProvider } from '../../node/nextEditProvider';
import { InlineEditTriggerer } from '../../vscode-node/inlineEditModel';
import { IVSCodeObservableDocument } from '../../vscode-node/parts/vscodeWorkspace';


suite('InlineEditModel', () => {
	suite('InlineEditTriggerer', () => {
		let disposables: DisposableStore;
		let vscWorkspace: MockVSCodeWorkspace;
		let workspaceService: TestWorkspaceService;
		let signalFiredCount = 0;
		let nextEditProvider: { lastRejectionTime: number; lastTriggerTime: number };
		let configurationService: IConfigurationService;

		beforeEach(() => {
			disposables = new DisposableStore();
			signalFiredCount = 0;
			const signal = observableSignal('test');
			disposables.add(Event.fromObservableLight(signal)(() => signalFiredCount++));
			vscWorkspace = new MockVSCodeWorkspace();
			nextEditProvider = { lastRejectionTime: Date.now(), lastTriggerTime: Date.now() } as any as NextEditProvider;

			workspaceService = disposables.add(new TestWorkspaceService());
			const services = disposables.add(createExtensionUnitTestingServices());
			const accessor = disposables.add(services.createTestingAccessor());
			configurationService = accessor.get(IConfigurationService);

			disposables.add(new InlineEditTriggerer(vscWorkspace as any, nextEditProvider as any as NextEditProvider, signal, accessor.get(ILogService), configurationService, accessor.get(IExperimentationService), workspaceService));
		});

		afterEach(() => {
			disposables.dispose();
		});
		test('No Signal if there were no changes', () => {
			const { textEditor, selection } = createTextDocument();

			triggerTextSelectionChange(textEditor, selection);

			assert.strictEqual(signalFiredCount, 0, 'Signal should not have been fired');
		});
		test('No Signal if selection is not empty', () => {
			const { document, textEditor, selection } = createTextDocument(new Selection(0, 0, 0, 10));

			triggerTextChange(document);
			triggerTextSelectionChange(textEditor, selection);

			assert.strictEqual(signalFiredCount, 0, 'Signal should not have been fired');
		});
		test('Signal when last rejection was over 10s ago', () => {
			const { document, textEditor, selection } = createTextDocument();
			nextEditProvider.lastRejectionTime = Date.now() - (10 * 1000);

			triggerTextChange(document);
			triggerTextSelectionChange(textEditor, selection);

			assert.isAtLeast(signalFiredCount, 1, 'Signal should have been fired');
		});

		test('No Signal on document switch when no recent NES trigger', async () => {
			// Enable document switch trigger
			await configurationService.setConfig(ConfigKey.Advanced.InlineEditsTriggerOnEditorChangeAfterSeconds, 60);

			// Create first document and make a change
			const doc1 = createTextDocument(new Selection(0, 0, 0, 0), Uri.file('file1.py'), 'print("file1")');
			triggerTextChange(doc1.document);

			// Set up stale trigger time - NES hasn't been triggered recently
			nextEditProvider.lastRejectionTime = Date.now() - (10 * 1000);
			nextEditProvider.lastTriggerTime = Date.now() - (15 * 1000); // 15s ago, outside 10s window

			// Create second document and switch to it
			const doc2 = createTextDocument(new Selection(0, 0, 0, 0), Uri.file('file2.py'), 'print("file2")');

			// This should NOT trigger because lastTriggerTime is stale
			triggerTextSelectionChange(doc2.textEditor, doc2.selection);

			assert.strictEqual(signalFiredCount, 0, 'Signal should NOT fire on document switch when NES trigger is stale');
		});

		test('Signal on document switch when recent NES trigger', async () => {
			// Enable document switch trigger
			await configurationService.setConfig(ConfigKey.Advanced.InlineEditsTriggerOnEditorChangeAfterSeconds, 60);

			// Create first document and make a change
			const doc1 = createTextDocument(new Selection(0, 0, 0, 0), Uri.file('file1.py'), 'print("file1")');
			triggerTextChange(doc1.document);

			// Set up recent trigger time
			nextEditProvider.lastRejectionTime = Date.now() - (10 * 1000);
			nextEditProvider.lastTriggerTime = Date.now() - (5 * 1000); // 5s ago, within 10s window

			// Create second document and switch to it
			const doc2 = createTextDocument(new Selection(0, 0, 0, 0), Uri.file('file2.py'), 'print("file2")');

			// This SHOULD trigger because lastTriggerTime is recent
			triggerTextSelectionChange(doc2.textEditor, doc2.selection);

			assert.isAtLeast(signalFiredCount, 1, 'Signal should fire on document switch when NES trigger is recent');
		});

		function triggerTextChange(document: TextDocument) {
			workspaceService.didChangeTextDocumentEmitter.fire({
				document,
				contentChanges: [],
				reason: undefined
			});
		}
		function triggerTextSelectionChange(textEditor: TextEditor, selection: Selection) {
			triggerTextSelectionChangeWithKind(textEditor, selection, TextEditorSelectionChangeKind.Keyboard);
		}
		function triggerTextSelectionChangeWithKind(textEditor: TextEditor, selection: Selection, kind: TextEditorSelectionChangeKind) {
			workspaceService.didChangeTextEditorSelectionEmitter.fire({
				kind,
				selections: [selection],
				textEditor,
			});
		}
		function createObservableTextDoc(uri: Uri): IVSCodeObservableDocument {
			return {
				id: DocumentId.create(uri.toString()),
				toRange: (_: any, range: any) => range
			} as any;
		}
		class MockVSCodeWorkspace {
			public readonly documents = new WeakMap<TextDocument, IVSCodeObservableDocument>();
			public addDoc(doc: TextDocument, obsDoc: IVSCodeObservableDocument) {
				this.documents.set(doc, obsDoc);
			}
			public getDocumentByTextDocument(doc: TextDocument, reader?: IReader): IVSCodeObservableDocument | undefined {
				return this.documents.get(doc);
			}
		}

		function createTextDocument(selection: Selection = new Selection(0, 0, 0, 0), uri: Uri = Uri.file('sample.py'), content = 'print("Hello World")') {
			const doc = createTextDocumentData(uri, content, 'python');
			const textEditor = new ExtHostTextEditor(doc.document, [selection], {}, [], undefined);
			vscWorkspace.addDoc(doc.document, createObservableTextDoc(doc.document.uri));
			return {
				document: doc.document,
				textEditor: textEditor.value,
				selection
			};
		}
	});
});
