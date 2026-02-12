/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IChatMLFetcher } from '../../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType } from '../../../../platform/chat/common/commonTypes';
import { MockChatMLFetcher } from '../../../../platform/chat/test/common/mockChatMLFetcher';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { Edits } from '../../../../platform/inlineEdits/common/dataTypes/edit';
import { LanguageId } from '../../../../platform/inlineEdits/common/dataTypes/languageId';
import { NextCursorLinePrediction } from '../../../../platform/inlineEdits/common/dataTypes/nextCursorLinePrediction';
import { AggressivenessLevel, DEFAULT_OPTIONS, PromptOptions } from '../../../../platform/inlineEdits/common/dataTypes/xtabPromptOptions';
import { StatelessNextEditDocument } from '../../../../platform/inlineEdits/common/statelessNextEditProvider';
import { TestLanguageDiagnosticsService } from '../../../../platform/languages/common/testLanguageDiagnosticsService';
import { ILogger } from '../../../../platform/log/common/logService';
import { ITestingServicesAccessor } from '../../../../platform/test/node/services';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { LineEdit } from '../../../../util/vs/editor/common/core/edits/lineEdit';
import { StringEdit } from '../../../../util/vs/editor/common/core/edits/stringEdit';
import { Position } from '../../../../util/vs/editor/common/core/position';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { LintErrors } from '../../common/lintErrors';
import { PromptPieces } from '../../common/promptCrafting';
import { CurrentDocument } from '../../common/xtabCurrentDocument';
import { XtabNextCursorPredictor } from '../../node/xtabNextCursorPredictor';

function createTestLogger(): ILogger {
	return new TestLogService();
}

function computeTokens(s: string): number {
	return Math.ceil(s.length / 4);
}

function createTestPromptPieces(): PromptPieces {
	const currentDocLines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'];
	const docText = new StringText(currentDocLines.join('\n'));
	const documentId = DocumentId.create('file:///test/file.ts');

	// Create a CurrentDocument with content and cursor position
	const currentDocument = new CurrentDocument(
		docText,
		new Position(2, 1) // cursor at line 2
	);

	// Create a StatelessNextEditDocument for activeDoc
	const activeDoc = new StatelessNextEditDocument(
		documentId,
		undefined, // workspaceRoot
		LanguageId.create('typescript'),
		currentDocLines,
		LineEdit.empty,
		docText,
		new Edits(StringEdit, [])
	);

	const opts: PromptOptions = {
		...DEFAULT_OPTIONS,
		currentFile: {
			...DEFAULT_OPTIONS.currentFile,
			maxTokens: 1000,
		}
	};

	return new PromptPieces(
		currentDocument,
		new OffsetRange(1, 3), // editWindowLinesRange
		new OffsetRange(0, 5), // areaAroundEditWindowLinesRange
		activeDoc, // activeDoc
		[], // xtabHistory
		currentDocLines, // taggedCurrentDocLines as string[]
		'<area_around_code_to_edit>\nline 2\nline 3\n</area_around_code_to_edit>', // areaAroundCodeToEdit
		undefined, // langCtx - can be undefined
		AggressivenessLevel.Medium,
		new LintErrors(documentId, currentDocument, new TestLanguageDiagnosticsService()), // lintErrors
		computeTokens,
		opts
	);
}

describe('XtabNextCursorPredictor', () => {
	const disposables = new DisposableStore();
	let accessor: ITestingServicesAccessor;
	let instaService: IInstantiationService;
	let mockChatMLFetcher: MockChatMLFetcher;

	beforeEach(() => {
		const testingServiceCollection = createExtensionUnitTestingServices(disposables);

		// Register our configurable mock
		mockChatMLFetcher = new MockChatMLFetcher();
		testingServiceCollection.set(IChatMLFetcher, mockChatMLFetcher);

		accessor = disposables.add(testingServiceCollection.createTestingAccessor());
		instaService = accessor.get(IInstantiationService);

		// Enable the next cursor prediction feature
		const configService = accessor.get(IConfigurationService);
		configService.setConfig(ConfigKey.InlineEditsNextCursorPredictionEnabled, true);
		configService.setConfig(ConfigKey.TeamInternal.InlineEditsNextCursorPredictionModelName, 'test-model');
	});

	afterEach(() => {
		disposables.clear();
	});

	describe('404 disabling behavior', () => {
		it('should disable predictor after receiving NotFound response', async () => {
			const predictor = instaService.createInstance(XtabNextCursorPredictor, computeTokens);
			const tracer = createTestLogger();
			const promptPieces = createTestPromptPieces();

			// First verify predictor is enabled
			expect(predictor.determineEnablement()).toBe(NextCursorLinePrediction.OnlyWithEdit);

			// Set up mock to return NotFound
			mockChatMLFetcher.setNextResponse({
				type: ChatFetchResponseType.NotFound,
				reason: 'Model not found',
				requestId: 'test-request-id',
				serverRequestId: 'test-server-request-id'
			});

			// Make a prediction request - should fail with NotFound
			const result = await predictor.predictNextCursorPosition(promptPieces, tracer, undefined, CancellationToken.None);

			expect(result.isError()).toBe(true);
			if (result.isError()) {
				expect(result.err.message).toContain('fetchError:notFound');
			}

			// After NotFound, predictor should be disabled
			expect(predictor.determineEnablement()).toBeUndefined();
		});

		it('should remain disabled for subsequent calls after 404', async () => {
			const predictor = instaService.createInstance(XtabNextCursorPredictor, computeTokens);
			const tracer = createTestLogger();
			const promptPieces = createTestPromptPieces();

			// Set up mock to return NotFound
			mockChatMLFetcher.setNextResponse({
				type: ChatFetchResponseType.NotFound,
				reason: 'Model not found',
				requestId: 'test-request-id',
				serverRequestId: 'test-server-request-id'
			});

			// First call - triggers disabling
			await predictor.predictNextCursorPosition(promptPieces, tracer, undefined, CancellationToken.None);

			// Verify disabled
			expect(predictor.determineEnablement()).toBeUndefined();

			// Even if we change the mock to return success, it should stay disabled
			mockChatMLFetcher.setNextResponse({
				type: ChatFetchResponseType.Success,
				requestId: 'test-request-id',
				serverRequestId: 'test-server-request-id',
				usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } },
				value: '42',
				resolvedModel: 'test-model'
			});

			// determineEnablement should still return undefined (disabled)
			expect(predictor.determineEnablement()).toBeUndefined();
		});

		it('should not disable predictor for other error types', async () => {
			const predictor = instaService.createInstance(XtabNextCursorPredictor, computeTokens);
			const tracer = createTestLogger();
			const promptPieces = createTestPromptPieces();

			// Verify predictor is enabled initially
			expect(predictor.determineEnablement()).toBe(NextCursorLinePrediction.OnlyWithEdit);

			// Set up mock to return a different error type (e.g., NetworkError)
			mockChatMLFetcher.setNextResponse({
				type: ChatFetchResponseType.NetworkError,
				reason: 'Network unavailable',
				requestId: 'test-request-id',
				serverRequestId: 'test-server-request-id'
			});

			// Make a prediction request - should fail but not disable
			const result = await predictor.predictNextCursorPosition(promptPieces, tracer, undefined, CancellationToken.None);

			expect(result.isError()).toBe(true);
			if (result.isError()) {
				expect(result.err.message).toContain('fetchError:networkError');
			}

			// Predictor should still be enabled after non-404 error
			expect(predictor.determineEnablement()).toBe(NextCursorLinePrediction.OnlyWithEdit);
		});

		it('should return success result when prediction succeeds', async () => {
			const predictor = instaService.createInstance(XtabNextCursorPredictor, computeTokens);
			const tracer = createTestLogger();
			const promptPieces = createTestPromptPieces();

			// Set up mock to return success with line number
			mockChatMLFetcher.setNextResponse({
				type: ChatFetchResponseType.Success,
				requestId: 'test-request-id',
				serverRequestId: 'test-server-request-id',
				usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_tokens_details: { cached_tokens: 0 } },
				value: '0',
				resolvedModel: 'test-model'
			});

			const result = await predictor.predictNextCursorPosition(promptPieces, tracer, undefined, CancellationToken.None);

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
				expect(result.val).toBe(0);
			}

			// Predictor should still be enabled
			expect(predictor.determineEnablement()).toBe(NextCursorLinePrediction.OnlyWithEdit);
		});
	});
});
