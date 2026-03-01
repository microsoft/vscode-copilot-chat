/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator as createServiceIdentifier } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ResolvedRepoRemoteInfo } from '../../git/common/gitService';

export const ICodeSearchAuthenticationService = createServiceIdentifier<ICodeSearchAuthenticationService>('ICodeSearchAuthentication');

export interface ICodeSearchAuthenticationService {
	readonly _serviceBrand: undefined;

	tryAuthenticating(repo: ResolvedRepoRemoteInfo | undefined): Promise<void>;
	tryReauthenticating(repo: ResolvedRepoRemoteInfo | undefined): Promise<void>;

	promptForExpandedLocalIndexing(fileCount: number): Promise<boolean>;
}

export class BasicCodeSearchAuthenticationService implements ICodeSearchAuthenticationService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IAuthenticationService private readonly _authenticationService: IAuthenticationService,
	) { }

	async tryAuthenticating(remoteInfo: ResolvedRepoRemoteInfo | undefined): Promise<void> {
		if (remoteInfo?.repoId?.type === 'ado') {
			await this._authenticationService.getAdoAccessTokenBase64({ createIfNone: true });
			return;
		}

		await this._authenticationService.getGitHubSession('any', { createIfNone: true });
	}

	async tryReauthenticating(remoteInfo: ResolvedRepoRemoteInfo | undefined): Promise<void> {
		if (remoteInfo?.repoId?.type === 'ado') {
			await this._authenticationService.getAdoAccessTokenBase64({ createIfNone: true });
			return;
		}

		await this._authenticationService.getGitHubSession('permissive', { createIfNone: true });
	}

	async promptForExpandedLocalIndexing(fileCount: number): Promise<boolean> {
		// Can't show prompt here
		return false;
	}
}