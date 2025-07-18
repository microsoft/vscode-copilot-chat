/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { ChatResponseProviderMetadata, Disposable } from 'vscode';
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
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
	vision: boolean;
}

export interface BYOKModelRegistry {
	readonly name: string;
	readonly authType: BYOKAuthType;
	updateKnownModelsList(knownModels: BYOKKnownModels | undefined): void;
	getAllModels(apiKey?: string): Promise<{ id: string; name: string }[]>;
	registerModel(config: BYOKModelConfig): Promise<Disposable>;
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

export function chatModelInfoToProviderMetadata(chatModelInfo: IChatModelInformation): ChatResponseProviderMetadata {
	const outputTokens = chatModelInfo.capabilities.limits?.max_output_tokens ?? 4096;
	const inputTokens = chatModelInfo.capabilities.limits?.max_prompt_tokens ?? ((chatModelInfo.capabilities.limits?.max_context_window_tokens || 64000) - outputTokens);

	// Calculate agentMode capability using the same logic as built-in models
	// This enables Edit Mode v2 (chat.edits2.enabled) for custom models that support tool calling
	const supportsToolCalls = chatModelInfo.capabilities.supports.tool_calls;
	const hasEnoughTokens = inputTokens > 40000;
	const agentModeEnabled = supportsToolCalls && hasEnoughTokens;

	const result = {
		family: chatModelInfo.capabilities.family,
		cost: chatModelInfo.capabilities.family, // This is a bit odd, but this is what renders in the grey side text
		description: localize('byok.model.description', '{0} is contributed via the {1} provider.', chatModelInfo.name, chatModelInfo.capabilities.family),
		vendor: 'copilot-byok',
		version: '1.0.0',
		maxOutputTokens: outputTokens,
		maxInputTokens: inputTokens,
		name: chatModelInfo.name,
		isUserSelectable: true,
		capabilities: {
			agentMode: agentModeEnabled,
			toolCalling: supportsToolCalls,
			vision: chatModelInfo.capabilities.supports.vision,
		}
	};

	return result;
}

export function resolveModelInfo(modelId: string, providerName: string, knownModels: BYOKKnownModels | undefined, modelCapabilities?: BYOKModelCapabilities): IChatModelInformation {
	// Model Capabilities are something the user has decided on so those take precedence, then we rely on known model info, then defaults.
	let knownModelInfo = modelCapabilities;
	if (knownModels && !knownModelInfo) {
		knownModelInfo = knownModels[modelId];
	}

	const modelName = knownModelInfo?.name || modelId;
	const contextWinow = knownModelInfo ? (knownModelInfo.maxInputTokens + knownModelInfo.maxOutputTokens) : 128000;

	const toolCallingSupport = knownModelInfo?.toolCalling !== undefined ? knownModelInfo.toolCalling : true;

	const result: IChatModelInformation = {
		id: modelId,
		name: modelName,
		version: '1.0.0',
		capabilities: {
			type: 'chat' as const,
			family: providerName,
			supports: {
				streaming: true,
				tool_calls: toolCallingSupport,
				vision: !!knownModelInfo?.vision
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

	return result;
}

export function isBYOKEnabled(copilotToken: Omit<CopilotToken, "token">, capiClientService: ICAPIClientService): boolean {
	const isGHE = capiClientService.dotcomAPIURL !== 'https://api.github.com';
	const byokAllowed = (copilotToken.isInternal || copilotToken.isIndividual) && !isGHE;
	return byokAllowed;
}