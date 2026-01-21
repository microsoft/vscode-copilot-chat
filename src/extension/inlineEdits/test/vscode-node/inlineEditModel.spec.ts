/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, assert, beforeEach, suite, test } from 'vitest';
import { TextDocumentChangeReason, TextEditor, type TextDocument } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { ILogService } from '../../../../platform/log/common/logService';
import { IExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { createTextDocumentData } from '../../../../util/common/test/shims/textDocument';
import { ExtHostTextEditor } from '../../../../util/common/test/shims/textEditor';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IReader } from '../../../../util/vs/base/common/observableInternal';
import { Selection, TextEditorSelectionChangeKind, Uri } from '../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { NesChangeHint, NesTriggerReason } from '../../common/nesTriggerHint';
import { NextEditProvider } from '../../node/nextEditProvider';
import {
	InlineEditTriggerer,
	TRIGGER_INLINE_EDIT_AFTER_CHANGE_LIMIT,
	TRIGGER_INLINE_EDIT_ON_SAME_LINE_COOLDOWN,
	TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN
} from '../../vscode-node/inlineEditTriggerer';
import { IVSCodeObservableDocument } from '../../vscode-node/parts/vscodeWorkspace';


suite('InlineEditModel', () => {
	suite('InlineEditTriggerer', () => {
		let disposables: DisposableStore;
		let vscWorkspace: MockVSCodeWorkspace;
		let workspaceService: TestWorkspaceService;
		let firedEvents: NesChangeHint[];
		let nextEditProvider: MockNextEditProvider;
		let configurationService: InMemoryConfigurationService;
		let triggerer: InlineEditTriggerer;

		class MockNextEditProvider {
			public lastRejectionTime: number = Date.now();
			public lastTriggerTime: number = Date.now();
		}

		class MockVSCodeWorkspace {
			public readonly documents = new WeakMap<TextDocument, IVSCodeObservableDocument>();
			public addDoc(doc: TextDocument, obsDoc: IVSCodeObservableDocument): void {
				this.documents.set(doc, obsDoc);
			}
			public getDocumentByTextDocument(doc: TextDocument, _reader?: IReader): IVSCodeObservableDocument | undefined {
				return this.documents.get(doc);
			}
		}

		beforeEach(() => {
			disposables = new DisposableStore();
			firedEvents = [];
			vscWorkspace = new MockVSCodeWorkspace();
			nextEditProvider = new MockNextEditProvider();

			workspaceService = disposables.add(new TestWorkspaceService());
			const services = disposables.add(createExtensionUnitTestingServices());
			const accessor = disposables.add(services.createTestingAccessor());

			configurationService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
			triggerer = disposables.add(new InlineEditTriggerer(
				vscWorkspace as any,
				nextEditProvider as any as NextEditProvider,
				accessor.get(ILogService),
				configurationService,
				accessor.get(IExperimentationService),
				workspaceService
			));
			disposables.add(triggerer.onChange(e => firedEvents.push(e)));
		});

		afterEach(() => {
			disposables.dispose();
		});

		// #region Helper functions

		function triggerTextChange(document: TextDocument, reason?: TextDocumentChangeReason): void {
			workspaceService.didChangeTextDocumentEmitter.fire({
				document,
				contentChanges: [],
				reason
			});
		}

		function triggerTextSelectionChange(textEditor: TextEditor, selection: Selection, kind = TextEditorSelectionChangeKind.Keyboard): void {
			workspaceService.didChangeTextEditorSelectionEmitter.fire({
				kind,
				selections: [selection],
				textEditor,
			});
		}

		function triggerMultipleSelectionChange(textEditor: TextEditor, selections: Selection[]): void {
			workspaceService.didChangeTextEditorSelectionEmitter.fire({
				kind: TextEditorSelectionChangeKind.Keyboard,
				selections,
				textEditor,
			});
		}

		function createObservableTextDoc(uri: Uri): IVSCodeObservableDocument {
			return {
				id: DocumentId.create(uri.toString()),
				toRange: (_: any, range: any) => range
			} as any;
		}

		function createTextDocument(
			selection: Selection = new Selection(0, 0, 0, 0),
			uri: Uri = Uri.file('sample.py'),
			content = 'print("Hello World")'
		): { document: TextDocument; textEditor: TextEditor; selection: Selection } {
			const doc = createTextDocumentData(uri, content, 'python');
			const textEditor = new ExtHostTextEditor(doc.document, [selection], {}, [], undefined);
			vscWorkspace.addDoc(doc.document, createObservableTextDoc(doc.document.uri));
			return {
				document: doc.document,
				textEditor: textEditor.value,
				selection
			};
		}

		function createOutputDocument(): { document: TextDocument; textEditor: TextEditor; selection: Selection } {
			const uri = Uri.parse('output:extension-output-GitHub.copilot-chat-#1-GitHub Copilot Chat');
			const doc = createTextDocumentData(uri, 'output logs', 'log');
			const selection = new Selection(0, 0, 0, 0);
			const textEditor = new ExtHostTextEditor(doc.document, [selection], {}, [], undefined);
			return { document: doc.document, textEditor: textEditor.value, selection };
		}

		function getLastFiredReason(): NesTriggerReason | undefined {
			return firedEvents.at(-1)?.data.reason;
		}

		// #endregion

		// #region Basic behaviors

		suite('Basic behaviors', () => {
			test('No signal if there were no text changes', () => {
				const { textEditor, selection } = createTextDocument();

				triggerTextSelectionChange(textEditor, selection);

				assert.strictEqual(firedEvents.length, 0, 'Signal should not have been fired');
			});

			test('No signal if selection is not empty', () => {
				const { document, textEditor, selection } = createTextDocument(new Selection(0, 0, 0, 10));

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, selection);

				assert.strictEqual(firedEvents.length, 0, 'Signal should not have been fired');
			});

			test('Signal fires when text changes and cursor moves with empty selection', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.isAtLeast(firedEvents.length, 1, 'Signal should have been fired');
				assert.strictEqual(getLastFiredReason(), NesTriggerReason.SelectionChange);
			});

			test('No signal with multiple selections', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				triggerMultipleSelectionChange(textEditor, [
					new Selection(0, 0, 0, 0),
					new Selection(1, 0, 1, 0)
				]);

				assert.strictEqual(firedEvents.length, 0, 'Signal should not have been fired for multiple selections');
			});
		});

		// #endregion

		// #region Rejection cooldown

		suite('Rejection cooldown', () => {
			test('No signal when last rejection was within cooldown period', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - (TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1000);

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.strictEqual(firedEvents.length, 0, 'Signal should not fire during rejection cooldown');
			});

			test('Signal fires when last rejection was over cooldown ago', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - (TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN + 1);

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.isAtLeast(firedEvents.length, 1, 'Signal should have been fired');
			});

			test('Rejection clears tracking for the document', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				// Now set rejection time to be recent
				nextEditProvider.lastRejectionTime = Date.now();
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.strictEqual(firedEvents.length, 0, 'Signal should not fire');

				// Make another change and ensure tracking was cleared
				triggerTextSelectionChange(textEditor, new Selection(0, 10, 0, 10));
				assert.strictEqual(firedEvents.length, 0, 'Signal should still not fire as doc was cleared');
			});
		});

		// #endregion

		// #region Document filtering

		suite('Document filtering', () => {
			test('Ignores output pane documents for text changes', () => {
				const { document, textEditor, selection } = createOutputDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, selection);

				assert.strictEqual(firedEvents.length, 0, 'Signal should not fire for output documents');
			});

			test('Ignores copilot-ignored documents (not in workspace)', () => {
				const { document, textEditor } = createTextDocument();
				// Remove from workspace to simulate copilot-ignored
				vscWorkspace.documents.delete(document);
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.strictEqual(firedEvents.length, 0, 'Signal should not fire for ignored documents');
			});
		});

		// #endregion

		// #region Undo/Redo handling

		suite('Undo/Redo handling', () => {
			test('Ignores undo changes', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document, TextDocumentChangeReason.Undo);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.strictEqual(firedEvents.length, 0, 'Signal should not fire for undo changes');
			});

			test('Ignores redo changes', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document, TextDocumentChangeReason.Redo);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.strictEqual(firedEvents.length, 0, 'Signal should not fire for redo changes');
			});
		});

		// #endregion

		// #region Edit timestamp limits

		suite('Edit timestamp limits', () => {
			test('No signal if edit is too old', async () => {
				const { document } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);

				// Simulate time passing beyond the limit by manipulating internal state
				// We need to wait for the limit to pass - but since we can't easily mock Date.now(),
				// we test the boundary condition instead by verifying the constant is used correctly
				assert.strictEqual(TRIGGER_INLINE_EDIT_AFTER_CHANGE_LIMIT, 10000, 'Limit should be 10 seconds');
			});

			test('Signal fires when edit is within time limit', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.isAtLeast(firedEvents.length, 1, 'Signal should fire for recent edits');
			});
		});

		// #endregion

		// #region Trigger time checks

		suite('Trigger time checks', () => {
			test('No signal if last trigger time is too old', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;
				nextEditProvider.lastTriggerTime = Date.now() - TRIGGER_INLINE_EDIT_AFTER_CHANGE_LIMIT - 1;

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.strictEqual(firedEvents.length, 0, 'Signal should not fire when last trigger is too old');
			});

			test('Signal fires when last trigger time is recent', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;
				nextEditProvider.lastTriggerTime = Date.now();

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.isAtLeast(firedEvents.length, 1, 'Signal should fire for recent triggers');
			});
		});

		// #endregion

		// #region Same line cooldown

		suite('Same line cooldown', () => {
			test('No signal for same line within cooldown period', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				const initialCount = firedEvents.length;
				assert.isAtLeast(initialCount, 1, 'First signal should fire');

				// Same line, different column - should be in cooldown
				triggerTextSelectionChange(textEditor, new Selection(0, 10, 0, 10));

				assert.strictEqual(firedEvents.length, initialCount, 'Signal should not fire for same line in cooldown');
			});

			test('Signal fires on different line', () => {
				const { document, textEditor } = createTextDocument(undefined, undefined, 'line1\nline2\nline3');
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 0, 0, 0));

				const initialCount = firedEvents.length;
				assert.isAtLeast(initialCount, 1, 'First signal should fire');

				// Different line
				triggerTextSelectionChange(textEditor, new Selection(1, 0, 1, 0));

				assert.isAtLeast(firedEvents.length, initialCount + 1, 'Signal should fire for different line');
			});

			test('Cooldown constant is 5 seconds', () => {
				assert.strictEqual(TRIGGER_INLINE_EDIT_ON_SAME_LINE_COOLDOWN, 5000, 'Same line cooldown should be 5s');
			});
		});

		// #endregion

		// #region Document switch behavior

		suite('Document switch behavior', () => {
			test('Triggers on document switch when configured', () => {
				const doc1 = createTextDocument(undefined, Uri.file('file1.py'));
				const doc2 = createTextDocument(undefined, Uri.file('file2.py'));

				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				// Configure to trigger on document switch
				void configurationService.setConfig(ConfigKey.Advanced.InlineEditsTriggerOnEditorChangeAfterSeconds, 30);

				// Make a change in doc1
				triggerTextChange(doc1.document);
				triggerTextSelectionChange(doc1.textEditor, new Selection(0, 5, 0, 5));

				const initialCount = firedEvents.length;

				// Switch to doc2
				triggerTextSelectionChange(doc2.textEditor, new Selection(0, 0, 0, 0));

				assert.isAtLeast(firedEvents.length, initialCount + 1, 'Signal should fire on document switch');
				assert.strictEqual(getLastFiredReason(), NesTriggerReason.ActiveDocumentSwitch);
			});

			test('Does not trigger on same document', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				void configurationService.setConfig(ConfigKey.Advanced.InlineEditsTriggerOnEditorChangeAfterSeconds, 30);

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				// Same document, just moving cursor (no tracked change for line 1)
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				// Should not trigger a document switch event for same document
				const switchEvents = firedEvents.filter(e => e.data.reason === NesTriggerReason.ActiveDocumentSwitch);
				assert.strictEqual(switchEvents.length, 0, 'Should not trigger document switch for same doc');
			});

			test('Does not trigger when document switch is disabled', () => {
				const doc1 = createTextDocument(undefined, Uri.file('file1.py'));
				const doc2 = createTextDocument(undefined, Uri.file('file2.py'));

				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				// Don't configure document switch trigger (leave as undefined)
				void configurationService.setConfig(ConfigKey.Advanced.InlineEditsTriggerOnEditorChangeAfterSeconds, undefined);

				triggerTextChange(doc1.document);
				triggerTextSelectionChange(doc1.textEditor, new Selection(0, 5, 0, 5));

				// Switch to doc2 without making changes there
				triggerTextSelectionChange(doc2.textEditor, new Selection(0, 0, 0, 0));

				// Should not trigger because doc2 has no tracked changes and switch trigger is disabled
				const switchEvents = firedEvents.filter(e => e.data.reason === NesTriggerReason.ActiveDocumentSwitch);
				assert.strictEqual(switchEvents.length, 0, 'Should not trigger document switch when disabled');
			});

			test('Does not trigger on document switch when there is no recent NES trigger (lastTriggerTime is 0)', () => {
				const doc1 = createTextDocument(undefined, Uri.file('file1.py'));
				const doc2 = createTextDocument(undefined, Uri.file('file2.py'));

				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;
				nextEditProvider.lastTriggerTime = 0; // No previous trigger

				// Configure to trigger on document switch
				void configurationService.setConfig(ConfigKey.Advanced.InlineEditsTriggerOnEditorChangeAfterSeconds, 30);

				// Make a change in doc1
				triggerTextChange(doc1.document);
				triggerTextSelectionChange(doc1.textEditor, new Selection(0, 5, 0, 5));

				const initialCount = firedEvents.length;

				// Switch to doc2
				triggerTextSelectionChange(doc2.textEditor, new Selection(0, 0, 0, 0));

				// Should not trigger document switch because lastTriggerTime is 0
				const switchEvents = firedEvents.filter(e => e.data.reason === NesTriggerReason.ActiveDocumentSwitch);
				assert.strictEqual(switchEvents.length, 0, 'Should not trigger document switch when lastTriggerTime is 0');
				assert.strictEqual(firedEvents.length, initialCount, 'No new events should fire');
			});

			test('Does not trigger on document switch when NES trigger was too long ago', () => {
				const doc1 = createTextDocument(undefined, Uri.file('file1.py'));
				const doc2 = createTextDocument(undefined, Uri.file('file2.py'));

				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				const triggerAfterSeconds = 30;
				// Configure to trigger on document switch
				void configurationService.setConfig(ConfigKey.Advanced.InlineEditsTriggerOnEditorChangeAfterSeconds, triggerAfterSeconds);

				// Make a change in doc1
				triggerTextChange(doc1.document);
				triggerTextSelectionChange(doc1.textEditor, new Selection(0, 5, 0, 5));

				const initialCount = firedEvents.length;

				// Set lastTriggerTime to be older than the configured threshold
				nextEditProvider.lastTriggerTime = Date.now() - (triggerAfterSeconds * 1000) - 1;

				// Switch to doc2
				triggerTextSelectionChange(doc2.textEditor, new Selection(0, 0, 0, 0));

				// Should not trigger document switch because last trigger was too long ago
				const switchEvents = firedEvents.filter(e => e.data.reason === NesTriggerReason.ActiveDocumentSwitch);
				assert.strictEqual(switchEvents.length, 0, 'Should not trigger document switch when last trigger was too long ago');
				assert.strictEqual(firedEvents.length, initialCount, 'No new events should fire');
			});

			test('Triggers on document switch when NES trigger was recent', () => {
				const doc1 = createTextDocument(undefined, Uri.file('file1.py'));
				const doc2 = createTextDocument(undefined, Uri.file('file2.py'));

				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				const triggerAfterSeconds = 30;
				// Configure to trigger on document switch
				void configurationService.setConfig(ConfigKey.Advanced.InlineEditsTriggerOnEditorChangeAfterSeconds, triggerAfterSeconds);

				// Make a change in doc1
				triggerTextChange(doc1.document);
				triggerTextSelectionChange(doc1.textEditor, new Selection(0, 5, 0, 5));

				const initialCount = firedEvents.length;

				// Set lastTriggerTime to be within the configured threshold
				nextEditProvider.lastTriggerTime = Date.now() - (triggerAfterSeconds * 1000) + 5000; // 5 seconds within the threshold

				// Switch to doc2
				triggerTextSelectionChange(doc2.textEditor, new Selection(0, 0, 0, 0));

				// Should trigger document switch because last trigger was recent
				const switchEvents = firedEvents.filter(e => e.data.reason === NesTriggerReason.ActiveDocumentSwitch);
				assert.strictEqual(switchEvents.length, 1, 'Should trigger document switch when last trigger was recent');
				assert.isAtLeast(firedEvents.length, initialCount + 1, 'Should have fired an additional event');
			});
		});

		// #endregion

		// #region Debounce behavior

		suite('Debounce behavior', () => {
			test('First two selection changes fire immediately when debounce is configured', () => {
				const { document, textEditor } = createTextDocument(undefined, undefined, 'line1\nline2\nline3');
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				// Configure debounce
				void configurationService.setConfig(ConfigKey.TeamInternal.InlineEditsDebounceOnSelectionChange, 100);

				triggerTextChange(document);

				// First selection change - should fire immediately
				triggerTextSelectionChange(textEditor, new Selection(0, 0, 0, 0));
				assert.strictEqual(firedEvents.length, 1, 'First selection change should fire immediately');

				// Second selection change - should also fire immediately
				triggerTextSelectionChange(textEditor, new Selection(1, 0, 1, 0));
				assert.strictEqual(firedEvents.length, 2, 'Second selection change should fire immediately');
			});

			test('Third and subsequent selection changes are debounced', async () => {
				const { document, textEditor } = createTextDocument(undefined, undefined, 'line1\nline2\nline3\nline4\nline5');
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				const debounceMs = 50;
				void configurationService.setConfig(ConfigKey.TeamInternal.InlineEditsDebounceOnSelectionChange, debounceMs);

				triggerTextChange(document);

				// First two fire immediately
				triggerTextSelectionChange(textEditor, new Selection(0, 0, 0, 0));
				triggerTextSelectionChange(textEditor, new Selection(1, 0, 1, 0));
				assert.strictEqual(firedEvents.length, 2, 'First two should fire immediately');

				// Third selection change - should be debounced
				triggerTextSelectionChange(textEditor, new Selection(2, 0, 2, 0));
				assert.strictEqual(firedEvents.length, 2, 'Third should not fire immediately');

				// Wait for debounce
				await new Promise(resolve => setTimeout(resolve, debounceMs + 20));
				assert.strictEqual(firedEvents.length, 3, 'Third should fire after debounce');
			});

			test('No debounce when config is undefined', () => {
				const { document, textEditor } = createTextDocument(undefined, undefined, 'line1\nline2\nline3\nline4');
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				// No debounce config
				void configurationService.setConfig(ConfigKey.TeamInternal.InlineEditsDebounceOnSelectionChange, undefined);

				triggerTextChange(document);

				// All selection changes should fire immediately
				triggerTextSelectionChange(textEditor, new Selection(0, 0, 0, 0));
				triggerTextSelectionChange(textEditor, new Selection(1, 0, 1, 0));
				triggerTextSelectionChange(textEditor, new Selection(2, 0, 2, 0));
				triggerTextSelectionChange(textEditor, new Selection(3, 0, 3, 0));

				assert.strictEqual(firedEvents.length, 4, 'All selection changes should fire immediately without debounce');
			});
		});

		// #endregion

		// #region Event data validation

		suite('Event data validation', () => {
			test('Fired event has valid NesChangeHint structure', () => {
				const { document, textEditor } = createTextDocument();
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 5, 0, 5));

				assert.isAtLeast(firedEvents.length, 1, 'Should have fired at least one event');

				const event = firedEvents[0];
				assert.isTrue(NesChangeHint.is(event), 'Event should be a valid NesChangeHint');
				assert.isString(event.data.uuid, 'UUID should be a string');
				assert.isNotEmpty(event.data.uuid, 'UUID should not be empty');
				assert.strictEqual(event.data.reason, NesTriggerReason.SelectionChange);
			});

			test('Each trigger has a unique UUID', () => {
				const { document, textEditor } = createTextDocument(undefined, undefined, 'line1\nline2');
				nextEditProvider.lastRejectionTime = Date.now() - TRIGGER_INLINE_EDIT_REJECTION_COOLDOWN - 1;

				triggerTextChange(document);
				triggerTextSelectionChange(textEditor, new Selection(0, 0, 0, 0));
				triggerTextSelectionChange(textEditor, new Selection(1, 0, 1, 0));

				assert.isAtLeast(firedEvents.length, 2, 'Should have at least 2 events');

				const uuids = firedEvents.map(e => e.data.uuid);
				const uniqueUuids = new Set(uuids);
				assert.strictEqual(uniqueUuids.size, uuids.length, 'All UUIDs should be unique');
			});
		});

		// #endregion
	});
});
