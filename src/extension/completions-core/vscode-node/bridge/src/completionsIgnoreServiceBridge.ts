/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IIgnoreService } from '../../../../../platform/ignore/common/ignoreService';
export class CompletionsIgnoreServiceBridge {
	constructor(
		@IIgnoreService public readonly ignoreService: IIgnoreService
	) { }
}