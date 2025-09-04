/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import type { CancellationToken } from 'vscode';
import { createRequestHMAC } from '../../../util/common/crypto';
import { CallTracker, TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { env } from '../../../util/vs/base/common/process';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { getGithubMetadataHeaders } from '../../chunking/common/chunkingEndpointClientImpl';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { logExecTime } from '../../log/common/logExecTime';
import { ILogService } from '../../log/common/logService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { postRequest } from '../../networking/common/networking';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ComputeEmbeddingsOptions, Embedding, EmbeddingType, Embeddings, IEmbeddingsComputer } from './embeddingsComputer';


export class RemoteEmbeddingsComputer implements IEmbeddingsComputer {

	declare readonly _serviceBrand: undefined;

	private readonly batchSize = 100;

	constructor(
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IDomainService private readonly _domainService: IDomainService,
		@IEnvService private readonly _envService: IEnvService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
	) { }

	public async computeEmbeddings(
		embeddingType: EmbeddingType,
		inputs: readonly string[],
		options?: ComputeEmbeddingsOptions,
		telemetryInfo?: TelemetryCorrelationId,
		cancellationToken?: CancellationToken,
	): Promise<Embeddings> {
		return logExecTime(this._logService, 'RemoteEmbeddingsComputer::computeEmbeddings', async () => {
			const token = (await this._authService.getAnyGitHubSession({ silent: true }))?.accessToken;
			if (!token) {
				throw new Error('No authentication token available');
			}

			const embeddingsOut: Embedding[] = [];
			for (let i = 0; i < inputs.length; i += this.batchSize) {
				const batch = inputs.slice(i, i + this.batchSize);
				if (!batch.length) {
					break;
				}

				const body: {
					inputs: readonly string[];
					input_type: 'document' | 'query';
					embedding_model: string;
				} = {
					inputs: batch,
					input_type: options?.inputType ?? 'document',
					embedding_model: embeddingType.id,
				};
				const response = await postRequest(
					this._fetcherService,
					this._envService,
					this._telemetryService,
					this._domainService,
					this._capiClientService,
					{ type: RequestType.DotcomEmbeddings },
					token,
					await createRequestHMAC(env.HMAC_SECRET),
					'copilot-panel',
					generateUuid(),
					body as any,
					getGithubMetadataHeaders(telemetryInfo?.callTracker ?? new CallTracker(), this._envService),
					cancellationToken
				);
				if (!response.ok) {
					/* __GDPR__
						"remoteEmbeddingsComputer.computeEmbeddings.error" : {
							"owner": "mjbvz",
							"comment": "Total time for searchFileChunks to complete",
							"source": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Caller" },
							"correlationId": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Correlation id" },
							"embeddingType": { "classification": "SystemMetaData", "purpose": "FeatureInsight",  "comment": "Embedding type" },
							"totalInputLength": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total length of the input" },
							"batchInputLength": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Total length of the batch" },
							"statusCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "Status code of the response" }
						}
					*/
					this._telemetryService.sendMSFTTelemetryEvent('remoteEmbeddingsComputer.computeEmbeddings.error', {
						source: telemetryInfo?.callTracker.toString(),
						correlationId: telemetryInfo?.correlationId,
						embeddingType: embeddingType.id,
					}, {
						totalInputLength: inputs.length,
						batchInputLength: batch.length,
						statusCode: response.status,
					});
					throw new Error(`Error fetching embeddings: ${response.status}`);
				}

				type EmbeddingResponse = {
					embedding_model: string;
					embeddings: Array<{ embedding: number[] }>;
				};
				const jsonResponse: EmbeddingResponse = await response.json();

				const resolvedType = new EmbeddingType(jsonResponse.embedding_model);
				if (!resolvedType.equals(embeddingType)) {
					throw new Error(`Unexpected embedding model. Got: ${resolvedType}. Expected: ${embeddingType}`);
				}

				if (batch.length !== jsonResponse.embeddings.length) {
					throw new Error(`Mismatched embedding result count. Expected: ${batch.length}. Got: ${jsonResponse.embeddings.length}`);
				}

				embeddingsOut.push(...jsonResponse.embeddings.map(embedding => ({
					type: resolvedType,
					value: embedding.embedding,
				})));
			}

			return { type: embeddingType, values: embeddingsOut };
		});
	}
}
