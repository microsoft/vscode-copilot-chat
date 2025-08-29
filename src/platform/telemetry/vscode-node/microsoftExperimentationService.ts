/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getExperimentationService, IExperimentationFilterProvider, TargetPopulation } from 'vscode-tas-client';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { IEnvService } from '../../env/common/envService';
import { packageJson } from '../../env/common/packagejson';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { ILogService } from '../../log/common/logService';
import { ITelemetryService } from '../common/telemetry';
import { BaseExperimentationService, UserInfoStore } from '../node/baseExperimentationService';

function getTargetPopulation(isPreRelease: boolean): TargetPopulation {
	if (isPreRelease) {
		return TargetPopulation.Insiders;
	}

	return TargetPopulation.Public;
}

class CopilotExtensionsFilterProvider implements IExperimentationFilterProvider {
	constructor(private _logService: ILogService) { }

	getFilters(): Map<string, any> {
		const copilotExtensionversion = vscode.extensions.getExtension('github.copilot')?.packageJSON.version;
		const copilotChatExtensionVersion = packageJson.version;
		const completionsCoreVersion = packageJson.completionsCoreVersion;

		this._logService.trace(`[CopilotExtensionsFilterProvider]::getFilters Copilot Extension Version: ${copilotExtensionversion}, Copilot Chat Extension Version: ${copilotChatExtensionVersion}, Completions Core Version: ${completionsCoreVersion}`);
		const filters = new Map<string, any>();
		filters.set('X-Copilot-RelatedPluginVersion-githubcopilot', copilotExtensionversion);
		filters.set('X-Copilot-RelatedPluginVersion-githubcopilotchat', copilotChatExtensionVersion);
		filters.set('X-VSCode-CompletionsInChatExtensionVersion', completionsCoreVersion);
		return filters;
	}
}

class GithubAccountFilterProvider implements IExperimentationFilterProvider {
	constructor(private _userInfoStore: UserInfoStore, private _logService: ILogService) { }

	getFilters(): Map<string, any> {
		this._logService.trace(`[GithubAccountFilterProvider]::getFilters SKU: ${this._userInfoStore.sku}, Internal Org: ${this._userInfoStore.internalOrg}`);
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
		@ILogService logService: ILogService
	) {

		const id = context.extension.id;
		const version = context.extension.packageJSON['version'];
		const targetPopulation = getTargetPopulation(envService.isPreRelease());
		const delegateFn = (globalState: any, userInfoStore: UserInfoStore) => {
			return getExperimentationService(id, version, targetPopulation, telemetryService, globalState, new GithubAccountFilterProvider(userInfoStore, logService), new CopilotExtensionsFilterProvider(logService));
		};

		super(delegateFn, context, copilotTokenStore, logService);
	}
}
