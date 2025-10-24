/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import Sinon from 'sinon';
import { ResultType } from '../ghostText/ghostText';
import { telemetryShown } from '../ghostText/telemetry';
import { getInlineCompletions } from '../inlineCompletion';
import { Fetcher, FetchOptions, Response } from '../networking';
import { CompletionRequest, LiveOpenAIFetcher, OpenAIFetcher } from '../openai/fetch';
import { LocationFactory } from '../textDocument';
import { Deferred, delay } from '../util/async';
import { createLibTestingContext } from './context';
import { createFakeCompletionResponse, StaticFetcher } from './fetcher';
import { withInMemoryTelemetry } from './telemetry';
import { createTextDocument } from './textDocument';

suite('getInlineCompletions()', function () {
	function setupCompletion(
		fetcher: Fetcher,
		docText = 'function example() {\n\n}',
		position = LocationFactory.position(1, 0),
		languageId = 'typescript'
	) {
		const ctx = createLibTestingContext();
		const doc = createTextDocument('file:///example.ts', languageId, 1, docText);
		ctx.forceSet(Fetcher, fetcher);
		ctx.set(OpenAIFetcher, new LiveOpenAIFetcher()); // gets results from static fetcher

		// Setup closures with the state as default
		function requestInlineCompletions(textDoc = doc, pos = position) {
			return getInlineCompletions(ctx, textDoc, pos);
		}

		return {
			ctx,
			doc,
			position,
			requestInlineCompletions,
		};
	}

	test('Sends a speculative request when shown', async function () {
		const firstCompletionText = '\tconst firstVar = 1;';
		const secondCompletionText = '\tconst secondVar = 2;';

		const completionsDeferred = new Deferred<CompletionRequest>();
		const networkResponse = Sinon.stub<[string, FetchOptions], Response>().returns(
			createFakeCompletionResponse('// not expected!')
		);
		networkResponse.onFirstCall().returns(createFakeCompletionResponse(firstCompletionText));
		networkResponse.onSecondCall().callsFake((_url, opts) => {
			completionsDeferred.resolve(opts.json as CompletionRequest);
			return createFakeCompletionResponse(secondCompletionText);
		});
		const { ctx, doc, position, requestInlineCompletions } = setupCompletion(new StaticFetcher(networkResponse));

		const { reporter, result } = await withInMemoryTelemetry(ctx, async () => {
			const firstResponse = await requestInlineCompletions();

			assert.strictEqual(firstResponse?.length, 1);
			assert.strictEqual(firstResponse[0].insertText, firstCompletionText);
			telemetryShown(ctx, 'ghostText', firstResponse[0]);

			// We're expecting 2 completion requests: one we explicitly requested, and a follow-up speculative request in the background.
			return await completionsDeferred.promise;
		});

		const expectedPrefix = doc.getText({ start: { line: 0, character: 0 }, end: position }) + firstCompletionText;
		assert.ok(result.prompt.endsWith(expectedPrefix), 'Expect first completion in second request');

		const issuedTelemetry = reporter.eventsMatching(event => event.name === 'ghostText.issued');
		assert.strictEqual(issuedTelemetry.length, 2, `Expected 2 issued events, got ${issuedTelemetry.length}`);

		const speculativeTelemetry = reporter.eventsMatching(
			event => event.name === 'ghostText.issued' && event.properties['reason'] === 'speculative'
		);
		assert.ok(speculativeTelemetry.length === 1, 'Expected one speculative request');
	});

	test('speculative requests apply completions the same as the editor and CLS', async function () {
		const firstCompletion = '    const firstVar = 1;';
		const secondCompletion = '\n    const secondVar = 2;';
		const completionsDeferred = new Deferred<void>();
		const networkResponse = Sinon.stub<[], Response>().returns(createFakeCompletionResponse('// not expected!'));
		networkResponse.onFirstCall().returns(createFakeCompletionResponse(firstCompletion));
		networkResponse.onSecondCall().callsFake(() => {
			completionsDeferred.resolve();
			return createFakeCompletionResponse(secondCompletion);
		});
		const { ctx, doc, position, requestInlineCompletions } = setupCompletion(
			new StaticFetcher(networkResponse),
			'function example() {\n    \n}\n',
			LocationFactory.position(1, 4)
		);

		const response = await requestInlineCompletions();

		assert.strictEqual(response?.length, 1);
		assert.strictEqual(response[0].insertText, firstCompletion);
		assert.deepStrictEqual(response[0].range, LocationFactory.range(LocationFactory.position(1, 0), position));

		telemetryShown(ctx, 'ghostText', response[0]);
		await completionsDeferred.promise; // Wait for speculative request to be sent

		const docv2 = createTextDocument(
			doc.uri,
			doc.clientLanguageId,
			doc.version + 1,
			`function example() {\n${firstCompletion}\n}\n`
		);
		const position2 = LocationFactory.position(1, firstCompletion.length);
		const response2 = await requestInlineCompletions(docv2, position2);

		assert.strictEqual(response2?.length, 1);
		assert.strictEqual(response2[0].insertText, firstCompletion + secondCompletion);
		assert.deepStrictEqual(
			response2[0].range,
			LocationFactory.range(LocationFactory.position(1, 0), LocationFactory.position(1, firstCompletion.length))
		);
		assert.strictEqual(response2[0].resultType, ResultType.Cache);
		assert.strictEqual(networkResponse.callCount, 2);
	});

	test('does not send a speculative request if empty', async function () {
		const { ctx, requestInlineCompletions } = setupCompletion(
			new StaticFetcher(() => createFakeCompletionResponse(''))
		);

		const { reporter, result } = await withInMemoryTelemetry(ctx, () => {
			return requestInlineCompletions();
		});

		assert.strictEqual(result, undefined);
		const issuedTelemetry = reporter.eventsMatching(event => event.name === 'ghostText.issued');
		assert.strictEqual(issuedTelemetry.length, 1, `Expected 1 issued events, got ${issuedTelemetry.length}`);
		const speculativeTelemetry = reporter.eventsMatching(
			event => event.name === 'ghostText.issued' && event.properties['reason'] === 'speculative'
		);
		assert.ok(speculativeTelemetry.length === 0, 'Expected no speculative request');
	});

	test('telemetryShown triggers speculative request only when shown', async function () {
		const firstCompletionText = '\tconst firstVar = 1;';
		const secondCompletionText = '\tconst secondVar = 2;';
		const completionsDeferred = new Deferred<CompletionRequest>();
		const networkResponse = Sinon.stub<[string, FetchOptions], Response>().returns(
			createFakeCompletionResponse('// not expected!')
		);
		networkResponse.onFirstCall().returns(createFakeCompletionResponse(firstCompletionText));
		networkResponse.onSecondCall().callsFake((_url, opts) => {
			completionsDeferred.resolve(opts.json as CompletionRequest);
			return createFakeCompletionResponse(secondCompletionText);
		});

		const { ctx, requestInlineCompletions } = setupCompletion(new StaticFetcher(networkResponse));

		const { reporter } = await withInMemoryTelemetry(ctx, async () => {
			const firstResponse = await requestInlineCompletions();
			assert.strictEqual(firstResponse?.length, 1);
			assert.strictEqual(firstResponse[0].insertText, firstCompletionText);

			// Verify speculative request is not made before shown
			await delay(50);
			assert.strictEqual(networkResponse.callCount, 1, 'Expected only the initial network call');

			// Call telemetryShown to trigger speculative request
			telemetryShown(ctx, 'ghostText', firstResponse[0]);

			// Wait for speculative request to complete
			return await completionsDeferred.promise;
		});

		assert.strictEqual(networkResponse.callCount, 2, 'Expected 2 network calls (original + speculative)');
		const shownTelemetry = reporter.eventsMatching(event => event.name === 'ghostText.shown');
		assert.strictEqual(shownTelemetry.length, 1, 'Expected one shown telemetry event');
		const speculativeTelemetry = reporter.eventsMatching(
			event => event.name === 'ghostText.issued' && event.properties['reason'] === 'speculative'
		);
		assert.ok(speculativeTelemetry.length === 1, 'Expected one speculative request');
	});
});
