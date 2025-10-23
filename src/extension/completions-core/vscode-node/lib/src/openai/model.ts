/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionsEndpointProviderBridge } from '../../../bridge/src/completionsEndpointProviderBridge';
import { onCopilotToken } from '../auth/copilotTokenNotifier';
import { ConfigKey, getConfig } from '../config';
import { Context } from '../context';
import { Features } from '../experiments/features';
import { CompletionHeaders } from './fetch';
import { TelemetryWithExp } from '../telemetry';
import { TokenizerName } from '../../../prompt/src/tokenization';
import { ICompletionModelInformation, IEndpointProvider } from '../../../../../../platform/endpoint/common/endpointProvider';

const FallbackModelId = 'gpt-4o-copilot';
export class AvailableModelsManager {

	fetchedModelData: ICompletionModelInformation[] = [];
	customModels: string[] = [];
	editorPreviewFeaturesDisabled: boolean = false;
	private readonly _endpointProvider: IEndpointProvider;

	constructor(
		private _ctx: Context,
		shouldFetch: boolean = true
	) {
		this._endpointProvider = this._ctx.get(CompletionsEndpointProviderBridge).endpointProvider;
		if (shouldFetch) {
			onCopilotToken(this._ctx, () => this.refreshAvailableModels());
		}
	}

	// This will get its initial call after the initial token got fetched
	private async refreshAvailableModels(): Promise<void> {
		await this.refreshModels();
	}

	/**
	 * Returns the default model, determined by the order returned from the API
	 * Note: this does NOT fetch models to avoid side effects
	 */
	getDefaultModelId(): string {
		if (this.fetchedModelData) {
			const fetchedDefaultModel = AvailableModelsManager.filterCompletionModels(
				this.fetchedModelData,
				this.editorPreviewFeaturesDisabled
			)[0];

			if (fetchedDefaultModel) {
				return fetchedDefaultModel.id;
			}
		}

		return FallbackModelId;
	}

	async refreshModels(): Promise<void> {
		const fetchedData = await this._endpointProvider.getAllCompletionModels(true);
		if (fetchedData) {
			this.fetchedModelData = fetchedData;
		}
	}

	/**
	 * Returns a list of models that are available for generic completions.
	 * Calls to CAPI to retrieve the list.
	 */
	getGenericCompletionModels(): ModelItem[] {
		const filteredResult = AvailableModelsManager.filterCompletionModels(
			this.fetchedModelData,
			this.editorPreviewFeaturesDisabled
		);

		return AvailableModelsManager.mapCompletionModels(filteredResult);
	}

	getTokenizerForModel(modelId: string): TokenizerName {
		const modelItems = this.getGenericCompletionModels();
		const modelItem = modelItems.find(item => item.modelId === modelId);
		if (modelItem) {
			return modelItem.tokenizer as TokenizerName;
		}
		// The tokenizer the default model uses
		return TokenizerName.o200k;
	}

	static filterCompletionModels(data: ICompletionModelInformation[], editorPreviewFeaturesDisabled: boolean): ICompletionModelInformation[] {
		return data
			.filter(item => item.capabilities.type === 'completion')
			.filter(item => !editorPreviewFeaturesDisabled || item.preview === false || item.preview === undefined);
	}

	static filterModelsWithEditorPreviewFeatures(
		data: ICompletionModelInformation[],
		editorPreviewFeaturesDisabled: boolean
	): ICompletionModelInformation[] {
		return data.filter(
			item => !editorPreviewFeaturesDisabled || item.preview === false || item.preview === undefined
		);
	}

	static mapCompletionModels(data: ICompletionModelInformation[]): ModelItem[] {
		return data.map(item => ({
			modelId: item.id,
			label: item.name,
			preview: !!item.preview,
			tokenizer: item.capabilities.tokenizer,
		}));
	}

	getCurrentModelRequestInfo(featureSettings: TelemetryWithExp | undefined = undefined): ModelRequestInfo {
		const defaultModelId = this.getDefaultModelId();

		const debugOverride =
			getConfig<string>(this._ctx, ConfigKey.DebugOverrideEngine) ||
			getConfig<string>(this._ctx, ConfigKey.DebugOverrideEngineLegacy);

		if (debugOverride) {
			return new ModelRequestInfo(debugOverride, 'override');
		}

		const customEngine = featureSettings ? this._ctx.get(Features).customEngine(featureSettings) : '';
		if (customEngine) {
			return new ModelRequestInfo(customEngine, 'exp');
		}

		if (this.customModels.length > 0) {
			return new ModelRequestInfo(this.customModels[0], 'custommodel');
		}

		return new ModelRequestInfo(defaultModelId, 'default');
	}
}

interface ModelItem {
	modelId: string;
	label: string;
	preview: boolean;
	tokenizer: string;
}

export type ModelChoiceSourceTelemetryValue =
	| 'override'
	| 'modelpicker'
	| 'exp'
	| 'default'
	| 'custommodel'
	| 'prerelease';

class ModelRequestInfo {
	constructor(
		readonly modelId: string,
		readonly modelChoiceSource: ModelChoiceSourceTelemetryValue
	) { }

	get headers(): CompletionHeaders {
		return {};
	}
}
