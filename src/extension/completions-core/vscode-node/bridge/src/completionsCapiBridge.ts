/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICAPIClientService } from '../../../../../platform/endpoint/common/capiClient';
export class CompletionsCapiBridge {
	constructor(
		@ICAPIClientService public readonly capiClientService: ICAPIClientService,
	) { }
}