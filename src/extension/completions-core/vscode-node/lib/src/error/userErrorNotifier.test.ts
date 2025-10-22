/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../context';
import { UserErrorNotifier } from './userErrorNotifier';
import { LogLevel, LogTarget } from '../logger';
import { NotificationSender } from '../notificationSender';
import { createLibTestingContext } from '../testing/context';
import { TestLogTarget } from '../testing/loggerHelpers';
import { TestNotificationSender, TestUrlOpener } from '../testing/testHelpers';
import { UrlOpener } from '../util/opener';
import * as assert from 'assert';

suite('Translate errors for end-users', function () {
	const expectedErrorMessage = `Your proxy connection requires a trusted certificate. Please make sure the proxy certificate and any issuers are configured correctly and trusted by your operating system.`;

	let notifier: UserErrorNotifier;
	let ctx: Context;
	let testLogTarget: TestLogTarget;
	let testNotificationSender: TestNotificationSender;

	const createError = (code: string) => {
		const error: NodeJS.ErrnoException = new Error(code);
		error.code = code;
		return error;
	};

	setup(function () {
		ctx = createLibTestingContext();
		notifier = new UserErrorNotifier();
		testNotificationSender = ctx.get(NotificationSender) as TestNotificationSender;
		testLogTarget = new TestLogTarget();
		ctx.forceSet(LogTarget, testLogTarget);
	});

	test('translates tunnel errors for self-signed certifcate and logs', function () {
		const error = createError('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
		notifier.notifyUser(ctx, error);

		assertLogs(error);
	});

	test('translates tunnel errors once', function () {
		notifier.notifyUser(ctx, createError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
		notifier.notifyUser(ctx, createError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));

		assert.deepStrictEqual(testNotificationSender.sentMessages.length, 1);
	});

	test('translates tunnel errors for self-signed certifcate and notifies user', async function () {
		notifier.notifyUser(ctx, createError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));

		assert.deepStrictEqual(testNotificationSender.sentMessages[0], expectedErrorMessage);
		await assertNotifiesUser();
	});

	test('translates helix fetch errors for self-signed certifcate and logs', function () {
		const error = createError('CERT_SIGNATURE_FAILURE');
		notifier.notifyUser(ctx, error);

		assertLogs(error);
	});

	test('translates helix fetch errors once', function () {
		notifier.notifyUser(ctx, createError('CERT_SIGNATURE_FAILURE'));
		notifier.notifyUser(ctx, createError('CERT_SIGNATURE_FAILURE'));

		assert.deepStrictEqual(testNotificationSender.sentMessages.length, 1);
	});

	test('translates helix fetch errors for self-signed certifcate and notifies user', async function () {
		notifier.notifyUser(ctx, createError('CERT_SIGNATURE_FAILURE'));

		assert.deepStrictEqual(testNotificationSender.sentMessages[0], expectedErrorMessage);
		await assertNotifiesUser();
	});

	test('does not log unknown errors', function () {
		const actualError = new Error();

		notifier.notifyUser(ctx, actualError);

		assert.ok(testLogTarget.isEmpty());
	});

	const assertNotifiesUser = async () => {
		// the test notificationSender automatically triggers the first action which opens the url
		await testNotificationSender.waitForMessages();
		const opener = ctx.get(UrlOpener) as TestUrlOpener;
		assert.deepStrictEqual(opener.openedUrls, ['https://gh.io/copilot-network-errors']);
	};

	const assertLogs = (error: Error) => {
		assert.ok(
			testLogTarget.hasMessage(
				LogLevel.ERROR,
				`${expectedErrorMessage} Please visit https://gh.io/copilot-network-errors to learn more. Original cause:`,
				error
			)
		);
	};
});
