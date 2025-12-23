/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { IChatRequestFinishedEvent, IChatRequestStartedEvent, IObservabilityService } from '../../../platform/observability/common/observabilityService';
import { SpyChatResponseStream } from '../../../util/common/test/mockChatResponseStream';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Intent } from '../../common/constants';
import { ConversationFeature } from '../../conversation/vscode-node/conversationFeature';
import { activate } from '../../extension/vscode-node/extension';
import { ChatParticipantRequestHandler } from '../../prompt/node/chatParticipantRequestHandler';
import { TestChatRequest } from '../node/testHelpers';

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
});
