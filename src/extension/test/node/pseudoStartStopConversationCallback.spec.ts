/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { afterEach, beforeEach, suite, test } from 'vitest';
import type { ChatVulnerability } from 'vscode';
import { IResponsePart } from '../../../platform/chat/common/chatMLFetcher';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../platform/configuration/test/common/inMemoryConfigurationService';
import { IResponseDelta } from '../../../platform/networking/common/fetch';
import { createPlatformServices } from '../../../platform/test/node/services';
import { SpyChatResponseStream } from '../../../util/common/test/mockChatResponseStream';
import { AsyncIterableSource } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseMarkdownPart, ChatResponseMarkdownWithVulnerabilitiesPart, ChatResponseThinkingProgressPart } from '../../../vscodeTypes';
import { PseudoStopStartResponseProcessor } from '../../prompt/node/pseudoStartStopConversationCallback';


suite('Post Report Conversation Callback', () => {
	const postReportFn = (deltas: IResponseDelta[]) => {
		return ['<processed>', ...deltas.map(d => d.text), '</processed>'];
	};
	const annotations = [{ id: 123, details: { type: 'type', description: 'description' } }, { id: 456, details: { type: 'type2', description: 'description2' } }];

	let instaService: IInstantiationService;

	beforeEach(() => {
		const accessor = createPlatformServices().createTestingAccessor();
		instaService = accessor.get(IInstantiationService);
	});

	test('Simple post-report', async () => {
		const responseSource = new AsyncIterableSource<IResponsePart>();
		const stream = new SpyChatResponseStream();
		const testObj = instaService.createInstance(PseudoStopStartResponseProcessor,
			[{
				start: 'end',
				stop: 'start'
			}],
			postReportFn);

		responseSource.emitOne({ delta: { text: 'one' } });
		responseSource.emitOne({ delta: { text: ' start ' } });
		responseSource.emitOne({ delta: { text: 'two' } });
		responseSource.emitOne({ delta: { text: ' end' } });
		responseSource.resolve();

		await testObj.doProcessResponse(responseSource.asyncIterable, stream, CancellationToken.None);

		assert.deepStrictEqual(
			stream.items.map(p => (p as ChatResponseMarkdownPart).value.value),
			['one', ' ', '<processed>', ' ', 'two', ' ', '</processed>']);
	});

	test('Partial stop word with extra text before', async () => {
		const responseSource = new AsyncIterableSource<IResponsePart>();
		const stream = new SpyChatResponseStream();
		const testObj = instaService.createInstance(PseudoStopStartResponseProcessor,
			[{
				start: 'end',
				stop: 'start'
			}],
			postReportFn);

		responseSource.emitOne({ delta: { text: 'one sta' } });
		responseSource.emitOne({ delta: { text: 'rt' } });
		responseSource.emitOne({ delta: { text: ' two end' } });
		responseSource.resolve();

		await testObj.doProcessResponse(responseSource.asyncIterable, stream, CancellationToken.None);
		assert.deepStrictEqual(
			stream.items.map(p => (p as ChatResponseMarkdownPart).value.value),
			['one ', '<processed>', ' two ', '</processed>']
		);
	});

	test('Partial stop word with extra text after', async () => {
		const responseSource = new AsyncIterableSource<IResponsePart>();
		const stream = new SpyChatResponseStream();
		const testObj = instaService.createInstance(PseudoStopStartResponseProcessor,
			[{
				start: 'end',
				stop: 'start'
			}],
			postReportFn);

		responseSource.emitOne({ delta: { text: 'one ', codeVulnAnnotations: annotations } });
		responseSource.emitOne({ delta: { text: 'sta' } });
		responseSource.emitOne({ delta: { text: 'rt two' } });
		responseSource.emitOne({ delta: { text: ' end' } });
		responseSource.resolve();

		await testObj.doProcessResponse(responseSource.asyncIterable, stream, CancellationToken.None);
		assert.deepStrictEqual((stream.items[0] as ChatResponseMarkdownWithVulnerabilitiesPart).vulnerabilities, annotations.map(a => ({ title: a.details.type, description: a.details.description } satisfies ChatVulnerability)));

		assert.deepStrictEqual(
			stream.items.map(p => (p as ChatResponseMarkdownPart).value.value),
			['one ', '<processed>', ' two', ' ', '</processed>']);
	});

	test('no second stop word', async () => {
		const responseSource = new AsyncIterableSource<IResponsePart>();
		const stream = new SpyChatResponseStream();
		const testObj = instaService.createInstance(PseudoStopStartResponseProcessor,
			[{
				start: 'end',
				stop: 'start'
			}],
			postReportFn,
		);

		responseSource.emitOne({ delta: { text: 'one' } });
		responseSource.emitOne({ delta: { text: ' start ' } });
		responseSource.emitOne({ delta: { text: 'two' } });
		responseSource.emitOne({ delta: { text: ' ' } });
		responseSource.resolve();

		await testObj.doProcessResponse(responseSource.asyncIterable, stream, CancellationToken.None);
		assert.deepStrictEqual(
			stream.items.map(p => (p as ChatResponseMarkdownPart).value.value),
			['one', ' ']);
	});

	test('Text on same line as start', async () => {
		const responseSource = new AsyncIterableSource<IResponsePart>();
		const stream = new SpyChatResponseStream();
		const testObj = instaService.createInstance(PseudoStopStartResponseProcessor,
			[
				{
					start: 'end',
					stop: 'start'
				}
			],
			postReportFn);

		responseSource.emitOne({ delta: { text: 'this is test text\n\n' } });
		responseSource.emitOne({ delta: { text: 'eeep start\n\n' } });
		responseSource.emitOne({ delta: { text: 'test test test test 123456' } });
		responseSource.emitOne({ delta: { text: 'end\n\nhello' } });
		responseSource.resolve();

		await testObj.doProcessResponse(responseSource.asyncIterable, stream, CancellationToken.None);
		assert.deepStrictEqual(
			stream.items.map(p => (p as ChatResponseMarkdownPart).value.value),
			['this is test text\n\n', 'eeep ', '<processed>', '\n\n', 'test test test test 123456', '</processed>', '\n\nhello']);
	});


	test('Start word without a stop word', async () => {
		const responseSource = new AsyncIterableSource<IResponsePart>();

		const stream = new SpyChatResponseStream();
		const testObj = instaService.createInstance(PseudoStopStartResponseProcessor,
			[{
				start: '[RESPONSE END]',
				stop: '[RESPONSE START]'
			}],
			postReportFn);


		responseSource.emitOne({ delta: { text: `I'm sorry, but as an AI programming assistant, I'm here to provide assistance with software development topics, specifically related to Visual Studio Code. I'm not equipped to provide a definition of a computer. [RESPONSE END]` } });
		responseSource.resolve();

		await testObj.doProcessResponse(responseSource.asyncIterable, stream, CancellationToken.None);
		assert.strictEqual((stream.items[0] as ChatResponseMarkdownPart).value.value, `I'm sorry, but as an AI programming assistant, I'm here to provide assistance with software development topics, specifically related to Visual Studio Code. I'm not equipped to provide a definition of a computer. [RESPONSE END]`);
	});

	afterEach(() => sinon.restore());
});

suite('Thinking Keep Expanded Setting', () => {
	let instaService: IInstantiationService;
	let configService: InMemoryConfigurationService;

	beforeEach(() => {
		const services = createPlatformServices();
		const accessor = services.createTestingAccessor();
		instaService = accessor.get(IInstantiationService);
		configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
	});

	test('sends vscodeReasoningDone when thinkingKeepExpanded is false (default)', async () => {
		// Ensure setting is false (default)
		await configService.setConfig(ConfigKey.ThinkingKeepExpanded, false);

		const responseSource = new AsyncIterableSource<IResponsePart>();
		const stream = new SpyChatResponseStream();
		const testObj = instaService.createInstance(PseudoStopStartResponseProcessor, [], undefined);

		// Emit thinking delta followed by text delta
		responseSource.emitOne({ delta: { thinking: { id: '1', text: 'thinking content' } } });
		responseSource.emitOne({ delta: { text: 'response text' } });
		responseSource.resolve();

		await testObj.doProcessResponse(responseSource.asyncIterable, stream, CancellationToken.None);

		// Find thinking parts
		const thinkingParts = stream.items.filter(p => p instanceof ChatResponseThinkingProgressPart) as ChatResponseThinkingProgressPart[];

		// Should have 2 thinking parts: one with content, one signaling done
		assert.strictEqual(thinkingParts.length, 2, 'Should have 2 thinking parts');

		// First part should have content
		assert.strictEqual(thinkingParts[0].value, 'thinking content');

		// Second part should signal reasoning done
		assert.strictEqual(thinkingParts[1].value, '');
		assert.strictEqual((thinkingParts[1].metadata as any)?.vscodeReasoningDone, true);
	});

	test('does not send vscodeReasoningDone when thinkingKeepExpanded is true', async () => {
		// Set thinkingKeepExpanded to true
		await configService.setConfig(ConfigKey.ThinkingKeepExpanded, true);

		const responseSource = new AsyncIterableSource<IResponsePart>();
		const stream = new SpyChatResponseStream();
		const testObj = instaService.createInstance(PseudoStopStartResponseProcessor, [], undefined);

		// Emit thinking delta followed by text delta
		responseSource.emitOne({ delta: { thinking: { id: '1', text: 'thinking content' } } });
		responseSource.emitOne({ delta: { text: 'response text' } });
		responseSource.resolve();

		await testObj.doProcessResponse(responseSource.asyncIterable, stream, CancellationToken.None);

		// Find thinking parts
		const thinkingParts = stream.items.filter(p => p instanceof ChatResponseThinkingProgressPart) as ChatResponseThinkingProgressPart[];

		// Should have only 1 thinking part (the content), no reasoning done signal
		assert.strictEqual(thinkingParts.length, 1, 'Should have only 1 thinking part when keepExpanded is true');
		assert.strictEqual(thinkingParts[0].value, 'thinking content');
	});

	test('thinking content is always shown regardless of thinkingKeepExpanded setting', async () => {
		// Test with keepExpanded true
		await configService.setConfig(ConfigKey.ThinkingKeepExpanded, true);

		const responseSource1 = new AsyncIterableSource<IResponsePart>();
		const stream1 = new SpyChatResponseStream();
		const testObj1 = instaService.createInstance(PseudoStopStartResponseProcessor, [], undefined);

		responseSource1.emitOne({ delta: { thinking: { id: '1', text: 'thinking A' } } });
		responseSource1.emitOne({ delta: { thinking: { id: '1', text: 'thinking B' } } });
		responseSource1.emitOne({ delta: { text: 'response' } });
		responseSource1.resolve();

		await testObj1.doProcessResponse(responseSource1.asyncIterable, stream1, CancellationToken.None);

		const thinkingParts1 = stream1.items.filter(p => p instanceof ChatResponseThinkingProgressPart) as ChatResponseThinkingProgressPart[];
		assert.strictEqual(thinkingParts1.length, 2, 'Should have 2 thinking parts with keepExpanded true');
		assert.strictEqual(thinkingParts1[0].value, 'thinking A');
		assert.strictEqual(thinkingParts1[1].value, 'thinking B');

		// Test with keepExpanded false
		await configService.setConfig(ConfigKey.ThinkingKeepExpanded, false);

		const responseSource2 = new AsyncIterableSource<IResponsePart>();
		const stream2 = new SpyChatResponseStream();
		const testObj2 = instaService.createInstance(PseudoStopStartResponseProcessor, [], undefined);

		responseSource2.emitOne({ delta: { thinking: { id: '2', text: 'thinking A' } } });
		responseSource2.emitOne({ delta: { thinking: { id: '2', text: 'thinking B' } } });
		responseSource2.emitOne({ delta: { text: 'response' } });
		responseSource2.resolve();

		await testObj2.doProcessResponse(responseSource2.asyncIterable, stream2, CancellationToken.None);

		const thinkingParts2 = stream2.items.filter(p => p instanceof ChatResponseThinkingProgressPart) as ChatResponseThinkingProgressPart[];
		// Should have 3: thinking A, thinking B, reasoning done signal
		assert.strictEqual(thinkingParts2.length, 3, 'Should have 3 thinking parts with keepExpanded false');
		assert.strictEqual(thinkingParts2[0].value, 'thinking A');
		assert.strictEqual(thinkingParts2[1].value, 'thinking B');
		assert.strictEqual((thinkingParts2[2].metadata as any)?.vscodeReasoningDone, true);
	});

	afterEach(() => sinon.restore());
});
