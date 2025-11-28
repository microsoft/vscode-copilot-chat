/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isDeepStrictEqual } from 'util';
import type * as vscode from 'vscode';
import { filterMap } from '../../../util/common/arrays';
import * as errors from '../../../util/common/errors';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { autorun, IObservable, observableFromEvent } from '../../../util/vs/base/common/observable';
import { CopilotToken } from '../../authentication/common/copilotToken';
import { ICopilotTokenStore } from '../../authentication/common/copilotTokenStore';
import { ConfigKey, ExperimentBasedConfig, IConfigurationService } from '../../configuration/common/configurationService';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { ILogService } from '../../log/common/logService';
import { IFetcherService, Response } from '../../networking/common/fetcherService';
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

const IN_TESTING = false;
const STUB_MODELS_FOR_TESTING: WireTypes.ModelList.t = {
	models: [
		{
			name: 'model-1',
			api_provider: 'openai',
			capabilities: {
				promptStrategy: 'codexv21nesUnified',
			},
		},
		{
			name: 'model-2',
			api_provider: 'openai',
			capabilities: {
				promptStrategy: 'xtabUnifiedModel',
			},
		},
		{
			name: 'model-3',
			api_provider: 'openai',
			capabilities: {
				promptStrategy: 'xtab-v1',
			},
		}
	],
};

export class InlineEditsModelService extends Disposable implements IInlineEditsModelService {

	_serviceBrand: undefined;

	private static HARDCODED_DEFAULT_MODEL: Model = {
		modelName: 'copilot-nes-xtab',
		promptingStrategy: undefined,
		includeTagsInCurrentFile: true,
	};

	private _isEnabledObs: IObservable<boolean> = this._configService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsModelPickerEnabled, this._expService);

	private _copilotTokenObs = observableFromEvent(this, this._tokenStore.onDidStoreUpdate, () => this._tokenStore.copilotToken);

	private _preferredModelNameObs = this._configService.getExperimentBasedConfigObservable(ConfigKey.Advanced.InlineEditsPreferredModel, this._expService);
	private _localModelConfigObs = this._configService.getConfigObservable(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfiguration);
	private _expBasedModelConfigObs = this._configService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfigurationString, this._expService);
	private _defaultModelConfigObs = this._configService.getExperimentBasedConfigObservable(ConfigKey.TeamInternal.InlineEditsXtabProviderDefaultModelConfigurationString, this._expService);

	private _modelList: Model[] | undefined;

	private _currentModelId: string | undefined;

	private readonly _onModelListUpdated = this._register(new Emitter<void>());
	public readonly onModelListUpdated = this._onModelListUpdated.event;

	get modelInfo(): vscode.InlineCompletionModelInfo | undefined {
		if (!this._modelList) {
			return undefined;
		}

		const models: vscode.InlineCompletionModel[] = this._modelList.map(m => ({
			id: m.modelName,
			name: m.modelName,
		}));

		this._selectModel(this._preferredModelNameObs.get(), this._modelList);

		return {
			models,
			currentModelId: this._currentModelId || InlineEditsModelService.HARDCODED_DEFAULT_MODEL.modelName,
		};
	}

	constructor(
		@ICAPIClientService private readonly _capiClient: ICAPIClientService,
		@IFetcherService private readonly _fetchService: IFetcherService,
		@ICopilotTokenStore private readonly _tokenStore: ICopilotTokenStore,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IExperimentationService private readonly _expService: IExperimentationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._register(
			autorun((reader) => {
				const isEnabled = this._isEnabledObs.read(reader);
				if (!isEnabled) {
					return;
				}

				reader.store.add(autorun((reader) => {
					this.refreshModelsInfo({
						copilotToken: this._copilotTokenObs.read(reader),
						preferredModelName: this._preferredModelNameObs.read(reader),
						localModelConfig: this._localModelConfigObs.read(reader),
						modelConfigString: this._expBasedModelConfigObs.read(reader),
						defaultModelConfigString: this._defaultModelConfigObs.read(reader),
					});
				}));

				reader.store.add({
					dispose: () => {
						this._modelList = undefined;
						this._currentModelId = undefined;
						this._onModelListUpdated.fire();
					}
				});

				// FIXME@ulugbekna: should I manually run it once here?
				this.refreshModelsInfo({
					copilotToken: this._tokenStore.copilotToken,
					preferredModelName: this._preferredModelNameObs.get(),
					localModelConfig: this._localModelConfigObs.get(),
					modelConfigString: this._expBasedModelConfigObs.get(),
					defaultModelConfigString: this._defaultModelConfigObs.get(),
				});
			})
		);
	}

	async setCurrentModelId(modelId: string): Promise<void> {
		this._currentModelId = modelId;
		await this._configService.setConfig(ConfigKey.Advanced.InlineEditsPreferredModel, modelId);
		this._onModelListUpdated.fire();
	}

	async refreshModelsInfo(
		{
			copilotToken,
			preferredModelName,
			localModelConfig,
			modelConfigString,
			defaultModelConfigString,
		}: {
			copilotToken: CopilotToken | undefined;
			preferredModelName: string;
			localModelConfig: ModelConfiguration | undefined;
			modelConfigString: string | undefined;
			defaultModelConfigString: string | undefined;
		},
	): Promise<void> {
		let models: Model[] = [];

		if (copilotToken) {
			const fetchedModels = await this._fetchLatestModels(copilotToken);
			if (fetchedModels) {
				models = filterMap(fetchedModels.models, (m) => {
					if (!isPromptingStrategy(m.capabilities.promptStrategy)) {
						return undefined;
					}
					return {
						modelName: m.name,
						promptingStrategy: m.capabilities.promptStrategy,
						includeTagsInCurrentFile: false, // FIXME@ulugbekna: determine this based on model capabilities and config
					} satisfies Model;
				});
			}
		}

		if (localModelConfig && !models.some(m => m.modelName === localModelConfig.modelName)) {
			models.push({ ...localModelConfig });
		}

		if (modelConfigString) {
			const parsedConfig = this.parseModelConfigStringSetting(ConfigKey.TeamInternal.InlineEditsXtabProviderModelConfigurationString);
			if (parsedConfig && !models.some(m => m.modelName === parsedConfig.modelName)) {
				models.push({ ...parsedConfig });
			}
		}

		if (defaultModelConfigString) {
			const parsedConfig = this.parseModelConfigStringSetting(ConfigKey.TeamInternal.InlineEditsXtabProviderDefaultModelConfigurationString);
			if (parsedConfig && !models.some(m => m.modelName === parsedConfig.modelName)) {
				models.push({ ...parsedConfig });
			}
		} else {
			// Add a hardcoded default model if nothing else is specified
			if (!models.some(m => m.modelName === InlineEditsModelService.HARDCODED_DEFAULT_MODEL.modelName)) {
				models.push({ ...InlineEditsModelService.HARDCODED_DEFAULT_MODEL });
			}
		}

		if (!isDeepStrictEqual(this._modelList, models)) {
			this._modelList = models;
			this._onModelListUpdated.fire();
		}

		// select model
		this._selectModel(preferredModelName, models);
	}

	public selectedModelConfiguration(): ModelConfiguration {
		const model = this._modelList?.find(m => m.modelName === this._currentModelId);
		if (model) {
			return {
				modelName: model.modelName,
				promptingStrategy: model.promptingStrategy,
				includeTagsInCurrentFile: model.includeTagsInCurrentFile,
			};
		}
		return InlineEditsModelService.HARDCODED_DEFAULT_MODEL;
	}

	private _selectModel(preferredModelName: string, models: Model[]): void {
		if (this._currentModelId === undefined) {
			if (preferredModelName !== 'none' && models.some(m => m.modelName === preferredModelName)) {
				this._currentModelId = preferredModelName;
			} else if (models.length > 0) {
				this._currentModelId = models[0].modelName; // FIXME@ulugbekna: I think the first entry should be modelConfigurationString maybe
			}
		}
	}

	private async _fetchLatestModels(copilotToken: CopilotToken | undefined): Promise<WireTypes.ModelList.t | undefined> {
		if (!copilotToken) {
			return undefined;
		}

		if (IN_TESTING) {
			return STUB_MODELS_FOR_TESTING;
		}

		const url = `${this._capiClient.proxyBaseURL}/models`;

		let r: Response;
		try {
			r = await this._fetchService.fetch(url, {
				headers: {
					'Authorization': copilotToken.token,
				},
				method: 'GET',
				timeout: 10_000,
			});
		} catch (e) {
			this._logService.error('Failed to fetch model list', e);
			return;
		}

		if (!r.ok) {
			this._logService.error(`Failed to fetch model list: ${r.status} ${r.statusText}`);
			return;
		}

		try {
			const jsonData: unknown = await r.json();
			if (!WireTypes.ModelList.is(jsonData)) {
				throw new Error('Invalid model list response'); // TODO@ulugbekna: add telemetry
			}
			return jsonData;
		} catch (e) {
			this._logService.error(e, 'Failed to process /models response');
			return;
		}
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
