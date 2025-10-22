/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionContext } from 'vscode';

/**
 * Provides access to the ExtensionContext gotten from the VS Code Extension
 * API as an argument to activate().
 */
export class Extension {
	constructor(readonly context: ExtensionContext) { }
}
