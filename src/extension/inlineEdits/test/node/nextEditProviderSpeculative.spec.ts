/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { ConfigKey } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { IGitExtensionService } from '../../../../platform/git/common/gitExtensionService';
import { NullGitExtensionService } from '../../../../platform/git/common/nullGitExtensionService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { SpeculativeRequestsEnablement } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { InlineEditRequestLogContext } from '../../../../platform/inlineEdits/common/inlineEditLogContext';
import { ObservableGit } from '../../../../platform/inlineEdits/common/observableGit';
import { MutableObservableWorkspace } from '../../../../platform/inlineEdits/common/observableWorkspace';
import { IStatelessNextEditProvider, NoNextEditReason, StatelessNextEditRequest, StatelessNextEditTelemetryBuilder, WithStatelessProviderTelemetry } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';
import { NesHistoryContextProvider } from '../../../../platform/inlineEdits/common/workspaceEditTracker/nesHistoryContextProvider';
import { NesXtabHistoryTracker } from '../../../../platform/inlineEdits/common/workspaceEditTracker/nesXtabHistoryTracker';
import { ILogger, ILogService, LogServiceImpl } from '../../../../platform/log/common/logService';
import { NullRequestLogger } from '../../../../platform/requestLogger/node/nullRequestLogger';
import { IRequestLogger } from '../../../../platform/requestLogger/node/requestLogger';
import { ISnippyService, NullSnippyService } from '../../../../platform/snippy/common/snippyService';
import { IExperimentationService, NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { mockNotebookService } from '../../../../platform/test/common/testNotebookService';
import { TestWorkspaceService } from '../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { Result } from '../../../../util/common/result';
import { DeferredPromise } from '../../../../util/vs/base/common/async';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { generateUuid } from '../../../../util/vs/base/common/uuid';
import { LineReplacement } from '../../../../util/vs/editor/common/core/edits/lineEdit';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { LineRange } from '../../../../util/vs/editor/common/core/ranges/lineRange';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { NESInlineCompletionContext, NextEditProvider } from '../../node/nextEditProvider';
import { ILlmNESTelemetry, NextEditProviderTelemetryBuilder, ReusedRequestKind } from '../../node/nextEditProviderTelemetry';

interface ICallRecord {
	readonly request: StatelessNextEditRequest;
	readonly cancellationRequested: DeferredPromise<void>;
	readonly completed: DeferredPromise<void>;
	wasCancelled: boolean;
}

type ProviderBehavior =
	| {
		kind: 'yieldEditThenNoSuggestions';
		edit: LineReplacement;
	}
	| {
		kind: 'yieldEditThenWait';
		edit: LineReplacement;
		continueSignal: DeferredPromise<void>;
	}
	| {
		kind: 'waitForCancellation';
	};

class TestStatelessNextEditProvider implements IStatelessNextEditProvider {
	public readonly ID = 'TestStatelessNextEditProvider';

	private readonly _behaviors: ProviderBehavior[] = [];
	public readonly calls: ICallRecord[] = [];
	private readonly _callDeferreds: DeferredPromise<void>[] = [];

	public enqueueBehavior(behavior: ProviderBehavior): void {
		this._behaviors.push(behavior);
	}

	/** Returns a promise that resolves when the Nth call (1-based) arrives. */
	public waitForCall(callNumber: number): Promise<void> {
		if (this.calls.length >= callNumber) {
			return Promise.resolve();
		}
		while (this._callDeferreds.length < callNumber) {
			this._callDeferreds.push(new DeferredPromise<void>());
		}
		return this._callDeferreds[callNumber - 1].p;
	}

	private _resolveCallDeferred(): void {
		const callIdx = this.calls.length - 1;
		if (callIdx < this._callDeferreds.length) {
			this._callDeferreds[callIdx].complete();
		}
	}

	public async *provideNextEdit(request: StatelessNextEditRequest, _logger: ILogger, _logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken) {
		const behavior = this._behaviors.shift();
		if (!behavior) {
			throw new Error('Missing provider behavior');
		}

		const telemetryBuilder = new StatelessNextEditTelemetryBuilder(request.headerRequestId);
		const cancellationRequested = new DeferredPromise<void>();
		const completed = new DeferredPromise<void>();
		const call: ICallRecord = {
			request,
			cancellationRequested,
			completed,
			wasCancelled: false,
		};

		this.calls.push(call);
		this._resolveCallDeferred();
		const cancellationDisposable = cancellationToken.onCancellationRequested(() => {
			call.wasCancelled = true;
			if (!cancellationRequested.isSettled) {
				cancellationRequested.complete();
			}
		});

		try {
			if (behavior.kind === 'waitForCancellation') {
				await cancellationRequested.p;
				const cancelled = new NoNextEditReason.GotCancelled('testCancellation');
				return new WithStatelessProviderTelemetry(cancelled, telemetryBuilder.build(Result.error(cancelled)));
			}

			yield new WithStatelessProviderTelemetry({ edit: behavior.edit, isFromCursorJump: false }, telemetryBuilder.build(Result.ok(undefined)));

			if (behavior.kind === 'yieldEditThenWait') {
				await Promise.race([behavior.continueSignal.p, cancellationRequested.p]);
			}

			const noSuggestions = new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, undefined);
			return new WithStatelessProviderTelemetry(noSuggestions, telemetryBuilder.build(Result.error(noSuggestions)));
		} finally {
			cancellationDisposable.dispose();
			if (!completed.isSettled) {
				completed.complete();
			}
		}
	}
}

function createInlineContext(): NESInlineCompletionContext {
	return {
		triggerKind: 1,
		selectedCompletionInfo: undefined,
		requestUuid: generateUuid(),
		requestIssuedDateTime: Date.now(),
		earliestShownDateTime: Date.now(),
		enforceCacheDelay: false,
	};
}

async function flushMicrotasks(ticks = 20): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await Promise.resolve();
	}
}

function lineReplacement(lineNumberOneBased: number, newLine: string): LineReplacement {
	return new LineReplacement(new LineRange(lineNumberOneBased, lineNumberOneBased + 1), [newLine]);
}

describe('NextEditProvider speculative requests', () => {
	let disposables: DisposableStore;
	let configService: InMemoryConfigurationService;
	let snippyService: ISnippyService;
	let gitExtensionService: IGitExtensionService;
	let logService: ILogService;
	let expService: IExperimentationService;
	let workspaceService: IWorkspaceService;
	let requestLogger: IRequestLogger;

	beforeEach(() => {
		disposables = new DisposableStore();
		workspaceService = disposables.add(new TestWorkspaceService());
		configService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		snippyService = new NullSnippyService();
		gitExtensionService = new NullGitExtensionService();
		logService = new LogServiceImpl([]);
		expService = new NullExperimentationService();
		requestLogger = new NullRequestLogger();
	});

	afterEach(() => {
		disposables.dispose();
	});

	function createProviderAndWorkspace(statelessProvider: IStatelessNextEditProvider): { nextEditProvider: NextEditProvider; workspace: MutableObservableWorkspace } {
		const workspace = new MutableObservableWorkspace();
		const git = new ObservableGit(gitExtensionService);
		const nextEditProvider = new NextEditProvider(
			workspace,
			statelessProvider,
			new NesHistoryContextProvider(workspace, git),
			new NesXtabHistoryTracker(workspace, undefined, configService, expService),
			undefined,
			configService,
			snippyService,
			logService,
			expService,
			requestLogger,
		);
		return { nextEditProvider, workspace };
	}

	async function getNextEdit(nextEditProvider: NextEditProvider, docId: DocumentId) {
		const context = createInlineContext();
		const logContext = new InlineEditRequestLogContext(docId.toString(), 1, context);
		const telemetryBuilder = new NextEditProviderTelemetryBuilder(gitExtensionService, mockNotebookService, workspaceService, nextEditProvider.ID, undefined);
		try {
			return await nextEditProvider.getNextEdit(docId, context, logContext, CancellationToken.None, telemetryBuilder.nesBuilder);
		} finally {
			telemetryBuilder.dispose();
		}
	}

	async function getNextEditWithTelemetry(nextEditProvider: NextEditProvider, docId: DocumentId): Promise<{ suggestion: Awaited<ReturnType<typeof getNextEdit>>; telemetry: ILlmNESTelemetry }> {
		const context = createInlineContext();
		const logContext = new InlineEditRequestLogContext(docId.toString(), 1, context);
		const telemetryBuilder = new NextEditProviderTelemetryBuilder(gitExtensionService, mockNotebookService, workspaceService, nextEditProvider.ID, undefined);
		try {
			const suggestion = await nextEditProvider.getNextEdit(docId, context, logContext, CancellationToken.None, telemetryBuilder.nesBuilder);
			const telemetry = telemetryBuilder.nesBuilder.build(false);
			return { suggestion, telemetry };
		} finally {
			telemetryBuilder.dispose();
		}
	}

	it('does not trigger speculative request when feature is off', async () => {
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.Off);

		const statelessProvider = new TestStatelessNextEditProvider();
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
		const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

		const doc = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-off.ts').toString()),
			initialValue: 'const value = 1;\nconsole.log(value);',
		});
		doc.setSelection([new OffsetRange(0, 0)], undefined);

		const suggestion = await getNextEdit(nextEditProvider, doc.id);
		assert(suggestion.result?.edit);

		nextEditProvider.handleShown(suggestion);
		await flushMicrotasks();

		expect(statelessProvider.calls.length).toBe(1);
	});

	it('triggers speculative request when feature is on', async () => {
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

		const statelessProvider = new TestStatelessNextEditProvider();
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
		statelessProvider.enqueueBehavior({ kind: 'waitForCancellation' });
		const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

		const doc = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-on.ts').toString()),
			initialValue: 'const value = 1;\nconsole.log(value);',
		});
		doc.setSelection([new OffsetRange(0, 0)], undefined);

		const suggestion = await getNextEdit(nextEditProvider, doc.id);
		assert(suggestion.result?.edit);

		nextEditProvider.handleShown(suggestion);
		await statelessProvider.waitForCall(2);

		expect(statelessProvider.calls.length).toBe(2);
		nextEditProvider.handleRejection(doc.id, suggestion);
		await statelessProvider.calls[1].completed.p;
	});

	it('reuses speculative request after acceptance without creating a third request', async () => {
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

		const statelessProvider = new TestStatelessNextEditProvider();
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(2, 'console.log(value + 1);') });
		const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

		const doc = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-reuse.ts').toString()),
			initialValue: 'const value = 1;\nconsole.log(value);',
		});
		doc.setSelection([new OffsetRange(0, 0)], undefined);

		const firstSuggestion = await getNextEdit(nextEditProvider, doc.id);
		assert(firstSuggestion.result?.edit);
		nextEditProvider.handleShown(firstSuggestion);
		await statelessProvider.waitForCall(2);
		await statelessProvider.calls[1].completed.p;

		nextEditProvider.handleAcceptance(doc.id, firstSuggestion);
		doc.applyEdit(firstSuggestion.result.edit.toEdit());

		const secondSuggestion = await getNextEdit(nextEditProvider, doc.id);
		assert(secondSuggestion.result?.edit);

		expect(statelessProvider.calls.length).toBe(2);
		expect(secondSuggestion.result.edit.newText).toBe('console.log(value + 1);');
	});

	it('cancels speculative request on rejection', async () => {
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

		const statelessProvider = new TestStatelessNextEditProvider();
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
		statelessProvider.enqueueBehavior({ kind: 'waitForCancellation' });
		const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

		const doc = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-reject.ts').toString()),
			initialValue: 'const value = 1;\nconsole.log(value);',
		});
		doc.setSelection([new OffsetRange(0, 0)], undefined);

		const suggestion = await getNextEdit(nextEditProvider, doc.id);
		assert(suggestion.result?.edit);
		nextEditProvider.handleShown(suggestion);
		await statelessProvider.waitForCall(2);

		nextEditProvider.handleRejection(doc.id, suggestion);
		await statelessProvider.calls[1].cancellationRequested.p;

		expect(statelessProvider.calls[1].wasCancelled).toBe(true);
	});

	it('cancels speculative request on ignored when suggestion was shown and not superseded', async () => {
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

		const statelessProvider = new TestStatelessNextEditProvider();
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
		statelessProvider.enqueueBehavior({ kind: 'waitForCancellation' });
		const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

		const doc = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-ignored.ts').toString()),
			initialValue: 'const value = 1;\nconsole.log(value);',
		});
		doc.setSelection([new OffsetRange(0, 0)], undefined);

		const suggestion = await getNextEdit(nextEditProvider, doc.id);
		assert(suggestion.result?.edit);
		nextEditProvider.handleShown(suggestion);
		await statelessProvider.waitForCall(2);

		nextEditProvider.handleIgnored(doc.id, suggestion, undefined);
		await statelessProvider.calls[1].cancellationRequested.p;

		expect(statelessProvider.calls[1].wasCancelled).toBe(true);
	});

	it('does not cancel speculative request on unrelated open-document changes', async () => {
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

		const statelessProvider = new TestStatelessNextEditProvider();
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
		statelessProvider.enqueueBehavior({ kind: 'waitForCancellation' });
		const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

		const activeDoc = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-active.ts').toString()),
			initialValue: 'const value = 1;\nconsole.log(value);',
		});
		activeDoc.setSelection([new OffsetRange(0, 0)], undefined);

		const unrelatedDoc = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-other.ts').toString()),
			initialValue: 'export const other = 1;',
		});
		unrelatedDoc.setSelection([new OffsetRange(0, 0)], undefined);

		const suggestion = await getNextEdit(nextEditProvider, activeDoc.id);
		assert(suggestion.result?.edit);
		nextEditProvider.handleShown(suggestion);
		await statelessProvider.waitForCall(2);

		unrelatedDoc.applyEdit(StringEdit.insert(0, '// unrelated change\n'));
		await flushMicrotasks();

		expect(statelessProvider.calls[1].wasCancelled).toBe(false);

		nextEditProvider.handleRejection(activeDoc.id, suggestion);
		await statelessProvider.calls[1].completed.p;
	});

	it('does not cancel speculative request when active document diverges from expected post-edit state', async () => {
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

		const statelessProvider = new TestStatelessNextEditProvider();
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
		statelessProvider.enqueueBehavior({ kind: 'waitForCancellation' });
		const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

		const doc = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-diverge.ts').toString()),
			initialValue: 'const value = 1;\nconsole.log(value);',
		});
		doc.setSelection([new OffsetRange(0, 0)], undefined);

		const suggestion = await getNextEdit(nextEditProvider, doc.id);
		assert(suggestion.result?.edit);
		nextEditProvider.handleShown(suggestion);
		await statelessProvider.waitForCall(2);

		// Editing the active document should NOT cancel the speculative request.
		// The speculative request targets a future post-edit state, not the current
		// document value, so keystroke-level changes should not invalidate it.
		doc.applyEdit(StringEdit.insert(0, '/* diverged */\n'));
		await flushMicrotasks();

		expect(statelessProvider.calls[1].wasCancelled).toBe(false);

		// Clean up: reject so the speculative request gets cancelled properly
		nextEditProvider.handleRejection(doc.id, suggestion);
		await statelessProvider.calls[1].completed.p;
	});

	it('keeps speculative request alive when user types in the active document', async () => {
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

		const statelessProvider = new TestStatelessNextEditProvider();
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
		statelessProvider.enqueueBehavior({ kind: 'waitForCancellation' });
		const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

		const doc = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-typing.ts').toString()),
			initialValue: 'const value = 1;\nconsole.log(value);',
		});
		doc.setSelection([new OffsetRange(0, 0)], undefined);

		const suggestion = await getNextEdit(nextEditProvider, doc.id);
		assert(suggestion.result?.edit);
		nextEditProvider.handleShown(suggestion);
		await statelessProvider.waitForCall(2);

		// Simulate multiple keystrokes in the active document while the speculative
		// request is in flight — none of them should cancel it.
		doc.applyEdit(StringEdit.insert(0, 'a'));
		await flushMicrotasks();
		expect(statelessProvider.calls[1].wasCancelled).toBe(false);

		doc.applyEdit(StringEdit.insert(1, 'b'));
		await flushMicrotasks();
		expect(statelessProvider.calls[1].wasCancelled).toBe(false);

		doc.applyEdit(StringEdit.insert(2, 'c'));
		await flushMicrotasks();
		expect(statelessProvider.calls[1].wasCancelled).toBe(false);

		// Clean up via rejection
		nextEditProvider.handleRejection(doc.id, suggestion);
		await statelessProvider.calls[1].completed.p;
	});

	it('cancels mismatched speculative request when starting a request for another document', async () => {
		await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

		const statelessProvider = new TestStatelessNextEditProvider();
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
		statelessProvider.enqueueBehavior({ kind: 'waitForCancellation' });
		statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'export const second = 2;') });
		const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

		const doc1 = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-cross-doc-1.ts').toString()),
			initialValue: 'const value = 1;\nconsole.log(value);',
		});
		doc1.setSelection([new OffsetRange(0, 0)], undefined);

		const doc2 = workspace.addDocument({
			id: DocumentId.create(URI.file('/test/spec-cross-doc-2.ts').toString()),
			initialValue: 'export const second = 1;\nconsole.log(second);',
		});
		doc2.setSelection([new OffsetRange(0, 0)], undefined);

		const suggestion = await getNextEdit(nextEditProvider, doc1.id);
		assert(suggestion.result?.edit);
		nextEditProvider.handleShown(suggestion);
		await statelessProvider.waitForCall(2);

		const secondDocSuggestion = await getNextEdit(nextEditProvider, doc2.id);
		assert(secondDocSuggestion.result?.edit);
		await statelessProvider.calls[1].cancellationRequested.p;

		expect(statelessProvider.calls[1].wasCancelled).toBe(true);
		expect(statelessProvider.calls.length).toBe(3);
	});

	describe('telemetry', () => {
		it('fresh request has normal headerRequestId and no reusedRequest', async () => {
			const statelessProvider = new TestStatelessNextEditProvider();
			statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
			const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

			const doc = workspace.addDocument({
				id: DocumentId.create(URI.file('/test/telemetry-fresh.ts').toString()),
				initialValue: 'const value = 1;\nconsole.log(value);',
			});
			doc.setSelection([new OffsetRange(0, 0)], undefined);

			const { suggestion, telemetry } = await getNextEditWithTelemetry(nextEditProvider, doc.id);
			assert(suggestion.result?.edit);

			expect(telemetry.headerRequestId).toBeDefined();
			expect(telemetry.headerRequestId!.startsWith('sp-')).toBe(false);
			expect(telemetry.isFromCache).toBe(false);
			expect(telemetry.reusedRequest).toBeUndefined();
		});

		it('reused speculative request has sp- headerRequestId and reusedRequest=speculative', async () => {
			await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

			const statelessProvider = new TestStatelessNextEditProvider();
			statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
			// The speculative request yields an edit but stays in-flight until we signal it,
			// so the second getNextEdit joins the pending speculative request rather than hitting cache.
			const specContinue = new DeferredPromise<void>();
			statelessProvider.enqueueBehavior({ kind: 'yieldEditThenWait', edit: lineReplacement(2, 'console.log(value + 1);'), continueSignal: specContinue });
			const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

			const doc = workspace.addDocument({
				id: DocumentId.create(URI.file('/test/telemetry-spec-reuse.ts').toString()),
				initialValue: 'const value = 1;\nconsole.log(value);',
			});
			doc.setSelection([new OffsetRange(0, 0)], undefined);

			// First request: fresh
			const firstSuggestion = await getNextEdit(nextEditProvider, doc.id);
			assert(firstSuggestion.result?.edit);
			nextEditProvider.handleShown(firstSuggestion);
			await statelessProvider.waitForCall(2);
			// Speculative request is now in-flight (yielded edit but waiting on continueSignal)

			// Accept and apply the edit
			nextEditProvider.handleAcceptance(doc.id, firstSuggestion);
			doc.applyEdit(firstSuggestion.result.edit.toEdit());

			// Second request: should join the still-in-flight speculative request
			const { suggestion: secondSuggestion, telemetry } = await getNextEditWithTelemetry(nextEditProvider, doc.id);
			assert(secondSuggestion.result?.edit);

			expect(telemetry.headerRequestId).toBeDefined();
			expect(telemetry.headerRequestId!.startsWith('sp-')).toBe(true);
			expect(telemetry.isFromCache).toBe(false);
			expect(telemetry.reusedRequest).toBe(ReusedRequestKind.Speculative);

			// Clean up: let the speculative request finish
			specContinue.complete();
			await statelessProvider.calls[1].completed.p;
		});

		it('cached speculative result has sp- headerRequestId and isFromCache=true', async () => {
			await configService.setConfig(ConfigKey.TeamInternal.InlineEditsSpeculativeRequests, SpeculativeRequestsEnablement.On);

			const statelessProvider = new TestStatelessNextEditProvider();
			statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(1, 'const value = 2;') });
			statelessProvider.enqueueBehavior({ kind: 'yieldEditThenNoSuggestions', edit: lineReplacement(2, 'console.log(value + 1);') });
			const { nextEditProvider, workspace } = createProviderAndWorkspace(statelessProvider);

			const doc = workspace.addDocument({
				id: DocumentId.create(URI.file('/test/telemetry-spec-cache.ts').toString()),
				initialValue: 'const value = 1;\nconsole.log(value);',
			});
			doc.setSelection([new OffsetRange(0, 0)], undefined);

			// First request: fresh
			const firstSuggestion = await getNextEdit(nextEditProvider, doc.id);
			assert(firstSuggestion.result?.edit);
			nextEditProvider.handleShown(firstSuggestion);
			await statelessProvider.waitForCall(2);
			await statelessProvider.calls[1].completed.p;

			// Accept and apply (speculative result is now cached)
			nextEditProvider.handleAcceptance(doc.id, firstSuggestion);
			doc.applyEdit(firstSuggestion.result.edit.toEdit());

			// Clear the speculative pending request by requesting once (consumes it from pending)
			const consumeResult = await getNextEdit(nextEditProvider, doc.id);
			assert(consumeResult.result?.edit);

			// Now the result is in cache. Request again at same document state.
			const { suggestion: cachedSuggestion, telemetry } = await getNextEditWithTelemetry(nextEditProvider, doc.id);
			assert(cachedSuggestion.result?.edit);

			expect(telemetry.headerRequestId).toBeDefined();
			expect(telemetry.headerRequestId!.startsWith('sp-')).toBe(true);
			expect(telemetry.isFromCache).toBe(true);
			expect(telemetry.reusedRequest).toBeUndefined();
		});
	});
});
