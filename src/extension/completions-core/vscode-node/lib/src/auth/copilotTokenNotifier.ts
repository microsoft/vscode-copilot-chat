/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotToken } from '../../../../../../platform/authentication/common/copilotToken';
import { IInstantiationService, ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { CompletionsAuthenticationServiceBridge } from '../../../bridge/src/completionsAuthenticationServiceBridge';
import { ICompletionsContextService } from '../context';

export function onCopilotToken(accessor: ServicesAccessor, listener: (token: Omit<CopilotToken, "token">) => unknown) {
	const instantiationService = accessor.get(IInstantiationService);
	return accessor.get(ICompletionsContextService).get(CompletionsAuthenticationServiceBridge).authenticationService.onDidAuthenticationChange(() => {
		const copilotToken = instantiationService.invokeFunction(getLastCopilotToken);
		if (copilotToken) {
			listener(copilotToken);
		}
	});
}

export function getLastCopilotToken(accessor: ServicesAccessor): Omit<CopilotToken, "token"> | undefined {
	return accessor.get(ICompletionsContextService).get(CompletionsAuthenticationServiceBridge).authenticationService.copilotToken;
}
