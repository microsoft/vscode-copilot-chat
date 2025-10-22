/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';

export class CompletionsAuthenticationServiceBridge {
	constructor(
		@IAuthenticationService public readonly authenticationService: IAuthenticationService
	) { }
}