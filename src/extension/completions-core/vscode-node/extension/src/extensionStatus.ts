/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Command, StatusKind } from '../../types/src';

export class CopilotExtensionStatus {
	constructor(
		public kind: StatusKind = 'Normal',
		public message?: string,
		public busy = false,
		public command?: Command
	) { }
}
