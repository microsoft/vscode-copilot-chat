/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequest, LanguageModelChat } from 'vscode';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { CHAT_MODEL, EMBEDDING_MODEL } from '../../../configuration/common/configurationService';
import { IChatEndpoint, IEmbeddingEndpoint } from '../../../networking/common/networking';
import { ChatEndpointFamily, EmbeddingsEndpointFamily, IChatModelInformation, IEmbeddingModelInformation, IEndpointProvider } from '../../common/endpointProvider';
import { EmbeddingEndpoint } from '../../node/embeddingsEndpoint';
import { AzureTestEndpoint } from './azureEndpoint';
import { CAPITestEndpoint, modelIdToTokenizer } from './capiEndpoint';
import { CustomNesEndpoint } from './customNesEndpoint';
import { TestModelMetadataFetcher } from './testModelMetadataFetcher';

async function getModelMetadataMap(modelMetadataFetcher: TestModelMetadataFetcher): Promise<Map<string, IChatModelInformation>> {
	let metadataArray: IChatModelInformation[] = [];
	try {
		metadataArray = await modelMetadataFetcher.getAllChatModels();
	} catch (e) {
		metadataArray = [];
		// We only want to catch errors for the model lab models, otherwise we have no models to test and should just throw the error
		if (!modelMetadataFetcher.isModelLab) {
			throw e;
		}
	}
	const metadataMap = new Map<string, IChatModelInformation>();
	metadataArray.forEach(metadata => {
		metadataMap.set(metadata.id, metadata);
	});
	return metadataMap;
}

export class TestEndpointProvider implements IEndpointProvider {

	declare readonly _serviceBrand: undefined;

	private _testEmbeddingEndpoint: IEmbeddingEndpoint | undefined;
	private _chatEndpoints: Map<string, IChatEndpoint> = new Map();
	private _prodChatModelMetadata: Promise<Map<string, IChatModelInformation>>;
	private _modelLabChatModelMetadata: Promise<Map<string, IChatModelInformation>>;

	constructor(
		private readonly gpt4ModelToRunAgainst: string | undefined,
		private readonly gpt4oMiniModelToRunAgainst: string | undefined,
		private readonly embeddingModelToRunAgainst: EMBEDDING_MODEL | undefined,
		_fastRewriteModelToRunAgainst: string | undefined,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		const prodModelMetadata = this._instantiationService.createInstance(TestModelMetadataFetcher, undefined, false);
		const modelLabModelMetadata = this._instantiationService.createInstance(TestModelMetadataFetcher, undefined, true);
		this._prodChatModelMetadata = getModelMetadataMap(prodModelMetadata);
		this._modelLabChatModelMetadata = getModelMetadataMap(modelLabModelMetadata);

	}

	private async getChatEndpointInfo(model: string, modelLabMetadata: Map<string, IChatModelInformation>, prodMetadata: Map<string, IChatModelInformation>): Promise<IChatEndpoint> {
		let chatEndpoint = this._chatEndpoints.get(model);
		if (!chatEndpoint) {
			if (model === CHAT_MODEL.CUSTOM_NES) {
				chatEndpoint = this._instantiationService.createInstance(CustomNesEndpoint);
			} else if (model === CHAT_MODEL.EXPERIMENTAL) {
				chatEndpoint = this._instantiationService.createInstance(AzureTestEndpoint, model);
			} else {
				const isProdModel = prodMetadata.has(model);
				const modelMetadata: IChatModelInformation | undefined = isProdModel ? prodMetadata.get(model) : modelLabMetadata.get(model);
				if (!modelMetadata) {
					throw new Error(`Model ${model} not found`);
				}
				chatEndpoint = this._instantiationService.createInstance(CAPITestEndpoint, modelMetadata, !isProdModel);
			}
			this._chatEndpoints.set(model, chatEndpoint);
		}
		return chatEndpoint;
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		const modelIDs: Set<string> = new Set([
			CHAT_MODEL.CUSTOM_NES
		]);
		const modelLabMetadata: Map<string, IChatModelInformation> = await this._modelLabChatModelMetadata;
		const prodMetadata: Map<string, IChatModelInformation> = await this._prodChatModelMetadata;
		modelLabMetadata.forEach((modelMetadata) => {
			modelIDs.add(modelMetadata.id);
		});
		prodMetadata.forEach((modelMetadata) => {
			modelIDs.add(modelMetadata.id);
		});
		for (const model of modelIDs) {
			this._chatEndpoints.set(model, await this.getChatEndpointInfo(model, modelLabMetadata, prodMetadata));
		}
		return Array.from(this._chatEndpoints.values());
	}

	async getEmbeddingsEndpoint(family: EmbeddingsEndpointFamily): Promise<IEmbeddingEndpoint> {
		const id = this.embeddingModelToRunAgainst ?? EMBEDDING_MODEL.TEXT3SMALL;
		const modelInformation: IEmbeddingModelInformation = {
			id: id,
			name: id,
			version: '1.0',
			model_picker_enabled: false,
			is_chat_default: false,
			billing: { is_premium: false, multiplier: 0 },
			is_chat_fallback: false,
			capabilities: {
				type: 'embeddings',
				tokenizer: modelIdToTokenizer(id),
				family: 'test'
			}
		};
		this._testEmbeddingEndpoint ??= this._instantiationService.createInstance(EmbeddingEndpoint, modelInformation);
		return this._testEmbeddingEndpoint;
	}

	async getChatEndpoint(requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		if (typeof requestOrFamilyOrModel !== 'string') {
			requestOrFamilyOrModel = 'gpt-4.1';
		}
		if (requestOrFamilyOrModel === 'gpt-4.1') {
			return await this.getChatEndpointInfo(this.gpt4ModelToRunAgainst ?? CHAT_MODEL.GPT41, await this._modelLabChatModelMetadata, await this._prodChatModelMetadata);
		} else {
			return await this.getChatEndpointInfo(this.gpt4oMiniModelToRunAgainst ?? CHAT_MODEL.GPT4OMINI, await this._modelLabChatModelMetadata, await this._prodChatModelMetadata);
		}
	}
}
