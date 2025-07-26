/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { window } from 'vscode';
import { TaskSingler } from '../../../util/common/taskSingler';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { BaseOctoKitService } from '../../github/common/githubService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { CopilotToken, ExtendedTokenInfo, TokenErrorNotificationId, TokenInfoOrError } from '../common/copilotToken';
import { nowSeconds } from '../common/copilotTokenManager';
import { BaseCopilotTokenManager } from '../node/copilotTokenManager';
import { getAnyAuthSession } from './session';

//Flag if we've shown message about broken oauth token.
let shown401Message = false;

export class NotSignedUpError extends Error { }
export class SubscriptionExpiredError extends Error { }
export class ContactSupportError extends Error { }
export class EnterpriseManagedError extends Error { }
export class ChatDisabledError extends Error { }

export class VSCodeCopilotTokenManager extends BaseCopilotTokenManager {
	private _taskSingler = new TaskSingler<TokenInfoOrError>();

	constructor(
		@ILogService logService: ILogService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IDomainService domainService: IDomainService,
		@ICAPIClientService capiClientService: ICAPIClientService,
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService,
		@IConfigurationService protected readonly configurationService: IConfigurationService
	) {
		super(new BaseOctoKitService(capiClientService, fetcherService), logService, telemetryService, domainService, capiClientService, fetcherService, envService);
	}

	async getCopilotToken(force?: boolean): Promise<CopilotToken> {
		if (!this.copilotToken || this.copilotToken.expires_at - (60 * 5 /* 5min */) < nowSeconds() || force) {
			try {
				this._logService.debug(`Getting CopilotToken (force: ${force})...`);
				this.copilotToken = await this._authShowWarnings();
				this._logService.debug(`Got CopilotToken (force: ${force}).`);
			} catch (e) {
				this._logService.debug(`Getting CopilotToken (force: ${force}) threw error: ${e}`);
				this.copilotToken = undefined;
				throw e;
			}
		}
		return new CopilotToken(this.copilotToken);
	}

	private async _auth(): Promise<TokenInfoOrError> {
		const session = await getAnyAuthSession(this.configurationService, { silent: true });
		if (!session) {
			this._logService.warn('GitHub login failed');
			this._telemetryService.sendGHTelemetryErrorEvent('auth.github_login_failed');
			return { kind: 'failure', reason: 'GitHubLoginFailed' };
		}
		// Log the steps by default, but only log actual token values when the log level is set to debug.
		this._logService.info(`Logged in as ${session.account.label}`);
		const tokenResult = await this.authFromGitHubToken(session.accessToken);
		if (tokenResult.kind === 'success') {
			this._logService.info(`Got Copilot token for ${session.account.label}`);
		}
		return tokenResult;
	}

	private async _authShowWarnings(): Promise<ExtendedTokenInfo> {
		const tokenResult = await this._taskSingler.getOrCreate('auth', () => this._auth());

		if (tokenResult.kind === 'failure' && tokenResult.reason === 'NotAuthorized') {
			const message = tokenResult.message;
			switch (tokenResult.notification_id) {
				case TokenErrorNotificationId.NotSignedUp:
				case TokenErrorNotificationId.NoCopilotAccess:
					throw new NotSignedUpError(message ?? 'User not authorized');
				case TokenErrorNotificationId.SubscriptionEnded:
					throw new SubscriptionExpiredError(message);
				case TokenErrorNotificationId.EnterPriseManagedUserAccount:
					throw new EnterpriseManagedError(message);
				case TokenErrorNotificationId.ServerError:
				case TokenErrorNotificationId.FeatureFlagBlocked:
				case TokenErrorNotificationId.SpammyUser:
				case TokenErrorNotificationId.SnippyNotConfigured:
					throw new ContactSupportError(message);
			}
		}
		if (tokenResult.kind === 'failure' && tokenResult.reason === 'HTTP401') {
			const message =
				'Your GitHub token is invalid. Please sign out from your GitHub account using the VS Code accounts menu and try again.';
			if (!shown401Message) {
				shown401Message = true;
				window.showWarningMessage(message);
			}
			throw Error(message);
		}

		if (tokenResult.kind === 'failure' && tokenResult.reason === 'GitHubLoginFailed') {
			throw Error('GitHubLoginFailed');
		}

		if (tokenResult.kind === 'failure' && tokenResult.reason === 'RateLimited') {
			throw Error("Your account has exceeded GitHub's API rate limit. Please try again later.");
		}

		if (tokenResult.kind === 'failure') {
			throw Error('Failed to get copilot token');
		}

		if (tokenResult.kind === 'success' && tokenResult.chat_enabled === false) {
			throw new ChatDisabledError('Copilot Chat is disabled');
		}

		return tokenResult;
	}
}
