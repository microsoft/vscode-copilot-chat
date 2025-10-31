/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vscode';
import { CopilotToken } from '../../../lib/src/auth/copilotTokenManager';
import { onCopilotToken } from '../../../lib/src/auth/copilotTokenNotifier';
import { ICompletionsContextService } from '../../../lib/src/context';
import { codeReferenceLogger } from '../../../lib/src/snippy/logger';
import { ICompletionsRuntimeModeService } from '../../../lib/src/util/runtimeMode';
import { registerCodeRefEngagementTracker } from './codeReferenceEngagementTracker';
import { IInstantiationService } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { LogTarget } from '../../../lib/src/logger';

export class CodeReference {
	subscriptions: Disposable | undefined;
	event?: Disposable;
	enabled: boolean = false;

	constructor(
		@ICompletionsContextService private readonly ctx: ICompletionsContextService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICompletionsRuntimeModeService readonly _runtimeMode: ICompletionsRuntimeModeService,
	) { }

	dispose() {
		this.subscriptions?.dispose();
		this.event?.dispose();
	}

	register() {
		if (!this._runtimeMode.isRunningInTest()) {
			this.event = this._instantiationService.invokeFunction(onCopilotToken, this.onCopilotToken);
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
		const logTarget = this.ctx.get(LogTarget);
		this.enabled = token.codeQuoteEnabled || false;
		if (!token.codeQuoteEnabled) {
			this.subscriptions?.dispose();
			this.subscriptions = undefined;
			codeReferenceLogger.debug(logTarget, 'Public code references are disabled.');
			return;
		}

		codeReferenceLogger.info(logTarget, 'Public code references are enabled.');
		this.addDisposable(registerCodeRefEngagementTracker(this._instantiationService));
	};
}
