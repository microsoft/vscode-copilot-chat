/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotToken, createTestExtendedTokenInfo } from '../../authentication/common/copilotToken';
import { StaticGitHubAuthenticationService } from '../../authentication/common/staticGitHubAuthenticationService';

/**
 * Scenario automation variant of {@link StaticGitHubAuthenticationService}.
 *
 * In scenario automation (msbench) the copilot token is typically a noAuth
 * token.  This override replaces noAuth tokens with a placeholder so that
 * downstream services (e.g. {@link ScenarioAutomationEndpointProviderImpl})
 * that check `copilotToken?.isNoAuthUser` behave correctly.
 */
export class ScenarioAutomationAuthenticationService extends StaticGitHubAuthenticationService {

	override get copilotToken(): CopilotToken | undefined {
		const token = this._tokenStore.copilotToken;
		if (token?.isNoAuthUser) {
			return new CopilotToken(createTestExtendedTokenInfo());
		}
		return token;
	}
}
