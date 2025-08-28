/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken, Progress, SettingsSearchProviderOptions, SettingsSearchResult, SettingsSearchResultKind } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { Embeddings, EmbeddingType, IEmbeddingsComputer } from '../../../platform/embeddings/common/embeddingsComputer';
import { ICombinedEmbeddingIndex, SettingListItem } from '../../../platform/embeddings/common/vscodeIndex';
import { ChatEndpointFamily, IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ISettingsEditorSearchService } from '../../../platform/settingsEditor/common/settingsEditorSearchService';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { SettingsEditorSearchResultsSelector } from '../node/settingsEditorSearchResultsSelector';

export class SettingsEditorSearchServiceImpl implements ISettingsEditorSearchService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@ICombinedEmbeddingIndex private readonly embeddingIndex: ICombinedEmbeddingIndex,
		@IEmbeddingsComputer private readonly embeddingsComputer: IEmbeddingsComputer,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
	}

	async provideSettingsSearchResults(query: string, options: SettingsSearchProviderOptions, progress: Progress<SettingsSearchResult>, token: CancellationToken): Promise<void> {
		if (!query || options.limit <= 0) {
			return;
		}

		const canceledBundle: SettingsSearchResult = {
			query,
			kind: SettingsSearchResultKind.CANCELED,
			settings: []
		};

		let embeddingResult: Embeddings;
		try {
			embeddingResult = await this.embeddingsComputer.computeEmbeddings(EmbeddingType.text3small_512, [query], {}, new TelemetryCorrelationId('SettingsEditorSearchServiceImpl::provideSettingsSearchResults'), token);
		} catch {
			if (token.isCancellationRequested) {
				progress.report(canceledBundle);
				return;
			}

			progress.report({
				query,
				kind: SettingsSearchResultKind.EMBEDDED,
				settings: []
			});
			if (!options.embeddingsOnly) {
				progress.report({
					query,
					kind: SettingsSearchResultKind.LLM_RANKED,
					settings: []
				});
			}
			return;
		}

		if (token.isCancellationRequested) {
			progress.report(canceledBundle);
			return;
		}

		await this.embeddingIndex.loadIndexes();
		const embeddingSettings: SettingListItem[] = this.embeddingIndex.settingsIndex.nClosestValues(embeddingResult.values[0], 25);
		if (token.isCancellationRequested) {
			progress.report(canceledBundle);
			return;
		}
		progress.report({
			query,
			kind: SettingsSearchResultKind.EMBEDDED,
			settings: embeddingSettings.map(setting => setting.key)
		});

		if (options.embeddingsOnly) {
			return;
		}

		const copilotToken = await this.authenticationService.getCopilotToken();
		if (embeddingSettings.length === 0 || copilotToken.isFreeUser) {
			progress.report({
				query,
				kind: SettingsSearchResultKind.LLM_RANKED,
				settings: []
			});
			return;
		}

		const endpointName: ChatEndpointFamily = 'copilot-base';
		const endpoint = await this.endpointProvider.getChatEndpoint(endpointName);
		const generator = this.instantiationService.createInstance(SettingsEditorSearchResultsSelector);
		const llmSearchSuggestions = await generator.selectTopSearchResults(endpoint, query, embeddingSettings, token);
		if (token.isCancellationRequested) {
			progress.report(canceledBundle);
			return;
		}
		progress.report({
			query,
			kind: SettingsSearchResultKind.LLM_RANKED,
			settings: llmSearchSuggestions
		});
	}
}