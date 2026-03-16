/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DocumentId } from '../../../../platform/inlineEdits/common/dataTypes/documentId';
import { LanguageId } from '../../../../platform/inlineEdits/common/dataTypes/languageId';
import { IObservableDocument } from '../../../../platform/inlineEdits/common/observableWorkspace';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import { TelemetryEventProperties } from '../../../../platform/telemetry/common/telemetry';
import { observableValue } from '../../../../util/vs/base/common/observableInternal/observables/observableValue';
import { OffsetRange } from '../../../../util/vs/editor/common/core/ranges/offsetRange';
import { StringText } from '../../../../util/vs/editor/common/core/text/abstractText';
import { NextEditProviderTelemetryBuilder, TelemetrySender } from '../../node/nextEditProviderTelemetry';
import { INextEditResult } from '../../node/nextEditResult';

class RecordingTelemetryService extends NullTelemetryService {
	readonly enhancedEvents: { eventName: string; properties?: TelemetryEventProperties }[] = [];

	override sendEnhancedGHTelemetryEvent(eventName: string, properties?: TelemetryEventProperties): void {
		this.enhancedEvents.push({ eventName, properties });
	}
}

function createMockDocument(text = 'hello world'): IObservableDocument & { setValue: (t: StringText) => void } {
	const value = observableValue<StringText, any>('value', new StringText(text));
	const selection = observableValue<readonly OffsetRange[]>('selection', []);
	const visibleRanges = observableValue<readonly OffsetRange[]>('visibleRanges', []);
	const languageId = observableValue<LanguageId>('languageId', LanguageId.create('typescript'));
	const version = observableValue<number>('version', 1);
	const diagnostics = observableValue<readonly unknown[]>('diagnostics', []);

	return {
		id: DocumentId.create('file:///test.ts'),
		value,
		selection,
		visibleRanges,
		languageId,
		version,
		diagnostics: diagnostics as IObservableDocument['diagnostics'],
		setValue: (t: StringText) => { value.set(t, undefined, undefined as any); },
	};
}

function createMockNextEditResult(): INextEditResult {
	return { requestId: 1, result: undefined };
}

function createMockBuilder(doc?: IObservableDocument): NextEditProviderTelemetryBuilder {
	// Pass `undefined` for doc to avoid edit tracking (which crashes on mock value changes).
	// We override the `doc` getter to still expose the document for idle detection.
	const builder = new NextEditProviderTelemetryBuilder(
		undefined, // gitExtensionService
		undefined, // notebookService
		undefined, // workspaceService
		'test-provider',
		undefined, // no doc for edit tracking
	);
	if (doc) {
		Object.defineProperty(builder, 'doc', { get: () => doc });
	}
	return builder;
}

describe('TelemetrySender', () => {
	let telemetryService: RecordingTelemetryService;
	let sender: TelemetrySender;

	beforeEach(() => {
		vi.useFakeTimers();
		telemetryService = new RecordingTelemetryService();
		// Construct directly — the @ITelemetryService decorator is just metadata
		sender = new TelemetrySender(telemetryService);
	});

	afterEach(() => {
		sender.dispose();
		vi.useRealTimers();
	});

	describe('scheduleSendingEnhancedTelemetry', () => {
		const initialTimeoutMs = 2 * 60 * 1000; // matches production value

		test('sends after initial timeout + idle period when no document', async () => {
			const result = createMockNextEditResult();
			const builder = createMockBuilder(undefined); // no doc

			sender.scheduleSendingEnhancedTelemetry(result, builder);
			expect(telemetryService.enhancedEvents).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(initialTimeoutMs / 2);
			expect(telemetryService.enhancedEvents).toHaveLength(0);
			await vi.advanceTimersByTimeAsync(initialTimeoutMs / 2);

			// No doc → sends immediately after initial timeout
			expect(telemetryService.enhancedEvents).toHaveLength(1);
			expect(telemetryService.enhancedEvents[0].eventName).toBe('copilot-nes/provideInlineEdit');
		});

		test('sends after initial timeout + 5s idle when user is not typing', async () => {
			const doc = createMockDocument();
			const result = createMockNextEditResult();
			const builder = createMockBuilder(doc);

			sender.scheduleSendingEnhancedTelemetry(result, builder);
			expect(telemetryService.enhancedEvents).toHaveLength(0);

			await vi.advanceTimersByTimeAsync(initialTimeoutMs);
			expect(telemetryService.enhancedEvents).toHaveLength(0);

			// Advance 5s — idle timer fires
			await vi.advanceTimersByTimeAsync(5_000);
			expect(telemetryService.enhancedEvents).toHaveLength(1);
		});

		test('resets idle timer when user types during idle phase', async () => {
			const doc = createMockDocument();
			const result = createMockNextEditResult();
			const builder = createMockBuilder(doc);

			sender.scheduleSendingEnhancedTelemetry(result, builder);

			await vi.advanceTimersByTimeAsync(initialTimeoutMs);
			expect(telemetryService.enhancedEvents).toHaveLength(0);

			// Wait 3s, then simulate typing
			await vi.advanceTimersByTimeAsync(3_000);
			doc.setValue(new StringText('hello world edited'));

			// 3s after typing → still not sent
			await vi.advanceTimersByTimeAsync(3_000);
			expect(telemetryService.enhancedEvents).toHaveLength(0);

			// 2 more seconds → 5s since last activity → sends
			await vi.advanceTimersByTimeAsync(2_000);
			expect(telemetryService.enhancedEvents).toHaveLength(1);
		});

		test('hard cap sends after 30s even if user keeps typing', async () => {
			const doc = createMockDocument();
			const result = createMockNextEditResult();
			const builder = createMockBuilder(doc);

			sender.scheduleSendingEnhancedTelemetry(result, builder);

			await vi.advanceTimersByTimeAsync(initialTimeoutMs);

			// Simulate continuous typing every 2s for 30s
			for (let i = 0; i < 15; i++) {
				await vi.advanceTimersByTimeAsync(2_000);
				doc.setValue(new StringText(`edit ${i}`));
			}

			expect(telemetryService.enhancedEvents).toHaveLength(1);
		});

		test('does not send twice', async () => {
			const doc = createMockDocument();
			const result = createMockNextEditResult();
			const builder = createMockBuilder(doc);

			sender.scheduleSendingEnhancedTelemetry(result, builder);

			await vi.advanceTimersByTimeAsync(initialTimeoutMs + 5_000);
			expect(telemetryService.enhancedEvents).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(30_000);
			expect(telemetryService.enhancedEvents).toHaveLength(1);
		});

		test('dispose cancels pending initial timeout', async () => {
			const result = createMockNextEditResult();
			const builder = createMockBuilder(undefined);

			sender.scheduleSendingEnhancedTelemetry(result, builder);
			sender.dispose();

			await vi.advanceTimersByTimeAsync(initialTimeoutMs + 5_000 + 30_000);
			expect(telemetryService.enhancedEvents).toHaveLength(0);
		});

		test('dispose during idle-wait phase cancels idle timers and subscription', async () => {
			const doc = createMockDocument();
			const result = createMockNextEditResult();
			const builder = createMockBuilder(doc);

			sender.scheduleSendingEnhancedTelemetry(result, builder);

			// Advance past the 2-minute timeout to enter idle-wait phase
			await vi.advanceTimersByTimeAsync(initialTimeoutMs);
			expect(telemetryService.enhancedEvents).toHaveLength(0);

			// Dispose during idle-wait phase (before 5s idle timer fires)
			sender.dispose();

			// Advance past both idle timer and hard cap — nothing should be sent
			await vi.advanceTimersByTimeAsync(5_000 + 30_000);
			expect(telemetryService.enhancedEvents).toHaveLength(0);
		});
	});
});
