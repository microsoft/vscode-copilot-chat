/*---------------------------------------------------------------------------------------------
 *  Azure Embeddings Computer
 *  Implements IEmbeddingsComputer using Azure OpenAI Embeddings API.
 *  Replaces RemoteEmbeddingsComputer which depended on GitHub/CAPI auth.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from 'vscode';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { ILogService } from '../../log/common/logService';
import {
	ComputeEmbeddingsOptions,
	Embedding,
	EmbeddingType,
	Embeddings,
	IEmbeddingsComputer,
} from '../../embeddings/common/embeddingsComputer';
import { ServicePrincipalAuthService } from './servicePrincipalAuth';

interface AzureEmbeddingResponse {
	data: Array<{ embedding: number[]; index: number }>;
	model: string;
	usage: { prompt_tokens: number; total_tokens: number };
}

export class AzureEmbeddingsComputer implements IEmbeddingsComputer {

	declare readonly _serviceBrand: undefined;

	private readonly batchSize = 100;
	private _authService: ServicePrincipalAuthService | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
	) { }

	private getEndpoint(): string {
		return this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.endpoint') || '';
	}

	private getEmbeddingsDeployment(): string {
		return this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.embeddingsDeployment') || 'text-embedding-3-small';
	}

	private getApiVersion(): string {
		return this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.embeddingsApiVersion') || '2024-12-01-preview';
	}

	private getAuthService(): ServicePrincipalAuthService {
		if (!this._authService) {
			// Use native fetch for token acquisition (Azure AD endpoint)
			this._authService = new ServicePrincipalAuthService(
				(url: string, init: RequestInit) => globalThis.fetch(url, init)
			);
		}
		// Always refresh config from settings
		const tenantId = this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.tenantId') || '';
		const clientId = this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.clientId') || '';
		this._authService.setConfig({ tenantId, clientId });
		return this._authService;
	}

	async computeEmbeddings(
		embeddingType: EmbeddingType,
		inputs: readonly string[],
		_options?: ComputeEmbeddingsOptions,
		_telemetryInfo?: TelemetryCorrelationId,
		cancellationToken?: CancellationToken,
	): Promise<Embeddings> {
		const endpoint = this.getEndpoint();
		const deployment = this.getEmbeddingsDeployment();
		const apiVersion = this.getApiVersion();

		if (!endpoint) {
			this._logService.warn('Azure OpenAI endpoint not configured for embeddings');
			return { type: embeddingType, values: [] };
		}

		const base = endpoint.replace(/\/$/, '');
		const url = `${base}/openai/deployments/${deployment}/embeddings?api-version=${apiVersion}`;

		const auth = this.getAuthService();
		const embeddingsOut: Embedding[] = [];

		for (let i = 0; i < inputs.length; i += this.batchSize) {
			if (cancellationToken?.isCancellationRequested) {
				return { type: embeddingType, values: embeddingsOut };
			}

			const batch = inputs.slice(i, i + this.batchSize);
			if (!batch.length) {
				break;
			}

			try {
				const token = await auth.getToken(ServicePrincipalAuthService.SCOPE_COGNITIVE_SERVICES);

				const response = await this._fetcherService.fetch(url, {
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${token}`,
					},
					json: {
						input: batch,
						model: 'text-embedding-3-small',
						dimensions: 512,
					},
				});

				if (!response.ok) {
					const errorText = await response.text();
					this._logService.error(`Azure embeddings request failed: ${response.status} ${errorText}`);
					throw new Error(`Error fetching embeddings from Azure: ${response.status}`);
				}

				const jsonResponse = await response.json() as AzureEmbeddingResponse;

				if (batch.length !== jsonResponse.data.length) {
					throw new Error(`Mismatched embedding result count. Expected: ${batch.length}. Got: ${jsonResponse.data.length}`);
				}

				// Sort by index to ensure correct ordering
				const sorted = [...jsonResponse.data].sort((a, b) => a.index - b.index);
				embeddingsOut.push(...sorted.map(item => ({
					type: EmbeddingType.text3small_512,
					value: item.embedding,
				})));

				this._logService.debug(`Azure embeddings: computed ${batch.length} embeddings (batch ${Math.floor(i / this.batchSize) + 1})`);
			} catch (err) {
				this._logService.error(`Azure embeddings batch failed: ${(err as Error).message}`);
				throw err;
			}
		}

		return { type: EmbeddingType.text3small_512, values: embeddingsOut };
	}
}
