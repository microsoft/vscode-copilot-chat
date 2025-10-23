/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionsAuthenticationServiceBridge } from '../../../bridge/src/completionsAuthenticationServiceBridge';
import { Context } from '../context';
import { CopilotToken } from '../../../../../../platform/authentication/common/copilotToken';

export function onCopilotToken(ctx: Context, listener: (token: Omit<CopilotToken, "token">) => unknown) {
	return ctx.get(CompletionsAuthenticationServiceBridge).authenticationService.onDidAuthenticationChange(() => {
		const copilotToken = getLastCopilotToken(ctx);
		if (copilotToken) {
			listener(copilotToken);
		}
	});
}

export function getLastCopilotToken(ctx: Context): Omit<CopilotToken, "token"> | undefined {
	return ctx.get(CompletionsAuthenticationServiceBridge).authenticationService.copilotToken;
}
