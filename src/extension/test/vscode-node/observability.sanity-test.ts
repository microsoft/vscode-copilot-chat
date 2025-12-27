/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IChatRequestFinishedEvent, IChatRequestStartedEvent, IObservabilityService } from '../../../platform/observability/common/observabilityService';
import { SpyChatResponseStream } from '../../../util/common/test/mockChatResponseStream';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Intent } from '../../common/constants';
import { ConversationFeature } from '../../conversation/vscode-node/conversationFeature';
import { activate } from '../../extension/vscode-node/extension';
import type { Turn } from '../../prompt/common/conversation';
import { ChatParticipantRequestHandler } from '../../prompt/node/chatParticipantRequestHandler';
import type { CommandDetails } from '../../prompt/node/intentRegistry';
import type { IIntent } from '../../prompt/node/intents';
import { TestChatRequest } from '../node/testHelpers';

// Test-only helper type to stub the private `ChatParticipantRequestHandler.selectIntent(...)` method.
// We keep it strongly typed here (matching the real signature), but still need a cast to access it
// because the method is private and therefore not visible on the public class type.
type SelectIntentStubTarget = {
	selectIntent: (command: CommandDetails | undefined, history: Turn[]) => Promise<IIntent>;
};

function stubSelectIntent(testSandbox: sinon.SinonSandbox, intent: IIntent): void {
	const proto = ChatParticipantRequestHandler.prototype as unknown as SelectIntentStubTarget;
	testSandbox.stub(proto, 'selectIntent').resolves(intent);
}

suite('Copilot Chat Observability Sanity Test', function () {
	this.timeout(1000 * 60 * 1); // 1 minute

	let realInstaAccessor: IInstantiationService;
	let realContext: vscode.ExtensionContext;
	let sandbox: sinon.SinonSandbox;
	const fakeToken = CancellationToken.None;

	suiteSetup(async function () {
		sandbox = sinon.createSandbox();
		sandbox.stub(vscode.commands, 'registerCommand').returns({ dispose: () => { } });
		sandbox.stub(vscode.workspace, 'registerFileSystemProvider').returns({ dispose: () => { } });
		const extension = vscode.extensions.getExtension('Github.copilot-chat');
		assert.ok(extension, 'Extension is not available');
		realContext = await extension.activate();
		assert.ok(realContext, '`extension.activate()` did not return context`');
		assert.ok(realContext.extensionMode, 'extension context does not have `extensionMode`');
		const activateResult = await activate(realContext, true);
		assert.ok(activateResult, 'Activation result is not available');
		assert.strictEqual(typeof (activateResult as IInstantiationService).createInstance, 'function', 'createInstance is not a function');
		assert.strictEqual(typeof (activateResult as IInstantiationService).invokeFunction, 'function', 'invokeFunction is not a function');
		realInstaAccessor = activateResult as IInstantiationService;
	});

	suiteTeardown(async function () {
		sandbox.restore();
		// Dispose of all subscriptions
		realContext.subscriptions.forEach((sub) => {
			try {
				sub.dispose();
			} catch (e) {
				console.error(e);
			}
		});
	});

	test('hooks emit request lifecycle (no content leak)', async function () {
		assert.ok(realInstaAccessor, 'Instantiation service accessor is not available');

		await realInstaAccessor.invokeFunction(async (accessor) => {
			const instaService = accessor.get(IInstantiationService);
			const observabilityService = accessor.get(IObservabilityService);
			const conversationFeature = instaService.createInstance(ConversationFeature);

			const started: IChatRequestStartedEvent[] = [];
			const finished: IChatRequestFinishedEvent[] = [];

			const startDisposable = observabilityService.onDidStartChatRequest(e => started.push(e));
			const finishDisposable = observabilityService.onDidFinishChatRequest(e => finished.push(e));
			try {
				conversationFeature.activated = true;
				const stream = new SpyChatResponseStream();
				const interactiveSession = instaService.createInstance(
					ChatParticipantRequestHandler,
					[],
					new TestChatRequest('What is 1+1?'),
					stream,
					fakeToken,
					{ agentName: '', agentId: '', intentId: Intent.Agent },
					Event.None
				);

				const result = await interactiveSession.getResult();

				assert.strictEqual(started.length, 1, 'Expected exactly one start event');
				assert.strictEqual(finished.length, 1, 'Expected exactly one finish event');

				assert.strictEqual(started[0].requestId, result.metadata.responseId);
				assert.strictEqual(started[0].result.status, 'started');

				assert.strictEqual(finished[0].requestId, result.metadata.responseId);
				assert.ok(['success', 'cancelled', 'error'].includes(finished[0].result.status), 'Unexpected finish status');

				// Guardrails: only requestId + result should be present.
				assert.deepStrictEqual(Object.keys(started[0]).sort(), ['requestId', 'result']);
				assert.deepStrictEqual(Object.keys(finished[0]).sort(), ['requestId', 'result']);
				assert.ok(!('prompt' in started[0]) && !('message' in started[0]) && !('request' in started[0]));
				assert.ok(!('prompt' in finished[0]) && !('message' in finished[0]) && !('request' in finished[0]));
			} finally {
				conversationFeature.activated = false;
				startDisposable.dispose();
				finishDisposable.dispose();
			}
		});
	});

	test('finish status is cancelled when token is cancelled', async function () {
		assert.ok(realInstaAccessor, 'Instantiation service accessor is not available');

		await realInstaAccessor.invokeFunction(async (accessor) => {
			const instaService = accessor.get(IInstantiationService);
			const observabilityService = accessor.get(IObservabilityService);
			const conversationFeature = instaService.createInstance(ConversationFeature);

			const started: IChatRequestStartedEvent[] = [];
			const finished: IChatRequestFinishedEvent[] = [];
			const tokenSource = new CancellationTokenSource();
			const testSandbox = sinon.createSandbox();

			const startDisposable = observabilityService.onDidStartChatRequest(e => started.push(e));
			const finishDisposable = observabilityService.onDidFinishChatRequest(e => finished.push(e));
			try {
				conversationFeature.activated = true;

				const cancellationTestIntent: IIntent = {
					id: 'test.cancelledToken',
					description: 'test.cancelledToken',
					locations: [ChatLocation.Panel],
					invoke: async (_invocationContext) => {
						throw new Error('invoke should not be called');
					},
					handleRequest: async () => {
						throw new Error('boom');
					}
				};
				stubSelectIntent(testSandbox, cancellationTestIntent);

				// Ensure the catch-block classifies cancellation based on the token.
				tokenSource.cancel();

				const stream = new SpyChatResponseStream();
				const interactiveSession = instaService.createInstance(
					ChatParticipantRequestHandler,
					[],
					new TestChatRequest('Trigger cancellation'),
					stream,
					tokenSource.token,
					{ agentName: '', agentId: '', intentId: Intent.Agent },
					Event.None
				);

				await assert.rejects(interactiveSession.getResult());

				assert.strictEqual(started.length, 1, 'Expected exactly one start event');
				assert.strictEqual(finished.length, 1, 'Expected exactly one finish event');
				assert.strictEqual(started[0].requestId, finished[0].requestId);
				assert.strictEqual(finished[0].result.status, 'cancelled');
			} finally {
				conversationFeature.activated = false;
				tokenSource.dispose();
				testSandbox.restore();
				startDisposable.dispose();
				finishDisposable.dispose();
			}
		});
	});

	test('finish status is error when request throws', async function () {
		assert.ok(realInstaAccessor, 'Instantiation service accessor is not available');

		await realInstaAccessor.invokeFunction(async (accessor) => {
			const instaService = accessor.get(IInstantiationService);
			const observabilityService = accessor.get(IObservabilityService);
			const conversationFeature = instaService.createInstance(ConversationFeature);

			const started: IChatRequestStartedEvent[] = [];
			const finished: IChatRequestFinishedEvent[] = [];
			const testSandbox = sinon.createSandbox();

			const startDisposable = observabilityService.onDidStartChatRequest(e => started.push(e));
			const finishDisposable = observabilityService.onDidFinishChatRequest(e => finished.push(e));
			try {
				conversationFeature.activated = true;

				const errorThrowingIntent: IIntent = {
					id: 'test.error',
					description: 'test.error',
					locations: [ChatLocation.Panel],
					invoke: async (_invocationContext) => {
						throw new Error('invoke should not be called');
					},
					handleRequest: async () => {
						throw new Error('boom');
					}
				};
				stubSelectIntent(testSandbox, errorThrowingIntent);

				const stream = new SpyChatResponseStream();
				const interactiveSession = instaService.createInstance(
					ChatParticipantRequestHandler,
					[],
					new TestChatRequest('Trigger error'),
					stream,
					fakeToken,
					{ agentName: '', agentId: '', intentId: Intent.Agent },
					Event.None
				);

				await assert.rejects(interactiveSession.getResult(), /boom/);

				assert.strictEqual(started.length, 1, 'Expected exactly one start event');
				assert.strictEqual(finished.length, 1, 'Expected exactly one finish event');
				assert.strictEqual(started[0].requestId, finished[0].requestId);
				assert.strictEqual(finished[0].result.status, 'error');
			} finally {
				conversationFeature.activated = false;
				testSandbox.restore();
				startDisposable.dispose();
				finishDisposable.dispose();
			}
		});
	});

	test('isCancellationMessage heuristic classifies cancellation messages as cancelled', async function () {
		assert.ok(realInstaAccessor, 'Instantiation service accessor is not available');

		await realInstaAccessor.invokeFunction(async (accessor) => {
			const instaService = accessor.get(IInstantiationService);
			const observabilityService = accessor.get(IObservabilityService);
			const conversationFeature = instaService.createInstance(ConversationFeature);

			const started: IChatRequestStartedEvent[] = [];
			const finished: IChatRequestFinishedEvent[] = [];
			const testSandbox = sinon.createSandbox();

			const startDisposable = observabilityService.onDidStartChatRequest(e => started.push(e));
			const finishDisposable = observabilityService.onDidFinishChatRequest(e => finished.push(e));
			try {
				conversationFeature.activated = true;

				const cancellationMessageIntent: IIntent = {
					id: 'test.cancellationMessage',
					description: 'test.cancellationMessage',
					locations: [ChatLocation.Panel],
					invoke: async (_invocationContext) => {
						throw new Error('invoke should not be called');
					},
					handleRequest: async () => {
						throw new Error('Canceled');
					}
				};
				stubSelectIntent(testSandbox, cancellationMessageIntent);

				const stream = new SpyChatResponseStream();
				const interactiveSession = instaService.createInstance(
					ChatParticipantRequestHandler,
					[],
					new TestChatRequest('Trigger cancellation by message'),
					stream,
					fakeToken,
					{ agentName: '', agentId: '', intentId: Intent.Agent },
					Event.None
				);

				await assert.rejects(interactiveSession.getResult(), /Canceled/);

				assert.strictEqual(started.length, 1, 'Expected exactly one start event');
				assert.strictEqual(finished.length, 1, 'Expected exactly one finish event');
				assert.strictEqual(started[0].requestId, finished[0].requestId);
				assert.strictEqual(finished[0].result.status, 'cancelled');
			} finally {
				conversationFeature.activated = false;
				testSandbox.restore();
				startDisposable.dispose();
				finishDisposable.dispose();
			}
		});
	});
});
