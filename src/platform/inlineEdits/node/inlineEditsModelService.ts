/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { filterMap } from '../../../util/common/arrays';
import * as errors from '../../../util/common/errors';
import { createTracer } from '../../../util/common/tracing';
import { pushMany } from '../../../util/vs/base/common/arrays';
import { softAssert } from '../../../util/vs/base/common/assert';
import { Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { derived, IObservable, observableFromEvent } from '../../../util/vs/base/common/observable';
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

const enum ModelSource {
	LocalConfig = 'localConfig',
	ExpConfig = 'expConfig',
	ExpDefaultConfig = 'expDefaultConfig',
	Fetched = 'fetched',
	HardCodedDefault = 'hardCodedDefault',
}

type Model = {
	modelName: string;
	promptingStrategy: PromptingStrategy | undefined;
	includeTagsInCurrentFile: boolean;
	source: ModelSource;
}

type ModelInfo = {
	models: Model[];
	currentModelId: string;
}

export class InlineEditsModelService extends Disposable implements IInlineEditsModelService {

	_serviceBrand: undefined;

	private static readonly COPILOT_NES_XTAB_MODEL: Model = {
		modelName: 'copilot-nes-xtab',
		promptingStrategy: PromptingStrategy.CopilotNesXtab,
		includeTagsInCurrentFile: true,
		source: ModelSource.HardCodedDefault,
	};

	private static readonly COPILOT_NES_OCT: Model = {
		modelName: 'copilot-nes-oct',
		promptingStrategy: PromptingStrategy.Xtab275,
		includeTagsInCurrentFile: false,
		source: ModelSource.HardCodedDefault,
	};

	private _copilotTokenObs = observableFromEvent(this, this._tokenStore.onDidStoreUpdate, () => this._tokenStore.copilotToken);

	// TODO@ulugbekna: use a derived observable such that it fires only when nesModels change
	private _fetchedModelsObs = observableFromEvent(this, this._proxyModelsService.onModelListUpdated, () => this._proxyModelsService.nesModels);

	private _preferredModelNameObs = this._configService.getExperimentBasedConfigObservable(ConfigKey.Advanced.InlineEditsPreferredModel, this._expService);
	private _localModelConfigObs = this._configService.getConfigObservable(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfiguration);
	private _expBasedModelConfigObs = this._configService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfigurationString, this._expService);
	private _defaultModelConfigObs = this._configService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsXtabProviderDefaultModelConfigurationString, this._expService);

	private _models: IObservable<Model[]>;
	private _currentModelIdObs: IObservable<Model>;
	private _modelInfo: IObservable<ModelInfo>;

	public readonly onModelListUpdated: Event<void>;

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

		this._models = derived((reader) => {
			tracer.trace('computing models');
			return this.computeModelInfo({
				copilotToken: this._copilotTokenObs.read(reader),
				fetchedNesModels: this._fetchedModelsObs.read(reader),
				localModelConfig: this._localModelConfigObs.read(reader),
				modelConfigString: this._expBasedModelConfigObs.read(reader),
				defaultModelConfigString: this._defaultModelConfigObs.read(reader),
			});
		}).recomputeInitiallyAndOnChange(this._store);

		this._currentModelIdObs = derived<Model, void>((reader) => {
			tracer.trace('computing current model');
			return this._pickModel({
				preferredModelName: this._preferredModelNameObs.read(reader),
				models: this._models.read(reader),
			});
		}).recomputeInitiallyAndOnChange(this._store);

		this._modelInfo = derived((reader) => {
			tracer.trace('computing model info');
			return {
				models: this._models.read(reader),
				currentModelId: this._currentModelIdObs.read(reader).modelName,
			};
		}).recomputeInitiallyAndOnChange(this._store);

		this.onModelListUpdated = Event.fromObservableLight(this._modelInfo);
	}

	get modelInfo(): vscode.InlineCompletionModelInfo | undefined {
		const models: vscode.InlineCompletionModel[] = this._models.get().map(m => ({
			id: m.modelName,
			name: m.modelName,
		}));

		const currentModel = this._currentModelIdObs.get();

		return {
			models,
			currentModelId: currentModel.modelName,
		};
	}


	async setCurrentModelId(modelId: string): Promise<void> {
		const preferredModel = this._configService.getExperimentBasedConfig(ConfigKey.Advanced.InlineEditsPreferredModel, this._expService);

		const isSameModel = preferredModel === modelId;
		if (isSameModel) {
			return;
		}

		if (!this._models.get().some(m => m.modelName === modelId)) {
			this._logService.warn(`Trying to set unknown model id: ${modelId}`);
			return;
		}

		// if user picks same as the default model, we should reset the user setting
		// otherwise, update the model

		await this._configService.setConfig(ConfigKey.Advanced.InlineEditsPreferredModel, modelId);
	}

	private computeModelInfo(
		{
			copilotToken,
			fetchedNesModels,
			localModelConfig,
			modelConfigString,
			defaultModelConfigString,
		}: {
			copilotToken: CopilotToken | undefined;
			fetchedNesModels: WireTypes.Model.t[] | undefined;
			localModelConfig: ModelConfiguration | undefined;
			modelConfigString: string | undefined;
			defaultModelConfigString: string | undefined;
		},
	): Model[] {
		const tracer = this._tracer.sub('computeModelInfo');

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
				models.push({ ...localModelConfig, source: ModelSource.LocalConfig });
			}
		}

		if (modelConfigString) {
			tracer.trace('Parsing modelConfigurationString...');
			const parsedConfig = this.parseModelConfigStringSetting(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfigurationString);
			if (parsedConfig && !models.some(m => m.modelName === parsedConfig.modelName)) {
				tracer.trace(`Adding model from modelConfigurationString: ${parsedConfig.modelName}`);
				models.push({ ...parsedConfig, source: ModelSource.ExpConfig });
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
					source: ModelSource.Fetched,
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

		return models;
	}

	public selectedModelConfiguration(): ModelConfiguration {
		const tracer = this._tracer.sub('selectedModelConfiguration');
		const currentModel = this._currentModelIdObs.get();
		tracer.trace(`Current model id: ${currentModel.modelName}`);
		const model = this._models.get().find(m => m.modelName === currentModel.modelName);
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
				return { ...parsedConfig, source: ModelSource.ExpDefaultConfig };
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
	}): Model {
		const userHasPreferredModel = preferredModelName !== 'none';

		// FIXME@ulugbekna: respect exp-set model name

		if (userHasPreferredModel) {
			const preferredModel = models.find(m => m.modelName === preferredModelName);
			if (preferredModel) {
				return preferredModel;
			}
		}

		softAssert(models.length > 0, 'InlineEdits model list should have at least one model');

		const model = models.at(0);
		if (model) {
			return model;
		}

		return this.determineDefaultModel(undefined, undefined);
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
