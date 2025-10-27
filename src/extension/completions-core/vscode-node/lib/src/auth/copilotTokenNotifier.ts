/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotToken } from '../../../../../../platform/authentication/common/copilotToken';
import { CompletionsAuthenticationServiceBridge } from '../../../bridge/src/completionsAuthenticationServiceBridge';
import { ICompletionsContextService } from '../context';

export function onCopilotToken(ctx: ICompletionsContextService, listener: (token: Omit<CopilotToken, "token">) => unknown) {
	return ctx.get(CompletionsAuthenticationServiceBridge).authenticationService.onDidAuthenticationChange(() => {
		const copilotToken = getLastCopilotToken(ctx);
		if (copilotToken) {
			listener(copilotToken);
		}
	});
}

export function getLastCopilotToken(ctx: ICompletionsContextService): Omit<CopilotToken, "token"> | undefined {
	return ctx.get(CompletionsAuthenticationServiceBridge).authenticationService.copilotToken;
}
