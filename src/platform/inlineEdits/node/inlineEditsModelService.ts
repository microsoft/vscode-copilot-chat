/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isDeepStrictEqual } from 'util';
import type * as vscode from 'vscode';
import { filterMap } from '../../../util/common/arrays';
import * as errors from '../../../util/common/errors';
import { createTracer } from '../../../util/common/tracing';
import { pushMany } from '../../../util/vs/base/common/arrays';
import { softAssert } from '../../../util/vs/base/common/assert';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { autorun, observableFromEvent } from '../../../util/vs/base/common/observable';
import { CopilotToken } from '../../authentication/common/copilotToken';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { ConfigKey, ExperimentBasedConfig, IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { IProxyModelsService } from '../../proxyModels/common/proxyModelsService';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { WireTypes } from '../common/dataTypes/inlineEditsModelsTypes';
import { isPromptingStrategy, ModelConfiguration, PromptingStrategy } from '../common/dataTypes/xtabPromptOptions';
import { IInlineEditsModelService } from '../common/inlineEditsModelService';

type Model = {
	modelName: string;
	promptingStrategy: PromptingStrategy | undefined;
	includeTagsInCurrentFile: boolean;
}

export class InlineEditsModelService extends Disposable implements IInlineEditsModelService {

	_serviceBrand: undefined;

	private static readonly COPILOT_NES_XTAB_MODEL: Model = {
		modelName: 'copilot-nes-xtab',
		promptingStrategy: PromptingStrategy.CopilotNesXtab,
		includeTagsInCurrentFile: true,
	};

	private static readonly COPILOT_NES_OCT: Model = {
		modelName: 'copilot-nes-oct',
		promptingStrategy: PromptingStrategy.Xtab275,
		includeTagsInCurrentFile: false,
	};

	private _copilotTokenObs = observableFromEvent(this, this._tokenStore.onDidStoreUpdate, () => this._tokenStore.copilotToken);

	// TODO@ulugbekna: use a derived observable such that it fires only when nesModels change
	private _fetchedModelsObs = observableFromEvent(this, this._proxyModelsService.onModelListUpdated, () => this._proxyModelsService.nesModels);

	private _preferredModelNameObs = this._configService.getExperimentBasedConfigObservable(ConfigKey.Advanced.InlineEditsPreferredModel, this._expService);
	private _localModelConfigObs = this._configService.getConfigObservable(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfiguration);
	private _expBasedModelConfigObs = this._configService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfigurationString, this._expService);
	private _defaultModelConfigObs = this._configService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsXtabProviderDefaultModelConfigurationString, this._expService);

	private _modelInfo: { readonly modelList: readonly Model[]; readonly currentModelId: string };

	private readonly _onModelListUpdated = this._register(new Emitter<void>());
	public readonly onModelListUpdated = this._onModelListUpdated.event;

	private _tracer = createTracer(['NES', 'ModelsService'], (msg) => this._logService.trace(msg));

	constructor(
		@ICopilotTokenStore private readonly _tokenStore: ICopilotTokenStore,
		@IProxyModelsService private readonly _proxyModelsService: IProxyModelsService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		const tracer = this._tracer.sub('constructor');

		const defaultModel = this.determineDefaultModel(this._copilotTokenObs.get(), this._defaultModelConfigObs.get());

		this._modelInfo = { modelList: [defaultModel], currentModelId: defaultModel.modelName };

		tracer.trace('initial modelInfo', this._modelInfo);

		this._register(autorun((reader) => {
			this.refreshModelsInfo({
				copilotToken: this._copilotTokenObs.read(reader),
				fetchedNesModels: this._fetchedModelsObs.read(reader),
				preferredModelName: this._preferredModelNameObs.read(reader),
				localModelConfig: this._localModelConfigObs.read(reader),
				modelConfigString: this._expBasedModelConfigObs.read(reader),
				defaultModelConfigString: this._defaultModelConfigObs.read(reader),
			});
		}));

		tracer.trace('updated model info', this._modelInfo);
	}

	get modelInfo(): vscode.InlineCompletionModelInfo | undefined {
		const tracer = this._tracer.sub('modelInfo.getter');

		tracer.trace('model info', this._modelInfo);

		const models: vscode.InlineCompletionModel[] = this._modelInfo.modelList.map(m => ({
			id: m.modelName,
			name: m.modelName,
		}));

		return {
			models,
			currentModelId: this._modelInfo.currentModelId,
		};
	}


	async setCurrentModelId(modelId: string): Promise<void> {
		if (this._modelInfo.currentModelId === modelId) {
			return;
		}
		if (!this._modelInfo.modelList.some(m => m.modelName === modelId)) {
			this._logService.warn(`Trying to set unknown model id: ${modelId}`);
			return;
		}
		this._modelInfo = { ...this._modelInfo, currentModelId: modelId };
		await this._configService.setConfig(ConfigKey.Advanced.InlineEditsPreferredModel, modelId);
		this._onModelListUpdated.fire();
	}

	async refreshModelsInfo(
		{
			copilotToken,
			fetchedNesModels,
			preferredModelName,
			localModelConfig,
			modelConfigString,
			defaultModelConfigString,
		}: {
			copilotToken: CopilotToken | undefined;
			fetchedNesModels: WireTypes.Model.t[] | undefined;
			preferredModelName: string;
			localModelConfig: ModelConfiguration | undefined;
			modelConfigString: string | undefined;
			defaultModelConfigString: string | undefined;
		},
	): Promise<void> {

		const tracer = this._tracer.sub('refreshModelsInfo');

		tracer.trace('Fetching latest models...');

		const models: Model[] = [];

		// priority of adding models to the list:
		// 0. model from user local setting
		// 1. model from modelConfigurationString setting (set through ExP)
		// 2. fetched models from /models endpoint (if useSlashModels is true)

		if (localModelConfig) {
			if (models.some(m => m.modelName === localModelConfig.modelName)) {
				tracer.trace('Local model configuration already exists in the model list, skipping.');
			} else {
				tracer.trace(`Adding local model configuration: ${localModelConfig.modelName}`);
				models.push({ ...localModelConfig });
			}
		}

		if (modelConfigString) {
			tracer.trace('Parsing modelConfigurationString...');
			const parsedConfig = this.parseModelConfigStringSetting(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfigurationString);
			if (parsedConfig && !models.some(m => m.modelName === parsedConfig.modelName)) {
				tracer.trace(`Adding model from modelConfigurationString: ${parsedConfig.modelName}`);
				models.push({ ...parsedConfig });
			} else {
				tracer.trace('No valid model found in modelConfigurationString.');
			}
		}

		const useSlashModels = this._configService.getExperimentBasedConfig(ConfigKey.TeamInternal.InlineEditsUseSlashModels, this._expService);
		if (useSlashModels && fetchedNesModels && fetchedNesModels.length > 0) {
			tracer.trace(`Processing ${fetchedNesModels.length} fetched models...`);
			const filteredFetchedModels = filterMap(fetchedNesModels, (m) => {
				if (!isPromptingStrategy(m.capabilities.promptStrategy)) {
					return undefined;
				}
				return {
					modelName: m.name,
					promptingStrategy: m.capabilities.promptStrategy,
					includeTagsInCurrentFile: false, // FIXME@ulugbekna: determine this based on model capabilities and config
				} satisfies Model;
			});
			tracer.trace(`Adding ${filteredFetchedModels.length} fetched models after filtering.`);
			pushMany(models, filteredFetchedModels);
		} else {
			// push default model if /models doesn't give us any models
			tracer.trace(`adding built-in default model: useSlashModels ${useSlashModels}, fetchedNesModels ${fetchedNesModels}`);

			const defaultModel = this.determineDefaultModel(copilotToken, defaultModelConfigString);
			if (defaultModel) {
				if (models.some(m => m.modelName === defaultModel.modelName)) {
					tracer.trace('Default model configuration already exists in the model list, skipping.');
				} else {
					tracer.trace(`Adding default model configuration: ${defaultModel.modelName}`);
					models.push(defaultModel);
				}
			}
		}

		const hasModelListChanged = !isDeepStrictEqual(this._modelInfo.modelList, models);

		if (!hasModelListChanged) {
			tracer.trace('Model list unchanged, not updating.');
		} else {
			this._modelInfo = {
				modelList: models,
				currentModelId: this._pickModel({ preferredModelName, models }),
			};
			tracer.trace('Model list updated, firing event.');
			this._onModelListUpdated.fire();
		}
	}

	public selectedModelConfiguration(): ModelConfiguration {
		const tracer = this._tracer.sub('selectedModelConfiguration');
		const model = this._modelInfo.modelList.find(m => m.modelName === this._modelInfo.currentModelId);
		if (model) {
			tracer.trace(`Selected model found: ${model.modelName}`);
			return {
				modelName: model.modelName,
				promptingStrategy: model.promptingStrategy,
				includeTagsInCurrentFile: model.includeTagsInCurrentFile,
			};
		}
		tracer.trace('No selected model found, using default model.');
		return this.determineDefaultModel(undefined, undefined);
	}

	private determineDefaultModel(copilotToken: CopilotToken | undefined, defaultModelConfigString: string | undefined): Model {
		// if a default model config string is specified, use that
		if (defaultModelConfigString) {
			const parsedConfig = this.parseModelConfigStringSetting(ConfigKey.TeamInternal.InlineEditsXtabProviderDefaultModelConfigurationString);
			if (parsedConfig) {
				return { ...parsedConfig };
			}
		}

		// otherwise, use built-in defaults
		if (copilotToken?.isFcv1()) {
			return InlineEditsModelService.COPILOT_NES_XTAB_MODEL;
		} else {
			return InlineEditsModelService.COPILOT_NES_OCT;
		}
	}

	private _pickModel({
		preferredModelName,
		models
	}: {
		preferredModelName: string;
		models: Model[];
	}): string {
		const userHasPreferredModel = preferredModelName !== 'none';

		// FIXME@ulugbekna: respect exp-set model name

		if (userHasPreferredModel && models.some(m => m.modelName === preferredModelName)) {
			return preferredModelName;
		}

		softAssert(models.length > 0, 'InlineEdits model list should have at least one model');

		if (models.length > 0) {
			return models[0].modelName;
		}

		return this.determineDefaultModel(undefined, undefined).modelName;
	}

	private parseModelConfigStringSetting(configKey: ExperimentBasedConfig<string | undefined>): ModelConfiguration | undefined {
		const configString = this._configService.getExperimentBasedConfig(configKey, this._expService);
		if (configString === undefined) {
			return undefined;
		}

		let parsedConfig: ModelConfiguration | undefined;
		try {
			parsedConfig = JSON.parse(configString);
			// FIXME@ulugbekna: validate parsedConfig structure
		} catch (e: unknown) {
			/* __GDPR__
				"incorrectNesModelConfig" : {
					"owner": "ulugbekna",
					"comment": "Capture if model configuration string is invalid JSON.",
					"configName": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Name of the configuration that failed to parse." },
					"errorMessage": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "Error message from JSON.parse." },
					"configValue": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The invalid JSON string." }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('incorrectNesModelConfig', { configName: configKey.id, errorMessage: errors.toString(errors.fromUnknown(e)), configValue: configString });
		}

		return parsedConfig;
	}
}
