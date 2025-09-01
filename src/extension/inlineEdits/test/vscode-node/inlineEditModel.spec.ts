/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, assert, beforeEach, suite, test } from 'vitest';
import { TextEditor, type TextDocument } from 'vscode';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
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

			disposables.add(new InlineEditTriggerer(vscWorkspace as any, nextEditProvider as any as NextEditProvider, signal, accessor.get(ILogService), accessor.get(IConfigurationService), accessor.get(IExperimentationService), workspaceService));
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

		function triggerTextChange(document: TextDocument) {
			workspaceService.didChangeTextDocumentEmitter.fire({
				document,
				contentChanges: [],
				reason: undefined
			});
		}
		function triggerTextSelectionChange(textEditor: TextEditor, selection: Selection) {
			workspaceService.didChangeTextEditorSelectionEmitter.fire({
				kind: TextEditorSelectionChangeKind.Keyboard,
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
			const doc = createTextDocumentData(Uri.file('sample.py'), 'print("Hello World")', 'python');
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
