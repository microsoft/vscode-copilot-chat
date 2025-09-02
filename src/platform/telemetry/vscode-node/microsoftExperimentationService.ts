/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getExperimentationService, IExperimentationFilterProvider, TargetPopulation } from 'vscode-tas-client';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { IConfigurationService } from '../../configuration/common/configurationService';
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

function trimVersionSuffix(version: string): string {
	return version.split('-')[0];
}

const CopilotRelatedPluginVersionPrefix = 'X-Copilot-RelatedPluginVersion-';

export enum RelatedExtensionsFilter {
	CopilotRelatedPluginVersionCppTools = CopilotRelatedPluginVersionPrefix + 'msvscodecpptools',
	CopilotRelatedPluginVersionCMakeTools = CopilotRelatedPluginVersionPrefix + 'msvscodecmaketools',
	CopilotRelatedPluginVersionMakefileTools = CopilotRelatedPluginVersionPrefix + 'msvscodemakefiletools',
	CopilotRelatedPluginVersionCSharpDevKit = CopilotRelatedPluginVersionPrefix + 'msdotnettoolscsdevkit',
	CopilotRelatedPluginVersionPython = CopilotRelatedPluginVersionPrefix + 'mspythonpython',
	CopilotRelatedPluginVersionPylance = CopilotRelatedPluginVersionPrefix + 'mspythonvscodepylance',
	CopilotRelatedPluginVersionJavaPack = CopilotRelatedPluginVersionPrefix + 'vscjavavscodejavapack',
	CopilotRelatedPluginVersionTypescript = CopilotRelatedPluginVersionPrefix + 'vscodetypescriptlanguagefeatures',
	CopilotRelatedPluginVersionTypescriptNext = CopilotRelatedPluginVersionPrefix + 'msvscodevscodetypescriptnext',
	CopilotRelatedPluginVersionCSharp = CopilotRelatedPluginVersionPrefix + 'msdotnettoolscsharp',
	// Copilot related plugins
	CopilotRelatedPluginVersionCopilot = CopilotRelatedPluginVersionPrefix + 'githubcopilot',
	CopilotRelatedPluginVersionCopilotChat = CopilotRelatedPluginVersionPrefix + 'githubcopilotchat',
}

class RelatedExtensionsFilterProvider implements IExperimentationFilterProvider {
	constructor(private _logService: ILogService) { }

	private _getRelatedExtensions(): { name: string; version: string }[] {
		return [
			'ms-vscode.cpptools',
			'ms-vscode.cmake-tools',
			'ms-vscode.makefile-tools',
			'ms-dotnettools.csdevkit',
			'ms-python.python',
			'ms-python.vscode-pylance',
			'vscjava.vscode-java-pack',
			'vscode.typescript-language-features',
			'ms-vscode.vscode-typescript-next',
			'ms-dotnettools.csharp',
		]
			.map(name => {
				const extpj = vscode.extensions.getExtension(name)?.packageJSON as unknown;
				if (extpj && typeof extpj === 'object' && 'version' in extpj && typeof extpj.version === 'string') {
					return { name, version: extpj.version };
				}
			})
			.filter(plugin => plugin !== undefined);
	}

	getFilters(): Map<string, any> {
		this._logService.trace(`[RelatedExtensionsFilterProvider]::getFilters looking up related extensions`);
		const filters = new Map<string, any>();

		for (const extension of this._getRelatedExtensions()) {
			const filterName = CopilotRelatedPluginVersionPrefix + extension.name.replace(/[^A-Za-z]/g, '').toLowerCase();
			if (!Object.values<string>(RelatedExtensionsFilter).includes(filterName)) {
				this._logService.warn(`[RelatedExtensionsFilterProvider]::getFilters A filter could not be registered for the unrecognized related plugin "${extension.name}".`);
				continue;
			}
			filters.set(filterName, trimVersionSuffix(extension.version));
		}

		this._logService.trace(`[RelatedExtensionsFilterProvider]::getFilters Filters: ${JSON.stringify(Array.from(filters.entries()))}`);

		return filters;
	}
}

class CopilotExtensionsFilterProvider implements IExperimentationFilterProvider {
	constructor(private _logService: ILogService) { }

	getFilters(): Map<string, any> {
		const copilotExtensionversion = vscode.extensions.getExtension('github.copilot')?.packageJSON.version;
		const copilotChatExtensionVersion = packageJson.version;
		const completionsCoreVersion = packageJson.completionsCoreVersion;

		this._logService.trace(`[CopilotExtensionsFilterProvider]::getFilters Copilot Extension Version: ${copilotExtensionversion}, Copilot Chat Extension Version: ${copilotChatExtensionVersion}, Completions Core Version: ${completionsCoreVersion}`);
		const filters = new Map<string, any>();
		filters.set(RelatedExtensionsFilter.CopilotRelatedPluginVersionCopilot, copilotExtensionversion);
		filters.set(RelatedExtensionsFilter.CopilotRelatedPluginVersionCopilotChat, copilotChatExtensionVersion);
		filters.set('X-VSCode-CompletionsInChatExtensionVersion', completionsCoreVersion);
		return filters;
	}
}

class CopilotCompletionsFilterProvider implements IExperimentationFilterProvider {
	constructor(private _getCompletionsFilters: () => Map<string, string>, private _logService: ILogService) { }

	getFilters(): Map<string, any> {
		const filters = new Map<string, any>();
		for (const [key, value] of this._getCompletionsFilters()) {
			if (value !== "") {
				filters.set(key, value);
			}
		}
		this._logService.trace(`[CopilotCompletionsFilterProvider]::getFilters Filters: ${JSON.stringify(Array.from(filters.entries()))}`);
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
		@IConfigurationService configurationService: IConfigurationService,
		@ILogService logService: ILogService
	) {

		const id = context.extension.id;
		const version = context.extension.packageJSON['version'];
		const targetPopulation = getTargetPopulation(envService.isPreRelease());
		const delegateFn = (globalState: any, userInfoStore: UserInfoStore) => {
			return getExperimentationService(id, version, targetPopulation, telemetryService, globalState, new GithubAccountFilterProvider(userInfoStore, logService), new RelatedExtensionsFilterProvider(logService), new CopilotExtensionsFilterProvider(logService), new CopilotCompletionsFilterProvider(() => this.getCompletionsFilters(), logService));
		};

		super(delegateFn, context, copilotTokenStore, configurationService, logService);
	}
}
