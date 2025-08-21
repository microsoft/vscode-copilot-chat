/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getExperimentationService, IExperimentationFilterProvider, TargetPopulation } from 'vscode-tas-client';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { IEnvService } from '../../env/common/envService';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { ITelemetryService } from '../common/telemetry';
import { BaseExperimentationService, UserInfoStore } from '../node/baseExperimentationService';

function getTargetPopulation(isPreRelease: boolean): TargetPopulation {
	if (isPreRelease) {
		return TargetPopulation.Insiders;
	}

	return TargetPopulation.Public;
}

class GithubAccountFilterProvider implements IExperimentationFilterProvider {
	constructor(private _userInfoStore: UserInfoStore) { }

	getFilters(): Map<string, any> {
		const filters = new Map<string, any>();
		filters.set('X-GitHub-Copilot-SKU', this._userInfoStore.sku);
		filters.set('X-Microsoft-Internal-Org', this._userInfoStore.internalOrg);
		return filters;
	}

}

export class MicrosoftExperimentationService extends BaseExperimentationService {
	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IVSCodeExtensionContext context: IVSCodeExtensionContext,
		@IEnvService envService: IEnvService,
		@ICopilotTokenStore copilotTokenStore: ICopilotTokenStore,
	) {

		const id = context.extension.id;
		const version = context.extension.packageJSON['version'];
		const targetPopulation = getTargetPopulation(envService.isPreRelease());
		const delegateFn = (globalState: any, userInfoStore: UserInfoStore) => {
			return getExperimentationService(id, version, targetPopulation, telemetryService, globalState, new GithubAccountFilterProvider(userInfoStore));
		};

		super(delegateFn, context, copilotTokenStore);
	}
}
