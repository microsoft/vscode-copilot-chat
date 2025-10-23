/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../../lib/src/context';
import { NotificationSender } from '../../../lib/src/notificationSender';
import { OutputPaneShowCommand } from '../../../lib/src/snippy/constants';
import { matchNotificationTelemetry, TelemetryActor } from '../../../lib/src/snippy/telemetryHandlers';
import { commands, env, Uri } from 'vscode';
import { Extension } from '../extensionContext';

const matchCodeMessage =
	'We found a reference to public code in a recent suggestion. To learn more about public code references, review the [documentation](https://aka.ms/github-copilot-match-public-code).';
const MatchAction = 'View reference';
const SettingAction = 'Change setting';
const CodeReferenceKey = 'codeReference.notified';

/**
 * Displays a toast notification when the first code reference is found.
 * The user will only ever see a single notification of this behavior.
 * Displays the output panel on notification ack.
 */
export function notify(ctx: Context) {
	const extension = ctx.get(Extension);
	const didNotify = extension.context.globalState.get<boolean>(CodeReferenceKey);

	if (didNotify) {
		return;
	}

	const notificationSender = ctx.get(NotificationSender);

	const messageItems = [{ title: MatchAction }, { title: SettingAction }];

	void notificationSender.showWarningMessage(matchCodeMessage, ...messageItems).then(async action => {
		const event = { context: ctx, actor: 'user' as TelemetryActor };

		switch (action?.title) {
			case MatchAction: {
				matchNotificationTelemetry.handleDoAction(event);
				await commands.executeCommand(OutputPaneShowCommand);
				break;
			}
			case SettingAction: {
				await env.openExternal(Uri.parse('https://aka.ms/github-copilot-settings'));
				break;
			}
			case undefined: {
				matchNotificationTelemetry.handleDismiss(event);
				break;
			}
		}
	});

	return extension.context.globalState.update(CodeReferenceKey, true);
}
