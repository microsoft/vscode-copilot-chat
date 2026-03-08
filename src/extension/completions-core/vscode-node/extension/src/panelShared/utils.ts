/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../../../util/vs/base/common/uuid';

export function getNonce() {
	return generateUuid().replace(/-/g, '');
}

export function pluralize(count: number, noun: string, suffix = 's') {
	return `${count} ${noun}${count !== 1 ? suffix : ''}`;
}
