/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import sinon from 'sinon';
import { ExtensionContext, ExtensionMode, commands, env } from 'vscode';
import { ICompletionsContextService } from '../../../../lib/src/context';
import { NotificationSender } from '../../../../lib/src/notificationSender';
import { OutputPaneShowCommand } from '../../../../lib/src/snippy/constants';
import { withInMemoryTelemetry } from '../../../../lib/src/test/telemetry';
import { TestNotificationSender } from '../../../../lib/src/test/testHelpers';
import { Extension } from '../../extensionContext';
import { createExtensionTestingContext } from '../../test/context';
import { notify } from '../matchNotifier';

/**
 * Minimal fake implementation of the VS Code globalState object.
 */
class FakeGlobalState {
	#state = new Map<string, unknown>();

	get(key: string) {
		return this.#state.get(key);
	}

	async update(key: string, value: unknown) {
		return new Promise(resolve => {
			this.#state.set(key, value);
			resolve(void 0);
		});
	}
}

suite('.match', function () {
	let ctx: ICompletionsContextService;

	setup(function () {
		ctx = createExtensionTestingContext();
		ctx.forceSet(
			Extension,
			new Extension({
				extensionMode: ExtensionMode.Test,
				subscriptions: [] as { dispose(): void }[],
				extension: { id: 'copilot.extension-test' },
				globalState: new FakeGlobalState(),
			} as unknown as ExtensionContext)
		);
	});

	test('populates the globalState object', async function () {
		const extensionContext = ctx.get(Extension);
		const globalState = extensionContext.context.globalState;

		await notify(ctx);

		assert.ok(globalState.get('codeReference.notified'));
	});

	test('notifies the user', async function () {
		const testNotificationSender = ctx.get(NotificationSender) as TestNotificationSender;
		testNotificationSender.performAction('View reference');

		await notify(ctx);

		assert.strictEqual(testNotificationSender.sentMessages.length, 1);
	});

	test('sends a telemetry event on view reference action', async function () {
		const testNotificationSender = ctx.get(NotificationSender) as TestNotificationSender;
		testNotificationSender.performAction('View reference');

		const telemetry = await withInMemoryTelemetry(ctx, async ctx => {
			await notify(ctx);
		});

		assert.strictEqual(telemetry.reporter.events.length, 1);
		assert.strictEqual(telemetry.reporter.events[0].name, 'code_referencing.match_notification.acknowledge.count');
	});

	test('executes the output panel display command on view reference action', async function () {
		const spy = sinon.spy(commands, 'executeCommand');
		const testNotificationSender = ctx.get(NotificationSender) as TestNotificationSender;
		testNotificationSender.performAction('View reference');

		await notify(ctx);

		await testNotificationSender.waitForMessages();

		assert.ok(spy.calledOnce);
		assert.ok(spy.calledWith(OutputPaneShowCommand));

		spy.restore();
	});

	test('opens the settings page on change setting action', async function () {
		const stub = sinon.stub(env, 'openExternal');
		const testNotificationSender = ctx.get(NotificationSender) as TestNotificationSender;
		testNotificationSender.performAction('Change setting');

		await notify(ctx);

		await testNotificationSender.waitForMessages();

		assert.ok(stub.calledOnce);
		assert.ok(
			stub.calledWith(
				sinon.match({
					scheme: 'https',
					authority: 'aka.ms',
					path: '/github-copilot-settings',
				})
			)
		);

		stub.restore();
	});

	test('sends a telemetry event on notification dismissal', async function () {
		const testNotificationSender = ctx.get(NotificationSender) as TestNotificationSender;
		testNotificationSender.performDismiss();

		const telemetry = await withInMemoryTelemetry(ctx, async ctx => {
			await notify(ctx);
		});

		await testNotificationSender.waitForMessages();

		assert.strictEqual(telemetry.reporter.events.length, 1);
		assert.strictEqual(telemetry.reporter.events[0].name, 'code_referencing.match_notification.ignore.count');
	});

	test('does not notify if already notified', async function () {
		const extensionContext = ctx.get(Extension);
		const globalState = extensionContext.context.globalState;
		const testNotificationSender = ctx.get(NotificationSender) as TestNotificationSender;
		testNotificationSender.performAction('View reference');

		await globalState.update('codeReference.notified', true);

		await notify(ctx);

		await testNotificationSender.waitForMessages();

		assert.strictEqual(testNotificationSender.sentMessages.length, 0);
	});
});
