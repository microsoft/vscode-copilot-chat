/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands, window } from 'vscode';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { IIntentDetectionModelManagementService } from '../common/intentDetectionModelManagementService';

const INTENT_MODEL_KEY = 'copilot.intentDetectionModel';

export class IntentDetectionModelManagementService implements IIntentDetectionModelManagementService {
	declare readonly _serviceBrand: undefined;
	private registeredIntentModels: { [intentModelName: string]: { intentModelEndpoint: IChatEndpoint; intentModelVendor: string } } = {};

	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
	) { }

	getRegisteredIntentDetectionModels(): { intentModelName: string; intentModelVendor: string; intentModelEndpoint: IChatEndpoint }[] {
		return Object.entries(this.registeredIntentModels).map(([intentModelName, intentModel]) => ({
			...intentModel,
			intentModelName
		}));
	}

	registerIntentDetectionModel(intentModelName: string, intentModelVendor: string, intentModelEndpoint: IChatEndpoint): void {
		this.registeredIntentModels[intentModelName] = { intentModelEndpoint, intentModelVendor };
	}

	async getIntentDetectionModel(modelName: string, modelVendor: string): Promise<IChatEndpoint | undefined> {
		if (modelVendor === 'copilot') {
			return this.endpointProvider.getChatEndpoint('gpt-4o-mini');
		}

		const intentModel = this._extensionContext.globalState.get<string>(INTENT_MODEL_KEY);
		if (intentModel === undefined) {
			// If no intent model is defined for the current chat model, show an error and prompt the user to set one.
			return await window.showErrorMessage(
				`An intent detection model must be configured for the current chat model (${modelName}).`,
				{
					modal: true,
					detail: 'Please select a BYOK model to use for intent detection. This helps Copilot understand your requests better.'
				},
				'Manage Intent Detection Model'
			).then(async (selection) => {
				if (selection === 'Manage Intent Detection Model') {
					return await commands.executeCommand<Promise<IChatEndpoint | undefined>>('github.copilot.chat.manageIntentDetectionModel');
				}
			});
		}

		return this.registeredIntentModels[intentModel].intentModelEndpoint;
	}

	async setIntentDetectionModel(modelName: string, modelVendor: string, intentModelName: string): Promise<IChatEndpoint> {
		await this._extensionContext.globalState.update(INTENT_MODEL_KEY, intentModelName);
		return this.registeredIntentModels[intentModelName].intentModelEndpoint;
	}
}