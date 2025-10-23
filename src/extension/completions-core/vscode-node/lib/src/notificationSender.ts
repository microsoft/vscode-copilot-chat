/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { window } from 'vscode';

export interface ActionItem {
	title: string;
	[key: string]: string | boolean | object;
}
export abstract class NotificationSender {
	abstract showWarningMessage(message: string, ...actions: ActionItem[]): Promise<ActionItem | undefined>;
}

export class ExtensionNotificationSender extends NotificationSender {
	async showWarningMessage(message: string, ...actions: ActionItem[]): Promise<ActionItem | undefined> {
		const response = await window.showWarningMessage(message, ...actions.map(action => action.title));
		if (response === undefined) { return; }
		return { title: response };
	}
}
