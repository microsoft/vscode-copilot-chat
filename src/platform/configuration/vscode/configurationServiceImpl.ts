/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { WorkspaceConfiguration } from 'vscode';
import * as vscode from 'vscode';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { packageJson } from '../../env/common/packagejson';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { AbstractConfigurationService, BaseConfig, Config, ConfigValueValidators, CopilotConfigPrefix, ExperimentBasedConfig, ExperimentBasedConfigType, InspectConfigResult } from '../common/configurationService';

// Helper to avoid JSON.stringify quoting strings
function stringOrStringify(value: any) {
	if (typeof value === 'string') {
		return value;
	}
	return JSON.stringify(value);
}

export class ConfigurationServiceImpl extends AbstractConfigurationService {
	private config: WorkspaceConfiguration;

	constructor(@ICopilotTokenStore copilotTokenStore: ICopilotTokenStore) {
		super(copilotTokenStore);
		this.config = vscode.workspace.getConfiguration(CopilotConfigPrefix);

		// Reload cached config if a workspace config change effects Copilot namespace
		vscode.workspace.onDidChangeConfiguration(changeEvent => {
			if (changeEvent.affectsConfiguration(CopilotConfigPrefix)) {
				this.config = vscode.workspace.getConfiguration(CopilotConfigPrefix);
			}
			this._onDidChangeConfiguration.fire(changeEvent);
		});
	}

	getConfig<T>(key: Config<T>, scope?: vscode.ConfigurationScope): T {
		if (key.options?.valueIgnoredForExternals && !this._isInternal) {
			// If the setting is restricted to internal users and the user is not internal, we return the default value
			return this.getDefaultValue(key);
		}

		const config = scope === undefined ? this.config : vscode.workspace.getConfiguration(CopilotConfigPrefix, scope);

		let configuredValue: T | undefined;
		if (key.advancedSubKey) {
			// This is a `github.copilot.advanced.*` setting

			// First, let's try to read it using the flat style
			// e.g. "github.copilot.advanced.debug.useElectronFetcher": false
			const advancedConfigFlatStyleValue = config.get<T>(key.id);
			if (advancedConfigFlatStyleValue !== undefined) {
				configuredValue = advancedConfigFlatStyleValue;
			} else {
				// If that doesn't work, fall back to the object style
				// e.g. "github.copilot.advanced": { "debug.useElectronFetcher": false }
				const advancedConfig = config.get<Record<string, any>>('advanced');
				configuredValue = advancedConfig?.[key.advancedSubKey];
			}
		} else {
			const hasCustomDefaultValue = (
				ConfigValueValidators.isDefaultValueWithTeamAndInternalValue(key.defaultValue)
				|| ConfigValueValidators.isDefaultValueWithTeamValue(key.defaultValue)
			);
			const userIsInternalOrTeamMember = (this._isInternal || this._isTeamMember);
			if (key.isPublic && hasCustomDefaultValue && userIsInternalOrTeamMember) {
				// The setting is public, but it has a different default value for team
				// or internal users, so the (public) default value used by vscode is not the same.
				// We need to really check if the user or workspace configured the setting
				if (this.isConfigured(key, scope)) {
					configuredValue = config.get<T>(key.id);
				}
			} else {
				configuredValue = config.get<T>(key.id);
			}
		}

		if (configuredValue === undefined) {
			return this.getDefaultValue(key);
		}

		if (!key.validator) {
			return configuredValue;
		}

		const value = key.validator.validate(configuredValue);
		if (value.error) {
			console.error(`Could not read "${key.fullyQualifiedId}": ${value.error.message}`);
			return this.getDefaultValue(key);
		}

		return value.content;
	}

	inspectConfig<T>(key: BaseConfig<T>, scope?: vscode.ConfigurationScope): InspectConfigResult<T> | undefined {
		if (key.options?.valueIgnoredForExternals && !this._isInternal) {
			return { defaultValue: this.getDefaultValue(key) };
		}

		const config = scope === undefined ? this.config : vscode.workspace.getConfiguration(CopilotConfigPrefix, scope);
		return config.inspect(key.id);
	}

	override getNonExtensionConfig<T>(configKey: string): T | undefined {
		return vscode.workspace.getConfiguration().get<T>(configKey);
	}

	private _getTargetFromInspect(inspect?: { key: string; workspaceValue?: unknown; workspaceFolderValue?: unknown }): vscode.ConfigurationTarget {
		let target;
		// When we get a config using this service, we have no idea which settings file it came from
		// however, Copilot is more of a "prefer-global" extension, so this logic basically overwrites
		// the value where it was set, but if it was not set, it will set it globally.
		// This way, the user does not have to set the same value in multiple workspaces.
		// TODO: Should we handle language overrides?
		if (!inspect) {
			target = vscode.ConfigurationTarget.Global;

		} else if (inspect.workspaceFolderValue !== undefined) {
			target = vscode.ConfigurationTarget.WorkspaceFolder;
		} else if (inspect.workspaceValue !== undefined) {
			target = vscode.ConfigurationTarget.Workspace;
		} else {
			target = vscode.ConfigurationTarget.Global;
		}
		return target;
	}

	setConfig<T>(key: BaseConfig<T>, value: T): Thenable<void> {
		if (key.advancedSubKey) {
			// This is a `github.copilot.advanced.*` setting

			// We support two styles when reading these settings:
			// 1. Flat style: "github.copilot.advanced.debug.useElectronFetcher": false
			//    This is the style our team likes to use, but this is not the correct way according to how the setting is registered in package.json.
			// 2. Object style: "github.copilot.advanced": { "debug.useElectronFetcher": false }
			//    This is the style that the package.json schema expects, and is the correct way to write these settings.

			// Unfortunately, the configuration API of vscode is unable to write the flat style setting, it refuses to write them.
			// So we can only write the object style setting.
			// But having both styles in the same settings.json file is very finnicky, as the object style will override the flat style
			// and there is no user warning that this is happening.

			// If the setting is already written using the flat style, we unfortunately cannot touch it
			const flatConfigStyle = this.config.inspect(key.id);
			const hasFlatStyle = (
				flatConfigStyle?.globalValue !== undefined
				|| flatConfigStyle?.workspaceFolderValue !== undefined
				|| flatConfigStyle?.workspaceValue !== undefined
			);
			if (hasFlatStyle) {
				throw new Error(`Cannot write to "${key.fullyQualifiedId}". Please update the setting manually to ${JSON.stringify(value)}.`);
			}

			let currentValue = this.config.get<Record<string, any>>('advanced');
			if (!currentValue) {
				currentValue = {
					[key.advancedSubKey]: value
				};
			} else {
				currentValue[key.advancedSubKey] = value;
			}
			return this.config.update('advanced', currentValue, this._getTargetFromInspect(this.config.inspect('advanced')));
		}
		return this.config.update(key.id, value, this._getTargetFromInspect(this.config.inspect(key.id)));
	}

	override getExperimentBasedConfig<T extends ExperimentBasedConfigType>(key: ExperimentBasedConfig<T>, experimentationService: IExperimentationService, scope?: vscode.ConfigurationScope): T {
		const configuredValue = this._getUserConfiguredValueForExperimentBasedConfig(key, scope);
		if (configuredValue !== undefined) {
			return configuredValue;
		}

		if (key.experimentName) {
			const expValue = experimentationService.getTreatmentVariable<Exclude<T, undefined>>('vscode', key.experimentName);
			if (expValue !== undefined) {
				return expValue;
			}
		}

		// This is the pattern we've been using for a while now. We need to maintain it for older experiments.
		const expValue = experimentationService.getTreatmentVariable<Exclude<T, undefined>>('vscode', `copilotchat.config.${key.id}`);
		if (expValue !== undefined) {
			return expValue;
		}

		// This is the pattern vscode uses for settings using the `onExp` tag. But vscode only supports it for
		// settings defined in package.json, so this is why we're also reading the value from exp here.
		const expValue2 = experimentationService.getTreatmentVariable<Exclude<T, undefined>>('vscode', `config.${key.fullyQualifiedId}`);
		if (expValue2 !== undefined) {
			return expValue2;
		}

		return this.getDefaultValue(key);
	}

	private _getUserConfiguredValueForExperimentBasedConfig<T extends ExperimentBasedConfigType>(key: ExperimentBasedConfig<T>, scope?: vscode.ConfigurationScope): T | undefined {
		if (key.options?.valueIgnoredForExternals && !this._isInternal) {
			// If the setting is restricted to internal users and the user is not internal, we return the default value
			return undefined;
		}

		const config = scope === undefined ? this.config : vscode.workspace.getConfiguration(CopilotConfigPrefix, scope);

		if (!this.isConfigured(key, scope)) {
			// The user did not configure this setting
			return undefined;
		}

		return config.get<T>(key.id);
	}

	// Dumps config settings defined in the extension json
	dumpConfig() {
		const configProperties: { [key: string]: string } = {};
		try {
			const config = packageJson.contributes.configuration;
			const propertyGroups = config.map((c) => c.properties);
			const extensionConfigProps = Object.assign({}, ...propertyGroups);
			for (const key in extensionConfigProps) {
				const localKey = key.replace(`${CopilotConfigPrefix}.`, '');
				const value = localKey.split('.').reduce((o, i) => o[i], this.config);

				if (typeof value === 'object' && value !== null) {
					// Dump objects as their properties, filtering secret_key
					Object.keys(value)
						.filter(k => k !== 'secret_key')
						.forEach(k => (configProperties[`${key}.${k}`] = stringOrStringify(value[k])));
				} else {
					configProperties[key] = stringOrStringify(value);
				}
			}
		} catch (ex) {
			// cannot use logger.error which makes a telemetry call
			console.error(`Failed to retrieve configuration properties ${ex}`);
		}
		return configProperties;
	}
}
