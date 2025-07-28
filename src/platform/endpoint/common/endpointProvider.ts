/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { RequestMetadata } from '@vscode/copilot-api';
import type { LanguageModelChat } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { TokenizerType } from '../../../util/common/tokenizer';
import type { ChatRequest } from '../../../vscodeTypes';
import { IChatEndpoint, IEmbeddingEndpoint } from '../../networking/common/networking';

export type ModelPolicy = {
	state: 'enabled' | 'disabled' | 'unconfigured';
	terms?: string;
};

export type IChatModelCapabilities = {
	type: 'chat';
	family: string;
	tokenizer: TokenizerType;
	limits?: {
		max_prompt_tokens?: number;
		max_output_tokens?: number;
		max_context_window_tokens?: number;
	};
	supports: {
		parallel_tool_calls?: boolean;
		tool_calls?: boolean;
		// Whether or not the model supports streaming, if not explicitly true we will try to parse the response as not streamed
		streaming: boolean | undefined;
		vision?: boolean;
		prediction?: boolean;
		thinking?: boolean;
	};
};

export type IEmbeddingModelCapabilities = {
	type: 'embeddings';
	family: string;
	tokenizer: TokenizerType;
	limits?: { max_inputs?: number };
};

type ICompletionsModelCapabilities = {
	type: 'completions';
	family: string;
	tokenizer: TokenizerType;
}

export interface IModelAPIResponse {
	id: string;
	name: string;
	policy?: ModelPolicy;
	model_picker_enabled: boolean;
	preview?: boolean;
	is_chat_default: boolean;
	is_chat_fallback: boolean;
	version: string;
	billing?: { is_premium: boolean; multiplier: number; restricted_to?: string[] };
	capabilities: IChatModelCapabilities | IEmbeddingModelCapabilities | ICompletionsModelCapabilities;
}

export type IChatModelInformation = IModelAPIResponse & {
	capabilities: IChatModelCapabilities;
	urlOrRequestMetadata?: string | RequestMetadata;
};
export type IEmbeddingModelInformation = IModelAPIResponse & { capabilities: IEmbeddingModelCapabilities };

export function isChatModelInformation(model: IModelAPIResponse): model is IChatModelInformation {
	return model.capabilities.type === 'chat';
}

export function isEmbeddingModelInformation(model: IModelAPIResponse): model is IEmbeddingModelInformation {
	return model.capabilities.type === 'embeddings';
}

export type ChatEndpointFamily = 'gpt-4.1' | 'gpt-4o-mini' | 'copilot-base';
export type EmbeddingsEndpointFamily = 'text3small';

export interface IEndpointProvider {
	readonly _serviceBrand: undefined;
	/**
	 * Get the embedding endpoint information
	 */
	getEmbeddingsEndpoint(family: EmbeddingsEndpointFamily): Promise<IEmbeddingEndpoint>;

	/**
	 * Gets all the chat endpoints known by the endpoint provider. Mainly used by language model access
	 */
	getAllChatEndpoints(): Promise<IChatEndpoint[]>;

	/**
	 * Given a chat request returns the appropriate chat endpoint to serve that request
	 * @param requestOrFamily The chat request to get the endpoint for, the family you want the endpoint for, or the LanguageModelChat.
	 */
	getChatEndpoint(requestOrFamily: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint>;
}

export const IEndpointProvider = createServiceIdentifier<IEndpointProvider>('IEndpointProvider');
