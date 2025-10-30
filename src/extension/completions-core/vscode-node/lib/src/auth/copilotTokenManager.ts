/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthenticationService } from '../../../../../../platform/authentication/common/authentication';
import { CopilotToken } from '../../../../../../platform/authentication/common/copilotToken';
import { ThrottledDelayer } from '../../../../../../util/vs/base/common/async';
import { Disposable } from '../../../../../../util/vs/base/common/lifecycle';
import { CompletionsAuthenticationServiceBridge } from '../../../bridge/src/completionsAuthenticationServiceBridge';
import { ICompletionsContextService } from '../context';
export { CopilotToken } from '../../../../../../platform/authentication/common/copilotToken';

export abstract class CopilotTokenManager extends Disposable {
	public abstract get token(): CopilotToken | undefined;
	public abstract primeToken(): Promise<boolean>;
	public abstract getToken(): Promise<CopilotToken>;
	public abstract resetToken(httpError?: number): void;
	public abstract getLastToken(): Omit<CopilotToken, "token"> | undefined;
}

export class CopilotTokenManagerImpl extends CopilotTokenManager {

	private readonly authenticationService: IAuthenticationService;
	private tokenRefetcher = new ThrottledDelayer(5_000);
	private _token: CopilotToken | undefined;
	get token() {
		void this.tokenRefetcher.trigger(() => this.updateCachedToken());
		return this._token;
	}

	constructor(
		protected primed = false,
		@ICompletionsContextService protected ctx: ICompletionsContextService,
	) {
		super();

		this.authenticationService = ctx.get(CompletionsAuthenticationServiceBridge).authenticationService;
		this.updateCachedToken();
		this._register(this.authenticationService.onDidAuthenticationChange(() => this.updateCachedToken()));
	}

	/**
	 * Ensure we have a token and that the `StatusReporter` is up to date.
	 */
	primeToken(): Promise<boolean> {
		try {
			return this.getToken().then(
				() => true,
				() => false
			);
		} catch (e) {
			return Promise.resolve(false);
		}
	}

	async getToken(): Promise<CopilotToken> {
		return this.updateCachedToken();
	}

	private async updateCachedToken(): Promise<CopilotToken> {
		this._token = await this.authenticationService.getCopilotToken();
		return this._token;
	}

	resetToken(httpError?: number): void {
		this.authenticationService.resetCopilotToken();
	}

	getLastToken(): Omit<CopilotToken, "token"> | undefined {
		return this.authenticationService.copilotToken;
	}
}
