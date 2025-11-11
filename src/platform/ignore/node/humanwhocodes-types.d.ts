/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Workaround for https://github.com/microsoft/typescript-go/issues/2050

declare module '@humanwhocodes/gitignore-to-minimatch' {
	export function gitignoreToMinimatch(pattern: string): string;
}