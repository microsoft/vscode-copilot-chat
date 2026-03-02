/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isAbsolute } from 'path';
import { IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { INSTRUCTIONS_LOCATION_KEY } from '../../../../platform/customInstructions/common/promptTypes';
import { INativeEnvService } from '../../../../platform/env/common/envService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { isObject } from '../../../../util/vs/base/common/types';
import { URI } from '../../../../util/vs/base/common/uri';

// const COPILOT_CUSTOM_INSTRUCTIONS_DIRS_ENV_VAR = 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS';

export interface ICopilotCLIInstructions extends Disposable {
	readonly _serviceBrand: undefined;
	getInstructionLocations(): Promise<URI[]>;
}


export const ICopilotCLIInstructions = createServiceIdentifier<ICopilotCLIInstructions>('ICopilotCLIInstructions');

export class CopilotCLIInstructions extends Disposable implements ICopilotCLIInstructions {
	readonly _serviceBrand: undefined;
	private _instructionLocations?: Promise<URI[]>;
	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeEnvService private readonly envService: INativeEnvService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(INSTRUCTIONS_LOCATION_KEY)) {
				this._instructionLocations = undefined;
			}
		}));
	}

	getInstructionLocations(): Promise<URI[]> {
		if (!this._instructionLocations) {
			this._instructionLocations = this.getInstructionLocationsImpl();
		}
		return this._instructionLocations;
	}

	async getInstructionLocationsImpl(): Promise<URI[]> {
		const sanitizedLocations: URI[] = [];
		const locations = this.configurationService.getNonExtensionConfig<Record<string, boolean>>(INSTRUCTIONS_LOCATION_KEY);
		if (isObject(locations)) {
			for (const key in locations) {
				const location = key.trim();
				const value = locations[key];
				if (value === true) {
					if (location.startsWith('~/')) {
						sanitizedLocations.push(URI.joinPath(this.envService.userHome, location.substring(2)));
					} else if (isAbsolute(location)) {
						sanitizedLocations.push(URI.file(location));
					}
				}
			}
		}
		return sanitizedLocations;
	}

}

