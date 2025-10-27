/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotToken, type ExtendedTokenInfo, type TokenInfo } from '../../../../../../platform/authentication/common/copilotToken';
import { generateUuid } from '../../../../../../util/vs/base/common/uuid';
import { CopilotTokenManager } from '../auth/copilotTokenManager';
import type { Context } from '../context';

// Buffer to allow refresh to happen successfully
export class FakeCopilotTokenManager extends CopilotTokenManager {

	private _token: CopilotToken;

	constructor(protected ctx: Context) {
		super();
		this._token = FakeCopilotTokenManager.createTestCopilotToken({ token: 'tid=test;rt=1' });
	}

	get token(): CopilotToken | undefined {
		return this._token;
	}

	primeToken(): Promise<boolean> {
		return Promise.resolve(true);
	}

	async getToken(): Promise<CopilotToken> {
		return this._token;
	}

	resetToken(httpError?: number): void {
	}

	getLastToken(): Omit<CopilotToken, "token"> | undefined {
		return this._token;
	}

	private static readonly REFRESH_BUFFER_SECONDS = 60;
	private static createTestCopilotToken(tokenInfo?: Partial<Omit<TokenInfo, 'expires_at'>>): CopilotToken {
		const expires_at = Date.now() + ((tokenInfo?.refresh_in ?? 0) + FakeCopilotTokenManager.REFRESH_BUFFER_SECONDS) * 1000;
		const realToken: ExtendedTokenInfo = {
			token: `test token ${generateUuid()}`,
			username: 'testuser',
			isVscodeTeamMember: false,
			copilot_plan: 'free',
			refresh_in: 0,
			expires_at,
			...tokenInfo
		};
		return new CopilotToken(realToken);
	}
}
