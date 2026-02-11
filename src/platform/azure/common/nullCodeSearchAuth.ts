/*---------------------------------------------------------------------------------------------
 *  Null Code Search Authentication Service
 *  Replaces VsCodeCodeSearchAuthenticationService which prompts GitHub sign-in.
 *  All auth methods are no-ops since we use Azure-only auth.
 *--------------------------------------------------------------------------------------------*/

import { ICodeSearchAuthenticationService } from '../../remoteCodeSearch/node/codeSearchRepoAuth';
import { ResolvedRepoRemoteInfo } from '../../git/common/gitService';

export class NullCodeSearchAuthenticationService implements ICodeSearchAuthenticationService {

	declare readonly _serviceBrand: undefined;

	async tryAuthenticating(_repo: ResolvedRepoRemoteInfo | undefined): Promise<void> {
		// No-op: Azure-only fork does not use GitHub code search auth
	}

	async tryReauthenticating(_repo: ResolvedRepoRemoteInfo | undefined): Promise<void> {
		// No-op: Azure-only fork does not use GitHub code search auth
	}

	async promptForExpandedLocalIndexing(_fileCount: number): Promise<boolean> {
		// Always allow expanded local indexing since we don't have remote
		return true;
	}
}
