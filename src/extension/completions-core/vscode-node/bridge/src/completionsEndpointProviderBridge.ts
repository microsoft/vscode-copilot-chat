/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEndpointProvider } from '../../../../../platform/endpoint/common/endpointProvider';

export class CompletionsEndpointProviderBridge {
	constructor(
		@IEndpointProvider public readonly endpointProvider: IEndpointProvider
	) { }
}