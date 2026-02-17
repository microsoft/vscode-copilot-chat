/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';

export const ICustomSessionTitleService = createServiceIdentifier<ICustomSessionTitleService>('ICustomSessionTitleService');

export interface ICustomSessionTitleService {
	readonly _serviceBrand: undefined;

	getCustomSessionTitle(sessionId: string): string | undefined;
	setCustomSessionTitle(sessionId: string, title: string): Promise<void>;
	removeCustomSessionTitle(sessionId: string): Promise<void>;
}
