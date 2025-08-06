/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConfigurationChangeEvent, ConfigurationScope } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { BugIndicatingError } from '../../../util/vs/base/common/errors';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { StringSHA1 } from '../../../util/vs/base/common/hash';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import * as objects from '../../../util/vs/base/common/objects';
import { IObservable, observableFromEventOpts } from '../../../util/vs/base/common/observable';
import * as types from '../../../util/vs/base/common/types';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { isPreRelease, packageJson } from '../../env/common/packagejson';
import * as xtabPromptOptions from '../../inlineEdits/common/dataTypes/xtabPromptOptions';
import { ResponseProcessor } from '../../inlineEdits/common/responseProcessor';
import { AlternativeNotebookFormat } from '../../notebook/common/alternativeContentFormat';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { IValidator, vBoolean, vString } from './validator';

export const CopilotConfigPrefix = 'github.copilot';

export const IConfigurationService = createServiceIdentifier<IConfigurationService>('IConfigurationService');

export type ExperimentBasedConfigType = boolean | number | (string | undefined);

export interface InspectConfigResult<T> {

	/**
	 * The default value which is used when no other value is defined
	 */
	defaultValue?: T;

	/**
	 * The global or installation-wide value.
	 */
	globalValue?: T;

	/**
	 * The workspace-specific value.
	 */
	workspaceValue?: T;

	/**
	 * The workspace-folder-specific value.
	 */
	workspaceFolderValue?: T;

	/**
	 * Language specific default value when this configuration value is created for a {@link ConfigurationScope language scope}.
	 */
	defaultLanguageValue?: T;

	/**
	 * Language specific global value when this configuration value is created for a {@link ConfigurationScope language scope}.
	 */
	globalLanguageValue?: T;

	/**
	 * Language specific workspace value when this configuration value is created for a {@link ConfigurationScope language scope}.
	 */
	workspaceLanguageValue?: T;

	/**
	 * Language specific workspace-folder value when this configuration value is created for a {@link ConfigurationScope language scope}.
	 */
	workspaceFolderLanguageValue?: T;

	/**
	 * All language identifiers for which this configuration is defined.
	 */
	languageIds?: string[];
}

export interface IConfigurationService {

	readonly _serviceBrand: undefined;

	/**
	 * Gets user configuration for a key from vscode (which if not defined, pulls default value from package.json).
	 * If not defined, returns the default value.
	 *
	 * @remark For object values, the user config will replace the default config.
	 */
	getConfig<T>(key: Config<T>, scope?: ConfigurationScope): T;

	/**
	 * Gets an observable for the configuration of a key from vscode (which if not defined, pulls default value from package.json).
	 * If not defined, returns the default value.
	 *
	 * @remark For object values, the user config will replace the default config.
	 */
	getConfigObservable<T>(key: Config<T>): IObservable<T>;

	/**
	 * Retrieve all information about a configuration setting. A configuration value
	 * often consists of a *default* value, a global or installation-wide value,
	 * a workspace-specific value and folder-specific value
	 * @param configKey The config key to look up
	 * @returns Information about a configuration setting or `undefined`.
	 */
	inspectConfig<T>(key: BaseConfig<T>, scope?: ConfigurationScope): InspectConfigResult<T> | undefined;

	/**
	 * Checks if the key is configured by the user in any of the configuration scopes.
	 */
	isConfigured<T>(key: BaseConfig<T>, scope?: ConfigurationScope): boolean;

	/**
	 * Proxies vscode.workspace.getConfiguration to allow getting a configuration value that is not in the Copilot namespace.
	 * @param configKey The config key to look up
	 */
	getNonExtensionConfig<T>(configKey: string): T | undefined;

	/**
	 * Sets user configuration for a key in vscode.
	 */
	setConfig<T>(key: BaseConfig<T>, value: T): Thenable<void>;

	/**
	 * Gets user configuration for a key from vscode (which if not defined, pulls default value from package.json).
	 * If not defined, returns the experimentation based value or falls back to the default value.
	 *
	 * @remark For object values, the user config will replace the default config.
	 */
	getExperimentBasedConfig<T extends ExperimentBasedConfigType>(key: ExperimentBasedConfig<T>, experimentationService: IExperimentationService, scope?: ConfigurationScope): T;

	/**
	 * Gets the observable of a user configuration for a key from vscode (which if not defined, pulls default value from package.json).
	 * If not defined, returns the experimentation based value or falls back to the default value.
	 *
	 * @remark For object values, the user config will replace the default config.
	 */
	getExperimentBasedConfigObservable<T extends ExperimentBasedConfigType>(key: ExperimentBasedConfig<T>, experimentationService: IExperimentationService): IObservable<T>;

	/**
	 * For object values, the user config will be mixed in with the default config.
	 */
	getConfigMixedWithDefaults<T>(key: Config<T>): T;

	getDefaultValue<T>(key: Config<T>): T;
	getDefaultValue<T extends ExperimentBasedConfigType>(key: ExperimentBasedConfig<T>): T;

	/**
	 * Emitted whenever a configuration value changes.
	 * This emits for all changes, not just changes to the Copilot settings.
	 */
	onDidChangeConfiguration: Event<ConfigurationChangeEvent>;

	dumpConfig(): { [key: string]: string };
}



export abstract class AbstractConfigurationService extends Disposable implements IConfigurationService {
	declare readonly _serviceBrand: undefined;

	protected _onDidChangeConfiguration = this._register(new Emitter<ConfigurationChangeEvent>());
	readonly onDidChangeConfiguration = this._onDidChangeConfiguration.event;

	protected _isInternal: boolean = false;
	protected _isTeamMember: boolean = false;
	private _teamMemberUsername: string | undefined = undefined;

	constructor(copilotTokenStore?: ICopilotTokenStore) {
		super();
		if (copilotTokenStore) {
			this._register(copilotTokenStore.onDidStoreUpdate(() => {
				const isTeamMember = !!copilotTokenStore.copilotToken?.isVscodeTeamMember;
				this._setUserInfo({
					isInternal: !!copilotTokenStore.copilotToken?.isInternal,
					isTeamMember,
					teamMemberUsername: isTeamMember ? copilotTokenStore.copilotToken?.username : undefined
				});
			}));
		}
	}

	getConfigMixedWithDefaults<T>(key: Config<T>): T {
		if (key.options?.valueIgnoredForExternals && !this._isInternal) {
			return this.getDefaultValue(key);
		}

		const userValue = this.getConfig(key);

		// if user doesn't override the setting, return the default
		if (userValue === undefined) {
			return this.getDefaultValue(key);
		}

		// if user overrides the setting and the setting is an object, combine default with user value, with the preference to user settings
		if (types.isObject(userValue) && types.isObject(key.defaultValue)) {
			// If default is an object apply the default and then apply the setting
			return { ...key.defaultValue, ...userValue };
		}

		return userValue;
	}

	public getDefaultValue<T>(key: BaseConfig<T>): T {
		if (ConfigValueValidators.isDefaultValueWithTeamAndInternalValue(key.defaultValue)) {
			return this._isUsingTeamDefault(key)
				? key.defaultValue.teamDefaultValue
				: this._isInternal
					? key.defaultValue.internalDefaultValue
					: key.defaultValue.defaultValue;
		}
		if (ConfigValueValidators.isDefaultValueWithTeamValue(key.defaultValue)) {
			return this._isUsingTeamDefault(key) ? key.defaultValue.teamDefaultValue : key.defaultValue.defaultValue;
		}
		return key.defaultValue;
	}

	private _setUserInfo(userInfo: { isInternal: boolean; isTeamMember: boolean; teamMemberUsername?: string }): void {
		if (this._isInternal === userInfo.isInternal && this._isTeamMember === userInfo.isTeamMember && this._teamMemberUsername === userInfo.teamMemberUsername) {
			// no change
			return;
		}
		this._isInternal = userInfo.isInternal;
		this._isTeamMember = userInfo.isTeamMember;
		this._teamMemberUsername = userInfo.teamMemberUsername;
		// fire a fake change event to refresh all settings
		this._onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
	}

	abstract getConfig<T>(key: Config<T>, scope?: ConfigurationScope): T;
	abstract inspectConfig<T>(key: BaseConfig<T>, scope?: ConfigurationScope): InspectConfigResult<T> | undefined;
	abstract getNonExtensionConfig<T>(configKey: string): T | undefined;
	abstract setConfig<T>(key: BaseConfig<T>, value: T): Thenable<void>;
	abstract getExperimentBasedConfig<T extends ExperimentBasedConfigType>(key: ExperimentBasedConfig<T>, experimentationService: IExperimentationService): T;
	abstract dumpConfig(): { [key: string]: string };

	public getConfigObservable<T>(key: Config<T>): IObservable<T> {
		return this._getObservable_$show2FramesUp(key, () => this.getConfig(key));
	}

	public getExperimentBasedConfigObservable<T extends ExperimentBasedConfigType>(key: ExperimentBasedConfig<T>, experimentationService: IExperimentationService): IObservable<T> {
		return this._getObservable_$show2FramesUp(key, () => this.getExperimentBasedConfig(key, experimentationService));
	}

	private observables = new Map<string, IObservable<any>>();

	private _getObservable_$show2FramesUp<T>(key: BaseConfig<T>, getValue: () => T): IObservable<T> {
		let observable = this.observables.get(key.id);
		if (!observable) {
			observable = observableFromEventOpts(
				{ debugName: () => `Configuration Key "${key.id}"` },
				(handleChange) => this._register(this.onDidChangeConfiguration(e => {
					if (e.affectsConfiguration(key.fullyQualifiedId)) {
						handleChange(e);
					}
				})),
				getValue
			);
			this.observables.set(key.id, observable);
		}
		return observable;
	}

	protected _isUsingTeamDefault(key: BaseConfig<any>): boolean {
		if (!this._isTeamMember) {
			return false;
		}
		if (
			!ConfigValueValidators.isDefaultValueWithTeamAndInternalValue(key.defaultValue)
			&& !ConfigValueValidators.isDefaultValueWithTeamValue(key.defaultValue)
		) {
			return false;
		}
		const rolloutRatio = key.defaultValue.teamDefaultValueRollout;
		if (rolloutRatio === undefined || rolloutRatio >= 1) {
			return true;
		}

		const selectedValue = `${key.fullyQualifiedId};${this._teamMemberUsername}`;

		// Extract first 4 bytes and convert to a number between 0 and 1
		const hashValue = AbstractConfigurationService._extractHashValue(selectedValue);

		// Compare with rolloutRatio to determine if the user should get the feature
		return hashValue < rolloutRatio;
	}

	/**
	 * Extracts a normalized value (0-1) from a string
	 */
	public static _extractHashValue(input: string): number {
		const hash = new StringSHA1();
		hash.update(input);
		const firstPortion = hash.digest().substring(0, 8);
		// Convert from hex to number
		const hashNumber = parseInt(firstPortion, 16);
		// Normalize to a value between 0 and 1
		return (hashNumber / 0xFFFFFFFF);
	}

	/**
	 * Checks if the key is configured by the user in any of the configuration scopes.
	 */
	public isConfigured<T>(key: BaseConfig<T>, scope?: ConfigurationScope): boolean {
		const inspect = this.inspectConfig<T>(key, scope);
		const isConfigured = (
			inspect?.globalValue !== undefined
			|| inspect?.globalLanguageValue !== undefined
			|| inspect?.workspaceFolderValue !== undefined
			|| inspect?.workspaceFolderLanguageValue !== undefined
			|| inspect?.workspaceValue !== undefined
			|| inspect?.workspaceLanguageValue !== undefined
		);
		return isConfigured;
	}

}

export type DefaultValueWithTeamValue<T> = {
	defaultValue: T;
	teamDefaultValue: T;
	/**
	 * Roll out `teamDefaultValue` to a percentage of the team.
	 * This is a number between 0 and 1.
	 * 0 means 0% of the team will get `teamDefaultValue`
	 * 1 means 100% of the team will get `teamDefaultValue`
	 * undefined means 100% of the team will get `teamDefaultValue`
	 */
	teamDefaultValueRollout?: number;
};
export type DefaultValueWithTeamAndInternalValue<T> = DefaultValueWithTeamValue<T> & { internalDefaultValue: T };

export namespace ConfigValueValidators {
	export function isDefaultValueWithTeamValue<T>(value: T | DefaultValueWithTeamValue<T>): value is DefaultValueWithTeamValue<T> {
		return types.isObject(value) && 'defaultValue' in value && 'teamDefaultValue' in value;
	}

	export function isDefaultValueWithTeamAndInternalValue<T>(value: T | DefaultValueWithTeamAndInternalValue<T>): value is DefaultValueWithTeamAndInternalValue<T> {
		return ConfigValueValidators.isDefaultValueWithTeamValue(value) && 'internalDefaultValue' in value;
	}
}

export interface BaseConfig<T> {
	/**
	 * Key as it appears in settings.json minus the "github.copilot." prefix.
	 * e.g. "advanced.debug.overrideProxyUrl"
	 */
	readonly id: string;

	/**
	 * This setting is present in package.json and is visible to the general public.
	 */
	readonly isPublic: boolean;

	/**
	 * The fully qualified id, e.g. "github.copilot.advanced.debug.overrideProxyUrl".
	 * Use this with `affectsConfiguration` from the ConfigurationChangeEvent
	 */
	readonly fullyQualifiedId: string;

	/**
	 * The `X` in `github.copilot.advanced.X` settings.
	 */
	readonly advancedSubKey: string | undefined;

	/**
	 * The default value (defined either in code for hidden settings, or in package.json for non-hidden settings)
	 */
	readonly defaultValue: T | DefaultValueWithTeamValue<T> | DefaultValueWithTeamAndInternalValue<T>;

	/**
	 * Setting options
	 */
	readonly options?: ConfigOptions;

	readonly validator?: IValidator<T>;
}

export const enum ConfigType {
	Simple,
	ExperimentBased
}

export interface ConfigOptions {
	readonly internal?: boolean;
	readonly valueIgnoredForExternals?: boolean;
}

const INTERNAL: ConfigOptions = {
	internal: true
};

const INTERNAL_RESTRICTED: ConfigOptions = {
	internal: true,
	valueIgnoredForExternals: true,
};

export interface Config<T> extends BaseConfig<T> {
	readonly configType: ConfigType.Simple;
}

export interface ExperimentBasedConfig<T extends ExperimentBasedConfigType> extends BaseConfig<T> {
	readonly configType: ConfigType.ExperimentBased;
	readonly experimentName: string | undefined;
}

let packageJsonDefaults: Map<string, any> | undefined = undefined;
function getPackageJsonDefaults(): Map<string, any> {
	if (!packageJsonDefaults) {
		packageJsonDefaults = new Map<string, any>();

		// Use the information in packageJson
		const config = packageJson.contributes.configuration;
		const propertyGroups = config.map((c) => c.properties);
		const configProps = Object.assign({}, ...propertyGroups);
		for (const key in configProps) {
			packageJsonDefaults.set(key, configProps[key].default);
		}
	}
	return packageJsonDefaults;
}

function toBaseConfig<T>(key: string, defaultValue: T | DefaultValueWithTeamValue<T> | DefaultValueWithTeamAndInternalValue<T>, options: ConfigOptions | undefined): BaseConfig<T> {
	const fullyQualifiedId = `${CopilotConfigPrefix}.${key}`;
	const packageJsonDefaults = getPackageJsonDefaults();
	const isPublic = packageJsonDefaults.has(fullyQualifiedId);
	const packageJsonDefaultValue = packageJsonDefaults.get(fullyQualifiedId);
	if (isPublic) {
		// make sure the default in the code matches the default in packageJson
		const publicDefaultValue = (
			ConfigValueValidators.isDefaultValueWithTeamAndInternalValue(defaultValue)
				? defaultValue.defaultValue
				: ConfigValueValidators.isDefaultValueWithTeamValue(defaultValue)
					? defaultValue.defaultValue
					: defaultValue
		);
		if (!objects.equals(publicDefaultValue, packageJsonDefaultValue)) {
			throw new BugIndicatingError(`The default value for setting ${key} is different in packageJson and in code`);
		}
	}
	if (isPublic && options?.internal) {
		throw new BugIndicatingError(`The setting ${key} is public, it therefore cannot be marked internal!`);
	}
	if (isPublic && options?.valueIgnoredForExternals) {
		throw new BugIndicatingError(`The setting ${key} is public, it therefore cannot be restricted to internal!`);
	}
	if (
		ConfigValueValidators.isDefaultValueWithTeamAndInternalValue(defaultValue)
		|| ConfigValueValidators.isDefaultValueWithTeamValue(defaultValue)
	) {
		const rolloutRatio = defaultValue.teamDefaultValueRollout;
		if (rolloutRatio !== undefined && (rolloutRatio < 0 || rolloutRatio > 1)) {
			throw new BugIndicatingError(`The rollout ratio for setting ${key} is invalid`);
		}
	}
	const advancedSubKey = fullyQualifiedId.startsWith('github.copilot.advanced.') ? fullyQualifiedId.substring('github.copilot.advanced.'.length) : undefined;
	return { id: key, isPublic, fullyQualifiedId, advancedSubKey, defaultValue, options };
}

class ConfigRegistry {
	/**
	 * A map of all registered configs, keyed by their full id, eg `github.copilot.advanced.debug.overrideProxyUrl`.
	 */
	public readonly configs: Map<string, Config<any> | ExperimentBasedConfig<any>> = new Map();

	registerConfig(config: Config<any> | ExperimentBasedConfig<any>): void {
		this.configs.set(config.fullyQualifiedId, config);
	}
}

export const globalConfigRegistry = new ConfigRegistry();

function defineValidatedSetting<T>(key: string, validator: IValidator<T>, defaultValue: T | DefaultValueWithTeamValue<T> | DefaultValueWithTeamAndInternalValue<T>, options?: ConfigOptions): Config<T> {
	const value: Config<T> = { ...toBaseConfig(key, defaultValue, options), configType: ConfigType.Simple, validator };
	globalConfigRegistry.registerConfig(value);
	return value;
}

function defineSetting<T>(key: string, defaultValue: T | DefaultValueWithTeamValue<T> | DefaultValueWithTeamAndInternalValue<T>, options?: ConfigOptions): Config<T> {
	const value: Config<T> = { ...toBaseConfig(key, defaultValue, options), configType: ConfigType.Simple };
	globalConfigRegistry.registerConfig(value);
	return value;
}

/**
 * Will define a setting which will be backed by an experiment. The experiment variable will be:
 * ```
 *     config.github.copilot.${key}
 *
 * e.g.
 *     config.github.copilot.chat.advanced.inlineEdits.internalRollout
 * ```
 */
export function defineExpSetting<T extends ExperimentBasedConfigType>(key: string, defaultValue: T | DefaultValueWithTeamValue<T> | DefaultValueWithTeamAndInternalValue<T>, options?: ConfigOptions, expOptions?: { experimentName?: string }): ExperimentBasedConfig<T> {
	const value: ExperimentBasedConfig<T> = { ...toBaseConfig(key, defaultValue, options), configType: ConfigType.ExperimentBased, experimentName: expOptions?.experimentName };
	if (value.advancedSubKey) {
		// This is a `github.copilot.advanced.*` setting
		throw new BugIndicatingError('Shared settings cannot be experiment based');
	}
	globalConfigRegistry.registerConfig(value);
	return value;
}

// Max CAPI tool count limit
export const HARD_TOOL_LIMIT = 128;

// WARNING
// These values are used in the request and are case sensitive. Do not change them unless advised by CAPI.
// It is also not recommended to use this as a type as it will never be an exhaustive list
export const enum CHAT_MODEL {
	GPT41 = 'gpt-4.1-2025-04-14',
	GPT4OMINI = 'gpt-4o-mini',
	NES_XTAB = 'copilot-nes-xtab', // xtab model hosted in prod in proxy
	CUSTOM_NES = 'custom-nes',
	XTAB_4O_MINI_FINETUNED = 'xtab-4o-mini-finetuned',
	GPT4OPROXY = 'gpt-4o-instant-apply-full-ft-v66',
	CLAUDE_SONNET = 'claude-3.5-sonnet',
	CLAUDE_37_SONNET = 'claude-3.7-sonnet',
	DEEPSEEK_CHAT = 'deepseek-chat',
	GEMINI_25_PRO = 'gemini-2.5-pro',
	GEMINI_20_PRO = 'gemini-2.0-pro-exp-02-05',
	GEMINI_FLASH = 'gemini-2.0-flash-001',
	O1 = 'o1',
	O3MINI = 'o3-mini',
	O1MINI = 'o1-mini',
	// A placeholder model that is used for just quickly testing new Azure endpoints.
	// This model is not intended to be used for any real work.
	EXPERIMENTAL = 'experimental-01'
}

// WARNING
// These values are used in the request and are case sensitive. Do not change them unless advised by CAPI.
export const enum EMBEDDING_MODEL {
	TEXT3SMALL = "text-embedding-3-small"
}

export enum AuthProviderId {
	GitHub = 'github',
	GitHubEnterprise = 'github-enterprise',
	Microsoft = 'microsoft',
}

export enum AuthPermissionMode {
	Default = 'default',
	Minimal = 'minimal'
}

export type CodeGenerationImportInstruction = { language?: string; file: string };
export type CodeGenerationTextInstruction = { language?: string; text: string };
export type CodeGenerationInstruction = CodeGenerationImportInstruction | CodeGenerationTextInstruction;

export type CommitMessageGenerationInstruction = { file: string } | { text: string };

export const XTabProviderId = 'XtabProvider';

export namespace ConfigKey {

	/**
	 * These settings are defined in the completions extensions and shared.
	 *
	 * We should not change the names of these settings without coordinating with Completions extension.
	*/
	export namespace Shared {
		/** Allows for overriding the base domain we use for making requests to the CAPI. This helps CAPI devs develop against a local instance. */
		export const DebugOverrideProxyUrl = defineSetting<string | undefined>('advanced.debug.overrideProxyUrl', undefined, INTERNAL_RESTRICTED);
		export const DebugOverrideCAPIUrl = defineSetting<string | undefined>('advanced.debug.overrideCapiUrl', undefined, INTERNAL_RESTRICTED);
		export const DebugUseNodeFetchFetcher = defineSetting('advanced.debug.useNodeFetchFetcher', true);
		export const DebugUseNodeFetcher = defineSetting('advanced.debug.useNodeFetcher', false);
		export const DebugUseElectronFetcher = defineSetting('advanced.debug.useElectronFetcher', true);
		export const AuthProvider = defineSetting<AuthProviderId>('advanced.authProvider', AuthProviderId.GitHub);
		export const AuthPermissions = defineSetting<AuthPermissionMode>('advanced.authPermissions', AuthPermissionMode.Default);
		export const Enable = defineSetting<{ [key: string]: boolean }>('enable', {
			"*": true,
			"plaintext": false,
			"markdown": false,
			"scminput": false
		});

	}

	/**
	 * Internal and debugging settings that should be hidden from users.
	 *
	 * Features should only be in this list temporarily, moving on to experimental to be accessible to early adopters.
	*/
	export namespace Internal {
		/**
		 * Allows for overriding the base domain we use for making requests to the fast rewrite model. This helps GitHub proxy devs develop against a local instance.
		 */
		export const DebugOverrideFastRewriteUrl = defineSetting('chat.advanced.debug.overrideFastRewriteUrl', undefined, INTERNAL);
		/**
		 * Allows for overriding the engine we use for making requests to the fast rewrite model. This helps GitHub proxy devs test deployments.
		 */
		export const DebugOverrideFastRewriteEngine = defineSetting('chat.advanced.debug.overrideFastRewriteEngine', undefined, INTERNAL);

		export const DebugOverrideFastRewriteUseFineTunedModel = defineSetting('chat.advanced.debug.overrideFastRewriteUseFineTunedModel', false, INTERNAL);
		/** Allows forcing a particular model.
		 * Note: this should not be used while self-hosting because it might lead to
		 * a fundamental different experience compared to our end-users.
		 */
		export const DebugOverrideChatEngine = defineSetting<string | undefined>('chat.advanced.debug.overrideChatEngine', undefined, INTERNAL_RESTRICTED);
		/** Allows forcing a particular embeddings model.
		 */
		export const DebugOverrideEmbeddingsModel = defineSetting<EMBEDDING_MODEL | undefined>('chat.advanced.debug.overrideEmbeddingsModel', undefined, INTERNAL_RESTRICTED);
		/** Allows forcing a particular context window size.
		 * This setting doesn't validate values so large windows may not be supported by the model.
		 * Note: this should not be used while self-hosting because it might lead to
		 * a fundamental different experience compared to our end-users.
		 */
		export const DebugOverrideChatMaxTokenNum = defineSetting('chat.advanced.debug.overrideChatMaxTokenNum', 0, INTERNAL_RESTRICTED);
		/** Allow reporting issue when clicking on the Unhelpful button
		 * Requires a window reload to take effect
		 */
		export const DebugReportFeedback = defineSetting('chat.advanced.debug.reportFeedback', { defaultValue: false, teamDefaultValue: true }, INTERNAL_RESTRICTED);
		export const DebugCollectFetcherTelemetry = defineExpSetting<boolean>('chat.advanced.debug.collectFetcherTelemetry', true, INTERNAL_RESTRICTED);
		export const GitHistoryRelatedFilesUsingEmbeddings = defineSetting('chat.advanced.suggestRelatedFilesFromGitHistory.useEmbeddings', false);

		/** Enable or disable chat variables by name. The default is { "*": true } for pre-release
		 */
		export const ConversationVariablesEnablements = defineSetting<{ [key: string]: boolean }>('chat.advanced.variables', { '*': isPreRelease }, INTERNAL);
		/** Uses new expanded project labels */
		export const ProjectLabelsExpanded = defineExpSetting<boolean>('chat.advanced.projectLabels.expanded', false, INTERNAL);
		/** Add project labels in default agent */
		export const ProjectLabelsChat = defineExpSetting<boolean>('chat.advanced.projectLabels.chat', false, INTERNAL);
		/** Add project labels in default agent */
		export const ProjectLabelsInline = defineExpSetting<boolean>('chat.advanced.projectLabels.inline', false, INTERNAL);
		export const WorkspaceMaxLocalIndexSize = defineExpSetting<number>('chat.advanced.workspace.maxLocalIndexSize', 100_000, INTERNAL);
		export const WorkspaceEnableFullWorkspace = defineExpSetting<boolean>('chat.advanced.workspace.enableFullWorkspace', true, INTERNAL);
		export const WorkspaceEnableCodeSearch = defineExpSetting<boolean>('chat.advanced.workspace.enableCodeSearch', true, INTERNAL);
		export const WorkspaceEnableEmbeddingsSearch = defineExpSetting<boolean>('chat.advanced.workspace.enableEmbeddingsSearch', true, INTERNAL);
		export const WorkspaceUseCodeSearchInstantIndexing = defineExpSetting<boolean>('chat.advanced.workspace.useCodeSearchInstantIndexing', true, INTERNAL);
		export const WorkspacePreferredEmbeddingsModel = defineExpSetting<string>('chat.advanced.workspace.preferredEmbeddingsModel', '', INTERNAL);
		export const WorkspaceEnableAdoCodeSearch = defineExpSetting<boolean>('chat.advanced.workspace.enabledAdoCodeSearch', true, INTERNAL);
		export const WorkspacePrototypeAdoCodeSearchEndpointOverride = defineSetting<string>('chat.advanced.workspace.prototypeAdoCodeSearchEndpointOverride', '', INTERNAL);
		export const FeedbackOnChange = defineSetting('chat.advanced.feedback.onChange', false, INTERNAL);
		export const ReviewIntent = defineSetting('chat.advanced.review.intent', false, INTERNAL);
		/** Enable the new notebook priorities experiment */
		export const NotebookSummaryExperimentEnabled = defineSetting('chat.advanced.notebook.summaryExperimentEnabled', false, INTERNAL);
		/** Enable filtering variables by cell document symbols */
		export const NotebookVariableFilteringEnabled = defineSetting('chat.advanced.notebook.variableFilteringEnabled', false, INTERNAL);
		export const NotebookAlternativeDocumentFormat = defineExpSetting<AlternativeNotebookFormat>('chat.advanced.notebook.alternativeFormat', AlternativeNotebookFormat.xml, INTERNAL);
		export const UseAlternativeNESNotebookFormat = defineExpSetting<boolean>('chat.advanced.notebook.alternativeNESFormat', false, INTERNAL);
		export const TerminalToDebuggerPatterns = defineSetting<string[]>('chat.advanced.debugTerminalCommandPatterns', [], INTERNAL);
		export const InlineEditsMaxAffectedLines = defineExpSetting<number | undefined>('chat.advanced.inlineEdits.maxAffectedLines', undefined, INTERNAL_RESTRICTED);
		export const InlineEditsIgnoreCompletionsDisablement = defineValidatedSetting<boolean>('chat.advanced.inlineEdits.ignoreCompletionsDisablement', vBoolean(), false, INTERNAL_RESTRICTED);
		export const InlineEditsAsyncCompletions = defineExpSetting<boolean>('chat.advanced.inlineEdits.asyncCompletions', true, INTERNAL_RESTRICTED);
		export const InlineEditsRevisedCacheStrategy = defineExpSetting<boolean>('chat.advanced.inlineEdits.revisedCacheStrategy', true, INTERNAL_RESTRICTED);
		export const InlineEditsCacheTracksRejections = defineExpSetting<boolean>('chat.advanced.inlineEdits.cacheTracksRejections', true, INTERNAL_RESTRICTED);
		export const InlineEditsRecentlyShownCacheEnabled = defineExpSetting<boolean>('chat.advanced.inlineEdits.recentlyShownCacheEnabled', false, INTERNAL_RESTRICTED);
		export const InlineEditsDebounceUseCoreRequestTime = defineExpSetting<boolean>('chat.advanced.inlineEdits.debounceUseCoreRequestTime', false, INTERNAL_RESTRICTED);
		export const InlineEditsYieldToCopilot = defineExpSetting<boolean>('chat.advanced.inlineEdits.yieldToCopilot', false, INTERNAL_RESTRICTED);
		export const InlineEditsEnableCompletionsProvider = defineExpSetting<boolean>('chat.advanced.inlineEdits.completionsProvider.enabled', false, INTERNAL_RESTRICTED);
		export const InlineEditsCompletionsUrl = defineExpSetting<string | undefined>('chat.advanced.inlineEdits.completionsProvider.url', undefined, INTERNAL_RESTRICTED);
		export const InlineEditsLogContextRecorderEnabled = defineSetting('chat.advanced.inlineEdits.logContextRecorder.enabled', false, INTERNAL_RESTRICTED);
		export const InlineEditsDebounce = defineExpSetting<number>('chat.advanced.inlineEdits.debounce', 200, INTERNAL_RESTRICTED);
		export const InlineEditsCacheDelay = defineExpSetting<number>('chat.advanced.inlineEdits.cacheDelay', 300, INTERNAL_RESTRICTED);
		export const InlineEditsBackoffDebounceEnabled = defineExpSetting<boolean>('chat.advanced.inlineEdits.backoffDebounceEnabled', true, INTERNAL_RESTRICTED);
		export const InlineEditsExtraDebounceEndOfLine = defineExpSetting<number>('chat.advanced.inlineEdits.extraDebounceEndOfLine', 0, INTERNAL_RESTRICTED);
		export const InlineEditsDebounceOnSelectionChange = defineExpSetting<number | undefined>('chat.advanced.inlineEdits.debounceOnSelectionChange', undefined, INTERNAL_RESTRICTED);
		export const InlineEditsProviderId = defineExpSetting<string | undefined>('chat.advanced.inlineEdits.providerId', undefined, INTERNAL_RESTRICTED);
		export const InlineEditsHideInternalInterface = defineValidatedSetting<boolean>('chat.advanced.inlineEdits.hideInternalInterface', vBoolean(), false, INTERNAL_RESTRICTED);
		export const InlineEditsLogCancelledRequests = defineValidatedSetting<boolean>('chat.advanced.inlineEdits.logCancelledRequests', vBoolean(), false, INTERNAL_RESTRICTED);
		export const InlineEditsUnification = defineExpSetting<boolean>('chat.advanced.inlineEdits.unification', false, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderUrl = defineValidatedSetting<string | undefined>('chat.advanced.inlineEdits.xtabProvider.url', vString(), undefined, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderApiKey = defineValidatedSetting<string | undefined>('chat.advanced.inlineEdits.xtabProvider.apiKey', vString(), undefined, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderModelName = defineExpSetting<string | undefined>('chat.advanced.inlineEdits.xtabProvider.modelName', undefined, INTERNAL_RESTRICTED);
		export const InlineEditsInlineCompletionsEnabled = defineValidatedSetting<boolean>('chat.advanced.inlineEdits.inlineCompletions.enabled', vBoolean(), true, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderUsePrediction = defineValidatedSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.usePrediction', vBoolean(), true, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderUseVaryingLinesAbove = defineExpSetting<boolean | undefined>('chat.advanced.inlineEdits.xtabProvider.useVaryingLinesAbove', undefined, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderNLinesAbove = defineExpSetting<number | undefined>('chat.advanced.inlineEdits.xtabProvider.nLinesAbove', undefined, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderNLinesBelow = defineExpSetting<number | undefined>('chat.advanced.inlineEdits.xtabProvider.nLinesBelow', undefined, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderRetryWithNMoreLinesBelow = defineExpSetting<number | undefined>('chat.advanced.inlineEdits.xtabProvider.retryWithNMoreLinesBelow', undefined, INTERNAL_RESTRICTED);
		export const InlineEditsXtabNRecentlyViewedDocuments = defineExpSetting<number>('chat.advanced.inlineEdits.xtabProvider.nRecentlyViewedDocuments', xtabPromptOptions.DEFAULT_OPTIONS.recentlyViewedDocuments.nDocuments, INTERNAL_RESTRICTED);
		export const InlineEditsXtabRecentlyViewedDocumentsMaxTokens = defineExpSetting<number>('chat.advanced.inlineEdits.xtabProvider.recentlyViewedDocuments.maxTokens', xtabPromptOptions.DEFAULT_OPTIONS.recentlyViewedDocuments.maxTokens, INTERNAL_RESTRICTED);
		export const InlineEditsXtabDiffNEntries = defineExpSetting<number>('chat.advanced.inlineEdits.xtabProvider.diffNEntries', xtabPromptOptions.DEFAULT_OPTIONS.diffHistory.nEntries, INTERNAL_RESTRICTED);
		export const InlineEditsXtabDiffMaxTokens = defineExpSetting<number>('chat.advanced.inlineEdits.xtabProvider.diffMaxTokens', xtabPromptOptions.DEFAULT_OPTIONS.diffHistory.maxTokens, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderEmitFastCursorLineChange = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.emitFastCursorLineChange', false, INTERNAL_RESTRICTED);
		export const InlineEditsXtabIncludeViewedFiles = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.includeViewedFiles', xtabPromptOptions.DEFAULT_OPTIONS.recentlyViewedDocuments.includeViewedFiles, INTERNAL_RESTRICTED);
		export const InlineEditsXtabPageSize = defineExpSetting<number>('chat.advanced.inlineEdits.xtabProvider.pageSize', xtabPromptOptions.DEFAULT_OPTIONS.pagedClipping.pageSize, INTERNAL_RESTRICTED);
		export const InlineEditsXtabIncludeTagsInCurrentFile = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.includeTagsInCurrentFile', xtabPromptOptions.DEFAULT_OPTIONS.currentFile.includeTags, INTERNAL_RESTRICTED);
		export const InlineEditsXtabCurrentFileMaxTokens = defineExpSetting<number>('chat.advanced.inlineEdits.xtabProvider.currentFileMaxTokens', xtabPromptOptions.DEFAULT_OPTIONS.currentFile.maxTokens, INTERNAL_RESTRICTED);
		export const InlineEditsXtabPrioritizeAboveCursor = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.currentFile.prioritizeAboveCursor', xtabPromptOptions.DEFAULT_OPTIONS.currentFile.prioritizeAboveCursor, INTERNAL_RESTRICTED);
		export const InlineEditsXtabDiffOnlyForDocsInPrompt = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.diffOnlyForDocsInPrompt', xtabPromptOptions.DEFAULT_OPTIONS.diffHistory.onlyForDocsInPrompt, INTERNAL_RESTRICTED);
		export const InlineEditsXtabDiffUseRelativePaths = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.diffUseRelativePaths', xtabPromptOptions.DEFAULT_OPTIONS.diffHistory.useRelativePaths, INTERNAL_RESTRICTED);
		export const InlineEditsXtabNNonSignificantLinesToConverge = defineExpSetting<number>('chat.advanced.inlineEdits.xtabProvider.nNonSignificantLinesToConverge', ResponseProcessor.DEFAULT_DIFF_PARAMS.nLinesToConverge, INTERNAL_RESTRICTED);
		export const InlineEditsXtabNSignificantLinesToConverge = defineExpSetting<number>('chat.advanced.inlineEdits.xtabProvider.nSignificantLinesToConverge', ResponseProcessor.DEFAULT_DIFF_PARAMS.nSignificantLinesToConverge, INTERNAL_RESTRICTED);
		export const InlineEditsXtabLanguageContextEnabled = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.languageContext.enabled', xtabPromptOptions.DEFAULT_OPTIONS.languageContext.enabled, INTERNAL_RESTRICTED);
		export const InlineEditsXtabLanguageContextMaxTokens = defineExpSetting<number>('chat.advanced.inlineEdits.xtabProvider.languageContext.maxTokens', xtabPromptOptions.DEFAULT_OPTIONS.languageContext.maxTokens, INTERNAL_RESTRICTED);
		export const InlineEditsXtabUseUnifiedModel = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.useUnifiedModel', false, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderUseSimplifiedPrompt = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.simplifiedPrompt', false, INTERNAL_RESTRICTED);
		export const InlineEditsXtabProviderUseXtab275Prompting = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.xtab275Prompting', false, INTERNAL_RESTRICTED);
		export const InlineEditsXtabUseNes41Miniv3Prompting = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.useNes41Miniv3Prompting', false, INTERNAL_RESTRICTED);
		export const InlineEditsXtabCodexV21NesUnified = defineExpSetting<boolean>('chat.advanced.inlineEdits.xtabProvider.codexv21nesUnified', false, INTERNAL_RESTRICTED);
		export const InlineEditsDiagnosticsExplorationEnabled = defineSetting<boolean | undefined>('chat.advanced.inlineEdits.inlineEditsDiagnosticsExplorationEnabled', false, INTERNAL_RESTRICTED);
		export const EditSourceTrackingShowDecorations = defineSetting('chat.advanced.editSourceTracking.showDecorations', false, INTERNAL);
		export const EditSourceTrackingShowStatusBar = defineSetting('chat.advanced.editSourceTracking.showStatusBar', false, INTERNAL);
		export const WorkspaceRecordingEnabled = defineSetting('chat.advanced.localWorkspaceRecording.enabled', false, INTERNAL);
		export const EditRecordingEnabled = defineSetting('chat.advanced.editRecording.enabled', false, INTERNAL);
		export const InternalWelcomeHintEnabled = defineSetting('chat.advanced.welcomePageHint.enabled', { defaultValue: false, internalDefaultValue: true, teamDefaultValue: true }, INTERNAL_RESTRICTED);
		/** Configure temporal context max age */
		export const TemporalContextMaxAge = defineExpSetting<number>('chat.advanced.temporalContext.maxAge', 100, INTERNAL);
		export const TemporalContextPreferSameLang = defineExpSetting<boolean>('chat.advanced.temporalContext.preferSameLang', false, INTERNAL);
		export const CodeSearchAgentEnabled = defineSetting<boolean | undefined>('chat.advanced.codesearch.agent.enabled', true, INTERNAL_RESTRICTED);
		export const EditLinkification = defineSetting<boolean | undefined>('chat.advanced.edits.linkification', undefined, INTERNAL_RESTRICTED);
		export const AgentTemperature = defineSetting<number | undefined>('chat.advanced.agent.temperature', undefined, INTERNAL_RESTRICTED);

		export const InlineChatUseCodeMapper = defineSetting<boolean>('chat.advanced.inlineChat.useCodeMapper', false, INTERNAL_RESTRICTED);
		export const InstantApplyModelName = defineExpSetting<string>('chat.advanced.instantApply.modelName', 'gpt-4o-instant-apply-full-ft-v66', INTERNAL_RESTRICTED);

		export const EnableUserPreferences = defineSetting<boolean>('chat.advanced.enableUserPreferences', false, INTERNAL_RESTRICTED);

		export const SweBenchAgentPrompt = defineSetting<boolean>('chat.advanced.swebench.agentPrompt', { defaultValue: false, teamDefaultValue: false }, INTERNAL_RESTRICTED);

		export const SummarizeAgentConversationHistoryThreshold = defineSetting<number | undefined>('chat.advanced.summarizeAgentConversationHistoryThreshold', undefined, INTERNAL_RESTRICTED);
		export const AgentHistorySummarizationMode = defineSetting<string | undefined>('chat.advanced.agentHistorySummarizationMode', undefined, INTERNAL_RESTRICTED);
		export const AgentHistorySummarizationWithPromptCache = defineExpSetting<boolean | undefined>('chat.advanced.agentHistorySummarizationWithPromptCache', false, INTERNAL_RESTRICTED);
		export const AgentHistorySummarizationForceGpt41 = defineExpSetting<boolean | undefined>('chat.advanced.agentHistorySummarizationForceGpt41', false, INTERNAL_RESTRICTED);

		export const EnableApplyPatchTool = defineExpSetting<boolean>('chat.advanced.enableApplyPatchTool', isPreRelease, INTERNAL_RESTRICTED);
		export const EnableReadFileV2 = defineExpSetting<boolean>('chat.advanced.enableReadFileV2', isPreRelease, INTERNAL_RESTRICTED);
		export const AskAgent = defineExpSetting<boolean>('chat.advanced.enableAskAgent', { defaultValue: false, teamDefaultValue: true, internalDefaultValue: true }, INTERNAL_RESTRICTED);
		export const VerifyTextDocumentChanges = defineExpSetting<boolean>('chat.advanced.inlineEdits.verifyTextDocumentChanges', true, INTERNAL_RESTRICTED);
		export const EnableApplyPatchForNotebooks = defineExpSetting<boolean>('chat.advanced.enableApplyPatchForNotebooks', false, INTERNAL_RESTRICTED);
		export const OmitBaseAgentInstructions = defineSetting<boolean>('chat.advanced.omitBaseAgentInstructions', false, INTERNAL);

		export const PromptFileContext = defineExpSetting<boolean>('chat.advanced.promptFileContextProvider.enabled', true);
		export const GeminiReplaceString = defineExpSetting<boolean>('chat.advanced.geminiReplaceString.enabled', false, INTERNAL, { experimentName: 'copilotchat.geminiReplaceString' });
	}

	export const AgentThinkingTool = defineSetting<boolean>('chat.agent.thinkingTool', false);

	/** Add context from recently used files */
	export const TemporalContextInlineChatEnabled = defineExpSetting<boolean>('chat.editor.temporalContext.enabled', false);
	export const TemporalContextEditsEnabled = defineExpSetting<boolean>('chat.edits.temporalContext.enabled', false);
	/** User provided code generation instructions for the chat */
	export const CodeGenerationInstructions = defineSetting('chat.codeGeneration.instructions', [] as CodeGenerationInstruction[]);
	export const TestGenerationInstructions = defineSetting('chat.testGeneration.instructions', [] as CodeGenerationInstruction[]);
	export const CommitMessageGenerationInstructions = defineSetting('chat.commitMessageGeneration.instructions', [] as CommitMessageGenerationInstruction[]);
	export const PullRequestDescriptionGenerationInstructions = defineSetting('chat.pullRequestDescriptionGeneration.instructions', [] as CommitMessageGenerationInstruction[]);
	/** Show code lens "Generate tests" when we have test coverage info about this symbol and it's not covered */
	export const GenerateTestsCodeLens = defineSetting('chat.generateTests.codeLens', false);
	/** Whether new flows around setting up tests are enabled */
	export const SetupTests = defineSetting<boolean>('chat.setupTests.enabled', true);
	/** Whether the Copilot TypeScript context provider is enabled and if how */
	export const TypeScriptLanguageContext = defineExpSetting<boolean>('chat.languageContext.typescript.enabled', false);
	export const TypeScriptLanguageContextCacheTimeout = defineExpSetting<number>('chat.languageContext.typescript.cacheTimeout', 500);
	export const TypeScriptLanguageContextFix = defineExpSetting<boolean>('chat.languageContext.fix.typescript.enabled', false);
	export const TypeScriptLanguageContextInline = defineExpSetting<boolean>('chat.languageContext.inline.typescript.enabled', false);
	/** Enables the start debugging intent */
	export const StartDebuggingIntent = defineSetting('chat.startDebugging.enabled', true);
	export const UseInstructionFiles = defineSetting('chat.codeGeneration.useInstructionFiles', true);
	export const CodeFeedback = defineSetting('chat.reviewSelection.enabled', true);
	export const CodeFeedbackInstructions = defineSetting('chat.reviewSelection.instructions', [] as CodeGenerationInstruction[]);

	export const UseProjectTemplates = defineSetting('chat.useProjectTemplates', true);
	export const ExplainScopeSelection = defineSetting('chat.scopeSelection', false);
	export const EnableCodeActions = defineSetting('editor.enableCodeActions', true);
	export const LocaleOverride = defineSetting('chat.localeOverride', 'auto');
	export const TerminalChatLocation = defineSetting('chat.terminalChatLocation', 'chatView');
	export const AutomaticRenameSuggestions = defineSetting('renameSuggestions.triggerAutomatically', true);
	export const GitHistoryRelatedFilesProvider = defineSetting('chat.edits.suggestRelatedFilesFromGitHistory', true);
	export const Test2SrcRelatedFilesProvider = defineSetting('chat.edits.suggestRelatedFilesForTests', true);
	export const TerminalToDebuggerEnabled = defineSetting('chat.copilotDebugCommand.enabled', true);
	export const EditsCodeSearchAgentEnabled = defineSetting<boolean>('chat.edits.codesearch.enabled', false);
	export const CodeSearchAgentEnabled = defineSetting<boolean>('chat.codesearch.enabled', false);
	export const InlineEditsEnabled = defineExpSetting<boolean>('nextEditSuggestions.enabled', { defaultValue: false, teamDefaultValue: true });
	export const InlineEditsEnableDiagnosticsProvider = defineExpSetting<boolean>('nextEditSuggestions.fixes', { defaultValue: true, teamDefaultValue: true });
	export const AgentCanRunTasks = defineValidatedSetting('chat.agent.runTasks', vBoolean(), true);
	export const NewWorkspaceCreationAgentEnabled = defineSetting<boolean>('chat.newWorkspaceCreation.enabled', true);
	export const NewWorkspaceUseContext7 = defineSetting<boolean>('chat.newWorkspace.useContext7', false);
	export const SummarizeAgentConversationHistory = defineExpSetting<boolean>('chat.summarizeAgentConversationHistory.enabled', true);
	export const VirtualToolThreshold = defineExpSetting<number>('chat.virtualTools.threshold', HARD_TOOL_LIMIT);
	export const CurrentEditorAgentContext = defineSetting<boolean>('chat.agent.currentEditorContext.enabled', true);
	/** BYOK  */
	export const OllamaEndpoint = defineSetting<string>('chat.byok.ollamaEndpoint', 'http://localhost:11434');
	export const AzureModels = defineSetting<Record<string, { name: string; url: string; toolCalling: boolean; vision: boolean; maxInputTokens: number; maxOutputTokens: number; thinking?: boolean }>>('chat.azureModels', {});
	export const EditsCodeNewNotebookAgentEnabled = defineExpSetting<boolean>('chat.edits.newNotebook.enabled', true);
	export const AutoFixDiagnostics = defineSetting<boolean>('chat.agent.autoFix', true);
	export const NotebookFollowCellExecution = defineSetting<boolean>('chat.notebook.followCellExecution.enabled', false);
	export const CustomInstructionsInSystemMessage = defineSetting<boolean>('chat.customInstructionsInSystemMessage', true);

	export const EnableRetryAfterFilteredResponse = defineExpSetting<boolean>('chat.enableRetryAfterFilteredResponse', true);
}

export function getAllConfigKeys(): string[] {
	return Object.values(ConfigKey).flatMap(namespace =>
		Object.values(namespace).map(setting => setting.fullyQualifiedId)
	);
}

const nextEditProviderIds: string[] = [];
export function registerNextEditProviderId(providerId: string): string {
	nextEditProviderIds.push(providerId);
	return providerId;
}
