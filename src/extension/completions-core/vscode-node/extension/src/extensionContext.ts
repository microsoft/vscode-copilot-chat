/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCodeExtensionContext } from '../../../../../platform/extContext/common/extensionContext';

/**
 * Provides access to the ExtensionContext gotten from the VS Code Extension
 * API as an argument to activate().
 */
export class Extension {
	constructor(@IVSCodeExtensionContext readonly context: IVSCodeExtensionContext) { }
}
