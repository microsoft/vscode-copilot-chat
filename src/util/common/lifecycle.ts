/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BugIndicatingError, onUnexpectedError } from '../vs/base/common/errors';
import { DisposableStore } from '../vs/base/common/lifecycle';

export function assertStoreNotDisposed(store: DisposableStore): void {
	if (store.isDisposed) {
		onUnexpectedError(new BugIndicatingError('Object disposed'));
	}
}