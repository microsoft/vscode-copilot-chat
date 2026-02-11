/*---------------------------------------------------------------------------------------------
 *  Azure-Only Model Provider
 *  Provides language models exclusively from Azure OpenAI deployments
 *  configured via VS Code settings.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatProvider, LanguageModelResponsePart2, PrepareLanguageModelChatModelOptions, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { ServicePrincipalAuthService } from '../../../platform/azure/common/servicePrincipalAuth';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { TokenizerType } from '../../../util/common/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { OpenAIEndpoint } from '../node/openAIEndpoint';

export interface AzureDeploymentConfig {
	name: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
	vision: boolean;
	thinking?: boolean;
	apiVersion?: string;
}

export interface AzureOnlyModelInfo extends LanguageModelChatInformation {
	deploymentName: string;
	endpoint: string;
	apiVersion: string;
}

export class AzureOnlyModelProvider implements LanguageModelChatProvider<AzureOnlyModelInfo> {
	static readonly providerName = 'azure-openai';

	private readonly _lmWrapper: CopilotLanguageModelWrapper;
	private _authService: ServicePrincipalAuthService | undefined;

	constructor(
		@IFetcherService _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService _expService: IExperimentationService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
	) {
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
	}

	private getAuthService(): ServicePrincipalAuthService {
		if (!this._authService) {
			this._authService = new ServicePrincipalAuthService(
				(url: string, init: RequestInit) => globalThis.fetch(url, init)
			);
			this._authService.setExtensionContext(this._extensionContext);
		}
		const tenantId = this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.tenantId') || '';
		const clientId = this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.clientId') || '';
		this._authService.setConfig({ tenantId, clientId });
		return this._authService;
	}

	private getEndpoint(): string {
		return this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.endpoint') || '';
	}

	private getDeployments(): Record<string, AzureDeploymentConfig> {
		return this._configurationService.getNonExtensionConfig<Record<string, AzureDeploymentConfig>>('yourcompany.ai.deployments') || {};
	}

	async provideLanguageModelChatInformation(_options: PrepareLanguageModelChatModelOptions, _token: CancellationToken): Promise<AzureOnlyModelInfo[]> {
		const deployments = this.getDeployments();
		const endpoint = this.getEndpoint();

		if (!endpoint) {
			this._logService.warn('Azure OpenAI endpoint not configured');
			return [];
		}

		return Object.entries(deployments).map(([deploymentName, config]) => ({
			id: deploymentName,
			name: config.name || deploymentName,
			family: deploymentName,
			version: '1.0.0',
			maxOutputTokens: config.maxOutputTokens || 16384,
			maxInputTokens: config.maxInputTokens || 128000,
			isUserSelectable: true,
			multiplierNumeric: 0,
			capabilities: {
				toolCalling: config.toolCalling ?? true,
				imageInput: config.vision ?? false,
			},
			deploymentName,
			endpoint,
			apiVersion: config.apiVersion || '2024-12-01-preview',
		}));
	}

	async provideLanguageModelChatResponse(
		model: AzureOnlyModelInfo,
		messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>,
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const openAIEndpoint = await this.createEndpoint(model);
		return this._lmWrapper.provideLanguageModelResponse(openAIEndpoint, messages, options, options.requestInitiator, progress, token);
	}

	async provideTokenCount(
		model: AzureOnlyModelInfo,
		text: string | LanguageModelChatMessage | LanguageModelChatMessage2,
		_token: CancellationToken
	): Promise<number> {
		const openAIEndpoint = await this.createEndpoint(model);
		return this._lmWrapper.provideTokenCount(openAIEndpoint, text);
	}

	private async createEndpoint(model: AzureOnlyModelInfo): Promise<OpenAIEndpoint> {
		const modelInfo = this.getModelInfo(model);
		const base = model.endpoint.replace(/\/$/, '');
		const url = `${base}/openai/deployments/${model.deploymentName}/chat/completions?api-version=${model.apiVersion}`;
		const auth = this.getAuthService();
		const bearerToken = await auth.getToken(ServicePrincipalAuthService.SCOPE_COGNITIVE_SERVICES);
		return this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, bearerToken, url, true);
	}

	private getModelInfo(model: AzureOnlyModelInfo): IChatModelInformation {
		const deployments = this.getDeployments();
		const config = deployments[model.deploymentName];
		const maxInput = config?.maxInputTokens || 128000;
		const maxOutput = config?.maxOutputTokens || 16384;

		return {
			id: model.deploymentName,
			name: config?.name || model.deploymentName,
			version: '1.0.0',
			capabilities: {
				type: 'chat',
				family: model.deploymentName,
				supports: {
					streaming: true,
					tool_calls: config?.toolCalling ?? true,
					vision: config?.vision ?? false,
					thinking: config?.thinking ?? false,
					adaptive_thinking: false,
				},
				tokenizer: TokenizerType.O200K,
				limits: {
					max_context_window_tokens: maxInput + maxOutput,
					max_prompt_tokens: maxInput,
					max_output_tokens: maxOutput,
				},
			},
			is_chat_default: false,
			is_chat_fallback: false,
			model_picker_enabled: true,
			supported_endpoints: [ModelSupportedEndpoint.ChatCompletions],
		};
	}
}
