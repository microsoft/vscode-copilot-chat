/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { createServiceIdentifier } from '../../../util/common/services';
import { ICAPIClientService } from './capiClient';

export const IAutomodeService = createServiceIdentifier<IAutomodeService>('IInteractionService');

export interface IAutomodeService {
	readonly _serviceBrand: undefined;

	getAutoModeToken(conversationId: string): Promise<string>;
}

export class AutomodeService implements IAutomodeService {
	readonly _serviceBrand: undefined;

	constructor(
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService
	) {
		this._serviceBrand = undefined;
	}

	async getAutoModeToken(conversationId: string): Promise<string> {
		const response = await this._capiClientService.makeRequest<Response>({ json: {}, method: 'POST' }, { type: RequestType.AutoModels });
		const data = await response.json();
		console.log(data);
		// Implementation for getting the auto mode token
		return 'auto-mode-token';
	}
}