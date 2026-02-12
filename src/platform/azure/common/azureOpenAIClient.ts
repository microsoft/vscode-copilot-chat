/*---------------------------------------------------------------------------------------------
 *  Azure OpenAI Client
 *  Handles HTTP requests to Azure OpenAI Chat Completions API
 *  using bearer token auth from service principal.
 *--------------------------------------------------------------------------------------------*/

import { ServicePrincipalAuthService } from './servicePrincipalAuth';

export interface AzureOpenAIConfig {
	/** Azure OpenAI resource endpoint, e.g. https://your-resource.openai.azure.com */
	endpoint: string;
	/** Deployment name, e.g. gpt-4o */
	deploymentName: string;
	/** API version, e.g. 2024-12-01-preview */
	apiVersion: string;
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	[key: string]: unknown;
}

export interface ChatCompletionRequest {
	messages: ChatMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	tools?: unknown[];
	tool_choice?: unknown;
	[key: string]: unknown;
}

export class AzureOpenAIClient {
	constructor(
		private readonly auth: ServicePrincipalAuthService,
		private readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>
	) { }

	getCompletionsUrl(config: AzureOpenAIConfig): string {
		const base = config.endpoint.replace(/\/$/, '');
		return `${base}/openai/deployments/${config.deploymentName}/chat/completions?api-version=${config.apiVersion}`;
	}

	async chatCompletions(
		config: AzureOpenAIConfig,
		request: ChatCompletionRequest,
		signal?: AbortSignal
	): Promise<Response> {
		const token = await this.auth.getToken();
		const url = this.getCompletionsUrl(config);

		return this.fetchFn(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(request),
			signal,
		});
	}
}
