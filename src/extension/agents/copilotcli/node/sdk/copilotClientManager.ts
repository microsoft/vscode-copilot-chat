/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotClient, CopilotClientOptions } from '@github/copilot-sdk';
import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';
import { ILogService } from '../../../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../../../util/common/services';
import { Lazy } from '../../../../../util/vs/base/common/lazy';
import { Disposable } from '../../../../../util/vs/base/common/lifecycle';

export interface ICopilotClientManager {
	readonly _serviceBrand: undefined;
	getClient(): Promise<CopilotClient>;
	stop(): Promise<void>;
}

export const ICopilotClientManager = createServiceIdentifier<ICopilotClientManager>('ICopilotClientManager');

export class CopilotClientManager extends Disposable implements ICopilotClientManager {
	declare _serviceBrand: undefined;

	private readonly _client: Lazy<Promise<CopilotClient>>;

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._client = new Lazy<Promise<CopilotClient>>(() => this._createClient());
	}

	private async _createClient(): Promise<CopilotClient> {
		try {
			const copilotToken = await this.authenticationService.getGitHubSession('any', { silent: true });
			const githubToken = copilotToken?.accessToken ?? '';

			const options: CopilotClientOptions = {
				useStdio: true,
				autoStart: true,
				autoRestart: true,
				githubToken,
			};

			const client = new CopilotClient(options);
			await client.start();

			return client;
		} catch (error) {
			this.logService.error(error, '[CopilotClientManager] Failed to create CopilotClient');
			throw error;
		}
	}

	async getClient(): Promise<CopilotClient> {
		return this._client.value;
	}

	async stop(): Promise<void> {
		if (this._client.hasValue) {
			try {
				const client = await this._client.value;
				await client.stop();
			} catch (error) {
				this.logService.error(error, '[CopilotClientManager] Failed to stop CopilotClient');
			}
		}
	}

	override dispose(): void {
		void this.stop();
		super.dispose();
	}
}
