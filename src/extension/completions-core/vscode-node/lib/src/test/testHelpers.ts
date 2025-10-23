/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ActionItem, NotificationSender } from '../notificationSender';
import { IPosition, IRange } from '../textDocument';
import { Deferred } from '../util/async';
import { UrlOpener } from '../util/opener';

export function positionToString(p: IPosition) {
	return `${p.line}:${p.character}`;
}

export function rangeToString(r: IRange) {
	return `[${positionToString(r.start)}--${positionToString(r.end)}]`;
}

export function restoreEnvAfterTest() {
	const origEnv: typeof process.env = { ...process.env };
	teardown(function () {
		// remove any keys that were added
		for (const key of Object.keys(process.env)) {
			if (!(key in origEnv)) {
				delete process.env[key];
			}
		}

		// restore the original values
		for (const key of Object.keys(origEnv)) {
			process.env[key] = origEnv[key];
		}
	});
}

export class TestUrlOpener extends UrlOpener {
	readonly openedUrls: string[] = [];
	readonly opened = new Deferred<void>();

	open(target: string) {
		this.openedUrls.push(target);
		this.opened.resolve();
		return Promise.resolve();
	}
}

export class TestNotificationSender extends NotificationSender {
	readonly sentMessages: string[] = [];
	protected warningPromises: Promise<ActionItem | undefined>[] = [];
	protected informationPromises: Promise<ActionItem | undefined>[] = [];
	protected actionToPerform: string | undefined;

	constructor() {
		super();
	}

	performDismiss() {
		this.actionToPerform = 'DISMISS';
	}

	performAction(title: string) {
		this.actionToPerform = title;
	}

	showWarningMessage(message: string, ...actions: ActionItem[]): Promise<ActionItem | undefined> {
		this.sentMessages.push(message);

		let warningPromise: Promise<ActionItem | undefined>;
		if (this.actionToPerform) {
			if (this.actionToPerform === 'DISMISS') {
				warningPromise = Promise.resolve(undefined);
			} else {
				const action = actions.find(a => a.title === this.actionToPerform);
				warningPromise = action ? Promise.resolve(action) : Promise.resolve(undefined);
			}
		} else {
			// If not set, default to the first action
			warningPromise = actions ? Promise.resolve(actions[0]) : Promise.resolve(undefined);
		}

		this.warningPromises.push(warningPromise);
		return warningPromise;
	}

	showInformationMessage(message: string, ...actions: ActionItem[]): Promise<ActionItem | undefined> {
		this.sentMessages.push(message);

		let informationPromise: Promise<ActionItem | undefined>;
		if (this.actionToPerform) {
			if (this.actionToPerform === 'DISMISS') {
				informationPromise = Promise.resolve(undefined);
			} else {
				const action = actions.find(a => a.title === this.actionToPerform);
				informationPromise = action ? Promise.resolve(action) : Promise.resolve(undefined);
			}
		} else {
			// If not set, default to the first action
			informationPromise = actions ? Promise.resolve(actions[0]) : Promise.resolve(undefined);
		}

		this.informationPromises.push(informationPromise);
		return informationPromise;
	}

	showInformationModal(message: string, ...actions: ActionItem[]): Promise<ActionItem | undefined> {
		return this.showInformationMessage(message, ...actions);
	}

	async waitForMessages() {
		await Promise.all(this.warningPromises);
		await Promise.all(this.informationPromises);
	}
}
