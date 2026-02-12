/*---------------------------------------------------------------------------------------------
 *  Azure Endpoint Provider
 *  Replaces ProductionEndpointProvider which depends on GitHub CAPI /models endpoint.
 *  Returns static model configurations based on Azure OpenAI deployments.
 *  Supports model picker dropdown with configured models.
 *--------------------------------------------------------------------------------------------*/

import { LanguageModelChat, type ChatRequest } from 'vscode';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { ChatEndpointFamily, EmbeddingsEndpointFamily, IChatModelCapabilities, IChatModelInformation, ICompletionModelInformation, IEmbeddingModelInformation, IEndpointProvider, ModelSupportedEndpoint } from '../../endpoint/common/endpointProvider';
import { CopilotChatEndpoint } from '../../endpoint/node/copilotChatEndpoint';
import { ILogService } from '../../log/common/logService';
import { IChatEndpoint, IEmbeddingsEndpoint } from '../../networking/common/networking';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { TokenizerType } from '../../../util/common/tokenizer';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { EmbeddingEndpoint } from '../../endpoint/node/embeddingsEndpoint';
import { IModelRouter } from './modelRouter';

/**
 * Model definition for the Azure model picker.
 * Each entry represents an Azure OpenAI deployment that appears in the model dropdown.
 */
interface AzureModelDefinition {
	/** The deployment name in Azure OpenAI */
	id: string;
	/** Display name in the model picker */
	name: string;
	/** Model family for endpoint routing */
	family: string;
	/** Whether this is the default/fallback model */
	isDefault: boolean;
	/** Whether to show in the model picker */
	showInPicker: boolean;
	/** Tokenizer type */
	tokenizer: TokenizerType;
	/** Token limits */
	limits?: IChatModelCapabilities['limits'];
	/** Feature support flags */
	supports?: Partial<IChatModelCapabilities['supports']>;
	/** Supported API endpoints */
	supportedEndpoints?: ModelSupportedEndpoint[];
}

/**
 * Built-in model definitions for common Azure OpenAI deployments.
 * The user requested: gpt-4o, gpt-4.1, o4-mini, gpt-5-mini, and gpt-5 models.
 */
const AZURE_MODEL_DEFINITIONS: AzureModelDefinition[] = [
	{
		id: 'gpt-4o',
		name: 'GPT-4o',
		family: 'gpt-4o',
		isDefault: true,
		showInPicker: true,
		tokenizer: TokenizerType.O200K,
		limits: {
			max_prompt_tokens: 128000,
			max_output_tokens: 16384,
			max_context_window_tokens: 128000,
			vision: { max_prompt_images: 10 },
		},
		supports: {
			tool_calls: true,
			parallel_tool_calls: true,
			streaming: true,
			vision: true,
		},
		supportedEndpoints: [ModelSupportedEndpoint.ChatCompletions],
	},
	{
		id: 'gpt-4.1',
		name: 'GPT-4.1',
		family: 'gpt-4.1',
		isDefault: false,
		showInPicker: true,
		tokenizer: TokenizerType.O200K,
		limits: {
			max_prompt_tokens: 1047576,
			max_output_tokens: 32768,
			max_context_window_tokens: 1047576,
			vision: { max_prompt_images: 10 },
		},
		supports: {
			tool_calls: true,
			parallel_tool_calls: true,
			streaming: true,
			vision: true,
		},
		supportedEndpoints: [ModelSupportedEndpoint.ChatCompletions],
	},
	{
		id: 'o4-mini',
		name: 'o4-mini',
		family: 'o4-mini',
		isDefault: false,
		showInPicker: true,
		tokenizer: TokenizerType.O200K,
		limits: {
			max_prompt_tokens: 200000,
			max_output_tokens: 100000,
			max_context_window_tokens: 200000,
		},
		supports: {
			tool_calls: true,
			parallel_tool_calls: true,
			streaming: true,
			thinking: true,
			adaptive_thinking: true,
			max_thinking_budget: 100000,
			min_thinking_budget: 1024,
		},
		supportedEndpoints: [ModelSupportedEndpoint.ChatCompletions],
	},
	{
		id: 'gpt-5-mini',
		name: 'GPT-5 Mini',
		family: 'gpt-5-mini',
		isDefault: false,
		showInPicker: true,
		tokenizer: TokenizerType.O200K,
		limits: {
			max_prompt_tokens: 1047576,
			max_output_tokens: 32768,
			max_context_window_tokens: 1047576,
			vision: { max_prompt_images: 10 },
		},
		supports: {
			tool_calls: true,
			parallel_tool_calls: true,
			streaming: true,
			vision: true,
		},
		supportedEndpoints: [ModelSupportedEndpoint.ChatCompletions],
	},
	{
		id: 'gpt-5',
		name: 'GPT-5',
		family: 'gpt-5',
		isDefault: false,
		showInPicker: true,
		tokenizer: TokenizerType.O200K,
		limits: {
			max_prompt_tokens: 1047576,
			max_output_tokens: 32768,
			max_context_window_tokens: 1047576,
			vision: { max_prompt_images: 10 },
		},
		supports: {
			tool_calls: true,
			parallel_tool_calls: true,
			streaming: true,
			vision: true,
			thinking: true,
			adaptive_thinking: true,
			max_thinking_budget: 100000,
			min_thinking_budget: 1024,
		},
		supportedEndpoints: [ModelSupportedEndpoint.ChatCompletions],
	},
];

export class AzureEndpointProvider implements IEndpointProvider {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidModelsRefresh = new Emitter<void>();
	readonly onDidModelsRefresh: Event<void> = this._onDidModelsRefresh.event;

	private _chatEndpoints: Map<string, IChatEndpoint> = new Map();
	private _embeddingEndpoints: Map<string, IEmbeddingsEndpoint> = new Map();

	constructor(
		@IModelRouter private readonly _modelRouter: IModelRouter,
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IAuthenticationService _authService: IAuthenticationService,
		@IExperimentationService _expService: IExperimentationService,
		@ITelemetryService _telemetryService: ITelemetryService,
	) {
		this._logService.info('AzureEndpointProvider: initialized with static model definitions');
	}

	/**
	 * Build IChatModelInformation from a model definition.
	 * Sets urlOrRequestMetadata to a direct Azure OpenAI URL so requests
	 * bypass CAPI and go straight to Azure OpenAI Service.
	 */
	private _buildModelInfo(def: AzureModelDefinition): IChatModelInformation {
		const endpoint = this._modelRouter.getEndpoint();
		const routing = this._modelRouter.getDeployment('chat');
		// Use the definition's ID as the deployment name (or fall back to router default)
		const deploymentName = def.id;
		const apiVersion = routing.apiVersion;
		const directUrl = endpoint
			? `${endpoint.replace(/\/$/, '')}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`
			: undefined;

		return {
			id: def.id,
			name: def.name,
			model_picker_enabled: def.showInPicker,
			is_chat_default: def.isDefault,
			is_chat_fallback: def.isDefault,
			version: '1.0.0',
			urlOrRequestMetadata: directUrl,
			capabilities: {
				type: 'chat',
				family: def.family,
				tokenizer: def.tokenizer,
				limits: def.limits,
				supports: {
					streaming: def.supports?.streaming ?? true,
					tool_calls: def.supports?.tool_calls ?? true,
					parallel_tool_calls: def.supports?.parallel_tool_calls ?? true,
					vision: def.supports?.vision,
					prediction: def.supports?.prediction,
					thinking: def.supports?.thinking,
					adaptive_thinking: def.supports?.adaptive_thinking,
					max_thinking_budget: def.supports?.max_thinking_budget,
					min_thinking_budget: def.supports?.min_thinking_budget,
				},
			},
			supported_endpoints: def.supportedEndpoints,
		};
	}

	/**
	 * Get all available model definitions - built-in plus any from configuration.
	 * Merges hardcoded models with models defined in yourcompany.ai.deployments setting.
	 */
	private _getModelDefinitions(): AzureModelDefinition[] {
		const configDeployments = this._configService.getNonExtensionConfig<Record<string, { name?: string; family?: string; tokenizer?: string; isDefault?: boolean; showInPicker?: boolean; maxPromptTokens?: number; maxOutputTokens?: number; supportsVision?: boolean; supportsThinking?: boolean }>>('yourcompany.ai.deployments') || {};

		// Start with built-in definitions
		const builtInIds = new Set(AZURE_MODEL_DEFINITIONS.map(m => m.id));
		const allModels = [...AZURE_MODEL_DEFINITIONS];

		// Add any config-defined deployments that aren't already in the built-in list
		for (const [deploymentId, config] of Object.entries(configDeployments)) {
			if (!builtInIds.has(deploymentId)) {
				allModels.push({
					id: deploymentId,
					name: config.name || deploymentId,
					family: config.family || deploymentId,
					isDefault: config.isDefault || false,
					showInPicker: config.showInPicker !== false,
					tokenizer: TokenizerType.O200K,
					limits: {
						max_prompt_tokens: config.maxPromptTokens || 128000,
						max_output_tokens: config.maxOutputTokens || 16384,
						max_context_window_tokens: config.maxPromptTokens || 128000,
					},
					supports: {
						tool_calls: true,
						parallel_tool_calls: true,
						streaming: true,
						vision: config.supportsVision,
						thinking: config.supportsThinking,
					},
					// Azure OpenAI only supports Chat Completions API, never Responses API
					supportedEndpoints: [ModelSupportedEndpoint.ChatCompletions],
				});
			}
		}

		return allModels;
	}

	private _getOrCreateChatEndpoint(modelInfo: IChatModelInformation): IChatEndpoint {
		let endpoint = this._chatEndpoints.get(modelInfo.id);
		if (!endpoint) {
			endpoint = this._instantiationService.createInstance(CopilotChatEndpoint, modelInfo);
			this._chatEndpoints.set(modelInfo.id, endpoint);
		}
		return endpoint;
	}

	async getChatEndpoint(requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		this._logService.trace('AzureEndpointProvider: resolving chat model');

		// Check for debug override first
		const overriddenModel = this._configService.getConfig(ConfigKey.Advanced.DebugOverrideChatEngine);
		if (overriddenModel) {
			this._logService.trace(`AzureEndpointProvider: using overridden model: ${overriddenModel}`);
			const endpoint = this._modelRouter.getEndpoint();
			const routing = this._modelRouter.getDeployment('chat');
			const directUrl = endpoint
				? `${endpoint.replace(/\/$/, '')}/openai/deployments/${overriddenModel}/chat/completions?api-version=${routing.apiVersion}`
				: undefined;
			return this._getOrCreateChatEndpoint({
				id: overriddenModel,
				name: 'Custom Override',
				version: '1.0.0',
				model_picker_enabled: true,
				is_chat_default: false,
				is_chat_fallback: false,
				urlOrRequestMetadata: directUrl,
				capabilities: {
					type: 'chat',
					family: 'custom',
					tokenizer: TokenizerType.O200K,
					supports: { streaming: true, tool_calls: true, parallel_tool_calls: true },
				},
			});
		}

		const models = this._getModelDefinitions();

		if (typeof requestOrFamilyOrModel === 'string') {
			// Family-based lookup
			const family = requestOrFamilyOrModel;
			const def = models.find(m => m.family === family) || models.find(m => m.isDefault) || models[0];
			return this._getOrCreateChatEndpoint(this._buildModelInfo(def));
		}

		// Model picker or ChatRequest
		const model = 'model' in requestOrFamilyOrModel ? requestOrFamilyOrModel.model : requestOrFamilyOrModel;
		if (model && model.vendor === 'copilot') {
			// Auto mode: pick the default model
			if (model.id === 'copilot-chat-auto') {
				const def = models.find(m => m.isDefault) || models[0];
				return this._getOrCreateChatEndpoint(this._buildModelInfo(def));
			}
			// Specific model from picker
			const def = models.find(m => m.id === model.id);
			if (def) {
				return this._getOrCreateChatEndpoint(this._buildModelInfo(def));
			}
			// Fallback to default
			this._logService.trace(`AzureEndpointProvider: model ${model.id} not found, using default`);
			const defaultDef = models.find(m => m.isDefault) || models[0];
			return this._getOrCreateChatEndpoint(this._buildModelInfo(defaultDef));
		}

		if (model) {
			// Extension-contributed model - let the system handle it
			const { ExtensionContributedChatEndpoint } = await import('../../endpoint/vscode-node/extChatEndpoint');
			return this._instantiationService.createInstance(ExtensionContributedChatEndpoint, model);
		}

		// No model specified: use default
		const defaultDef = models.find(m => m.isDefault) || models[0];
		return this._getOrCreateChatEndpoint(this._buildModelInfo(defaultDef));
	}

	async getEmbeddingsEndpoint(_family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
		const key = 'text-embedding-3-large';
		let endpoint = this._embeddingEndpoints.get(key);
		if (!endpoint) {
			const routing = this._modelRouter.getDeployment('embeddings');
			const modelInfo: IEmbeddingModelInformation = {
				id: routing.deploymentName,
				name: 'text-embedding-3-large',
				model_picker_enabled: false,
				is_chat_default: false,
				is_chat_fallback: false,
				version: '1.0.0',
				capabilities: {
					type: 'embeddings',
					family: 'text3large',
					tokenizer: TokenizerType.CL100K,
					limits: { max_inputs: 16 },
				},
			};
			endpoint = this._instantiationService.createInstance(EmbeddingEndpoint, modelInfo);
			this._embeddingEndpoints.set(key, endpoint);
		}
		return endpoint;
	}

	async getAllCompletionModels(_forceRefresh?: boolean): Promise<ICompletionModelInformation[]> {
		// No completions models in Azure-only mode
		return [];
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		const models = this._getModelDefinitions();
		return models
			.filter(m => m.showInPicker)
			.map(m => this._getOrCreateChatEndpoint(this._buildModelInfo(m)));
	}
}
