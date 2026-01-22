/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';

export const IChatContextCounterStatus = createServiceIdentifier<IChatContextCounterStatus>('IChatContextCounterStatus');

/**
 * Surface for reporting prompt context usage (token-based) to a UI component.
 *
 * This interface intentionally lives in the `common` layer so that `node` code can depend on it
 * without importing from the `vscode-node` layer.
 */
export interface IChatContextCounterStatus {
	readonly _serviceBrand: undefined;

	update(usage: number, limit: number | undefined): void;
	clear(): void;
}
