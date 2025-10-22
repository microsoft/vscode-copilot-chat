/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotToken } from '../../../lib/src/auth/copilotTokenManager';
import { onCopilotToken } from '../../../lib/src/auth/copilotTokenNotifier';
import type { Context } from '../../../lib/src/context';
import { codeReferenceLogger } from '../../../lib/src/snippy/logger';
import { isRunningInTest } from '../../../lib/src/testing/runtimeMode';
import { Disposable } from 'vscode';
import { registerCodeRefEngagementTracker } from './codeReferenceEngagementTracker';

export class CodeReference {
	subscriptions: Disposable | undefined;
	event?: Disposable;
	enabled: boolean = false;

	constructor(readonly ctx: Context) { }

	dispose() {
		this.subscriptions?.dispose();
		this.event?.dispose();
	}

	register() {
		if (!isRunningInTest(this.ctx)) {
			this.event = onCopilotToken(this.ctx, this.onCopilotToken);
		}
		return this;
	}

	addDisposable(disposable: Disposable) {
		if (!this.subscriptions) {
			this.subscriptions = Disposable.from(disposable);
		} else {
			this.subscriptions = Disposable.from(this.subscriptions, disposable);
		}
	}

	onCopilotToken = (token: Omit<CopilotToken, "token">) => {
		this.enabled = token.codeQuoteEnabled || false;
		if (!token.codeQuoteEnabled) {
			this.subscriptions?.dispose();
			this.subscriptions = undefined;
			codeReferenceLogger.debug(this.ctx, 'Public code references are disabled.');
			return;
		}

		codeReferenceLogger.info(this.ctx, 'Public code references are enabled.');

		this.addDisposable(registerCodeRefEngagementTracker(this.ctx));
	};
}
