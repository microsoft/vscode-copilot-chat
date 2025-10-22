/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Encapsulates all the functionality related opening urls in a browser.
 */
export abstract class UrlOpener {
	abstract open(target: string): Promise<void>;
}
