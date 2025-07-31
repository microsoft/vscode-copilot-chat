/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { Disposable, LanguageModelChatInformation, LanguageModelChatProvider2 } from 'vscode';
import { CopilotToken } from '../../../platform/authentication/common/copilotToken';
import { ICAPIClientService } from '../../../platform/endpoint/common/capiClient';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { TokenizerType } from '../../../util/common/tokenizer';
import { localize } from '../../../util/vs/nls';

export const enum BYOKAuthType {
	/**
	 * Requires a single API key for all models (e.g., OpenAI)
	 */
	GlobalApiKey,
	/**
	 * Requires both deployment URL and API key per model (e.g., Azure)
	 */
	PerModelDeployment,
	/**
	 * No authentication required (e.g., Ollama)
	 */
	None
}

interface BYOKBaseModelConfig {
	modelId: string;
	capabilities?: BYOKModelCapabilities;
}

export interface BYOKGlobalKeyModelConfig extends BYOKBaseModelConfig {
	apiKey: string;
}

export interface BYOKPerModelConfig extends BYOKBaseModelConfig {
	apiKey: string;
	deploymentUrl: string;
}

interface BYOKNoAuthModelConfig extends BYOKBaseModelConfig {
	// No additional fields required
}

export type BYOKModelConfig = BYOKGlobalKeyModelConfig | BYOKPerModelConfig | BYOKNoAuthModelConfig;

export interface BYOKModelCapabilities {
	name: string;
	url?: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
	vision: boolean;
	thinking?: boolean;
}

export interface BYOKModelRegistry {
	readonly name: string;
	readonly authType: BYOKAuthType;
	updateKnownModelsList(knownModels: BYOKKnownModels | undefined): void;
	getAllModels(apiKey?: string): Promise<{ id: string; name: string }[]>;
	registerModel(config: BYOKModelConfig): Promise<Disposable>;
}

export interface BYOKModelProvider<T extends LanguageModelChatInformation> extends LanguageModelChatProvider2<T> {
	readonly authType: BYOKAuthType;
	/**
	 * Called when the user is requesting an API key update. The provider should handle all the UI and updating the storage
	 */
	updateAPIKey(): Promise<void>;
}

// Many model providers don't have robust model lists. This allows us to map id -> information about models, and then if we don't know the model just let the user enter a custom id
export type BYOKKnownModels = Record<string, BYOKModelCapabilities>;

// Type guards to ensure correct config type
export function isGlobalKeyConfig(config: BYOKModelConfig): config is BYOKGlobalKeyModelConfig {
	return 'apiKey' in config && !('deploymentUrl' in config);
}

export function isPerModelConfig(config: BYOKModelConfig): config is BYOKPerModelConfig {
	return 'apiKey' in config && 'deploymentUrl' in config;
}

export function isNoAuthConfig(config: BYOKModelConfig): config is BYOKNoAuthModelConfig {
	return !('apiKey' in config) && !('deploymentUrl' in config);
}

export function chatModelInfoToProviderMetadata(chatModelInfo: IChatModelInformation): LanguageModelChatInformation {
	const outputTokens = chatModelInfo.capabilities.limits?.max_output_tokens ?? 4096;
	const inputTokens = chatModelInfo.capabilities.limits?.max_prompt_tokens ?? ((chatModelInfo.capabilities.limits?.max_context_window_tokens || 64000) - outputTokens);
	return {
		id: chatModelInfo.id,
		family: chatModelInfo.capabilities.family,
		description: localize('byok.model.description', '{0} is contributed via the {1} provider.', chatModelInfo.name, chatModelInfo.capabilities.family),
		version: '1.0.0',
		maxOutputTokens: outputTokens,
		maxInputTokens: inputTokens,
		name: chatModelInfo.name,
		isUserSelectable: true,
		capabilities: {
			toolCalling: chatModelInfo.capabilities.supports.tool_calls,
			vision: chatModelInfo.capabilities.supports.vision,
		},
		auth: true
	};
}

export function resolveModelInfo(modelId: string, providerName: string, knownModels: BYOKKnownModels | undefined, modelCapabilities?: BYOKModelCapabilities): IChatModelInformation {
	// Model Capabilities are something the user has decided on so those take precedence, then we rely on known model info, then defaults.
	let knownModelInfo = modelCapabilities;
	if (knownModels && !knownModelInfo) {
		knownModelInfo = knownModels[modelId];
	}
	const modelName = knownModelInfo?.name || modelId;
	const contextWinow = knownModelInfo ? (knownModelInfo.maxInputTokens + knownModelInfo.maxOutputTokens) : 128000;
	return {
		id: modelId,
		name: modelName,
		version: '1.0.0',
		capabilities: {
			type: 'chat',
			family: providerName,
			supports: {
				streaming: true,
				tool_calls: !!knownModelInfo?.toolCalling,
				vision: !!knownModelInfo?.vision,
				thinking: !!knownModelInfo?.thinking
			},
			tokenizer: TokenizerType.O200K,
			limits: {
				max_context_window_tokens: contextWinow,
				max_prompt_tokens: knownModelInfo?.maxInputTokens || 100000,
				max_output_tokens: knownModelInfo?.maxOutputTokens || 8192
			}
		},
		is_chat_default: false,
		is_chat_fallback: false,
		model_picker_enabled: true
	};
}

export function byokKnownModelsToAPIInfo(providerName: string, knownModels: BYOKKnownModels | undefined): LanguageModelChatInformation[] {
	if (!knownModels) {
		return [];
	}
	return Object.entries(knownModels).map(([id, capabilities]) => {
		return {
			id,
			name: capabilities.name,
			version: '1.0.0',
			maxOutputTokens: capabilities.maxOutputTokens,
			maxInputTokens: capabilities.maxInputTokens,
			cost: providerName,
			family: providerName,
			description: `${capabilities.name} is contributed via the ${providerName} provider.`,
			capabilities: {
				toolCalling: capabilities.toolCalling,
				vision: capabilities.vision
			},
		};
	});
}

export function isBYOKEnabled(copilotToken: Omit<CopilotToken, "token">, capiClientService: ICAPIClientService): boolean {
	const isGHE = capiClientService.dotcomAPIURL !== 'https://api.github.com';
	const byokAllowed = (copilotToken.isInternal || copilotToken.isIndividual) && !isGHE;
	return byokAllowed;
}