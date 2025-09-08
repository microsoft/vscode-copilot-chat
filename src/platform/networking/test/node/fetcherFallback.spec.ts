/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Readable } from 'stream';
import { suite, test } from 'vitest';
import { FakeHeaders } from '../../../test/node/fetcher';
import { TestLogService } from '../../../testing/common/testLogService';
import { FetchOptions, Response } from '../../common/fetcherService';
import { IFetcher } from '../../common/networking';
import { fetchWithFallbacks } from '../../node/fetcherFallback';

suite('FetcherFallback Test Suite', function () {

	const logService = new TestLogService();
	const someHTML = '<html>...</html>';
	const someJSON = '{"key": "value"}';

	test('first fetcher succeeds', async function () {
		const fetcherSpec = [
			{ name: 'fetcher1', response: createFakeResponse(200, someJSON) },
			{ name: 'fetcher2', response: createFakeResponse(200, someJSON) },
		];
		const testFetchers = createTestFetchers(fetcherSpec);
		const { response, updatedFetchers } = await fetchWithFallbacks(testFetchers.fetchers, 'https://example.com', { expectJSON: true, retryFallbacks: true }, logService);
		assert.deepStrictEqual(testFetchers.calls.map(c => c.name), fetcherSpec.slice(0, 1).map(f => f.name)); // only first fetcher called
		assert.strictEqual(updatedFetchers, undefined);
		assert.strictEqual(response.status, 200);
		const json = await response.json();
		assert.deepStrictEqual(json, JSON.parse(someJSON));
	});

	test('first fetcher is retried to confirm failure', async function () {
		const fetcherSpec = [
			{ name: 'fetcher1', response: createFakeResponse(200, someHTML) },
			{ name: 'fetcher2', response: createFakeResponse(200, someJSON) },
			{ name: 'fetcher1', response: createFakeResponse(200, someHTML) },
		];
		const testFetchers = createTestFetchers(fetcherSpec);
		const { response, updatedFetchers } = await fetchWithFallbacks(testFetchers.fetchers, 'https://example.com', { expectJSON: true, retryFallbacks: true }, logService);
		assert.deepStrictEqual(testFetchers.calls.map(c => c.name), fetcherSpec.map(f => f.name));
		assert.ok(updatedFetchers);
		assert.strictEqual(updatedFetchers[0], testFetchers.fetchers[1]);
		assert.strictEqual(updatedFetchers[1], testFetchers.fetchers[0]);
		assert.strictEqual(response.status, 200);
		const json = await response.json();
		assert.deepStrictEqual(json, JSON.parse(someJSON));
	});

	test('no fetcher succeeds', async function () {
		const fetcherSpec = [
			{ name: 'fetcher1', response: createFakeResponse(407, someHTML) },
			{ name: 'fetcher2', response: createFakeResponse(401, someJSON) },
		];
		const testFetchers = createTestFetchers(fetcherSpec);
		const { response, updatedFetchers } = await fetchWithFallbacks(testFetchers.fetchers, 'https://example.com', { expectJSON: true, retryFallbacks: true }, logService);
		assert.deepStrictEqual(testFetchers.calls.map(c => c.name), fetcherSpec.map(f => f.name));
		assert.strictEqual(updatedFetchers, undefined);
		assert.strictEqual(response.status, 407);
		const text = await response.text();
		assert.deepStrictEqual(text, someHTML);
	});

	test('all fetchers throw', async function () {
		const fetcherSpec = [
			{ name: 'fetcher1', response: new Error('fetcher1 error') },
			{ name: 'fetcher2', response: new Error('fetcher2 error') },
		];
		const testFetchers = createTestFetchers(fetcherSpec);
		try {
			await fetchWithFallbacks(testFetchers.fetchers, 'https://example.com', { expectJSON: true, retryFallbacks: true }, logService);
			assert.fail('Expected to throw');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.strictEqual(err.message, 'fetcher1 error');
			assert.deepStrictEqual(testFetchers.calls.map(c => c.name), fetcherSpec.map(f => f.name));
		}
	});
});

function createTestFetchers(fetcherSpecs: Array<{ name: string; response: Response | Error }>) {
	const calls: Array<{ name: string; url: string; options: FetchOptions }> = [];
	const responseQueues = new Map<string, (Response | Error)[]>();
	const order: string[] = [];
	for (const spec of fetcherSpecs) {
		let list = responseQueues.get(spec.name);
		if (!list) {
			list = [];
			responseQueues.set(spec.name, list);
			order.push(spec.name); // record first appearance order
		}
		list.push(spec.response);
	}
	const fetchers: IFetcher[] = [];
	for (const name of order) {
		const queue = responseQueues.get(name)!;
		fetchers.push({
			getUserAgentLibrary: () => name,
			fetch: async (url: string, options: FetchOptions) => {
				calls.push({ name, url, options });
				const next = queue.shift();
				if (!next) {
					throw new Error('No more queued responses for ' + name);
				}
				if (next instanceof Error) {
					throw next;
				}
				return next;
			},
			disconnectAll: async () => { },
			makeAbortController: () => { throw new Error('Method not implemented.'); },
			isAbortError: () => false,
			isInternetDisconnectedError: () => false,
			isFetcherError: () => false,
			getUserMessageForFetcherError: () => 'error'
		});
	}
	return { fetchers, calls };
}

function createFakeResponse(statusCode: number, content: string) {
	return new Response(
		statusCode,
		'status text',
		new FakeHeaders(),
		() => Promise.resolve(content),
		() => Promise.resolve(JSON.parse(content)),
		async () => Readable.from([content])
	);
}
