/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { createRequestHMAC } from '../../../util/common/crypto';
import { CallTracker } from '../../../util/common/telemetryCorrelationId';
import { env } from '../../../util/vs/base/common/process';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { getGithubMetadataHeaders } from '../../chunking/common/chunkingEndpointClientImpl';
import { ConfigKey, IConfigurationService } from '../../configuration/common/configurationService';
import { EmbeddingType } from '../../embeddings/common/embeddingsComputer';
import { ICAPIClientService } from '../../endpoint/common/capiClient';
import { IDomainService } from '../../endpoint/common/domainService';
import { IEnvService } from '../../env/common/envService';
import { ILogService } from '../../log/common/logService';
import { IFetcherService, Response } from '../../networking/common/fetcherService';
import { getRequest } from '../../networking/common/networking';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';

export interface AvailableEmbeddingTypes {
	readonly primary: readonly EmbeddingType[];
	readonly deprecated: readonly EmbeddingType[];
}

export class GithubAvailableEmbeddingTypesManager {

	private _cached?: Promise<AvailableEmbeddingTypes | undefined>;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@IDomainService private readonly _domainService: IDomainService,
		@ICAPIClientService private readonly _capiClientService: ICAPIClientService,
		@IEnvService private readonly _envService: IEnvService,
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IExperimentationService private readonly _experimentationService: IExperimentationService,
	) {
		this._cached = this._authService.getAnyGitHubSession({ silent: true }).then(session => {
			if (!session) {
				return undefined;
			}

			return this.doGetAvailableTypes(session.accessToken);
		});
	}

	private async getAllAvailableTypes(silent: boolean): Promise<AvailableEmbeddingTypes | undefined> {
		if (this._cached) {
			try {
				const cachedResult = await this._cached;
				if (cachedResult) {
					return cachedResult;
				}
			} catch {
				// noop
			}

			this._cached = undefined;
		}

		const session = await this._authService.getAnyGitHubSession({ silent });
		if (!session) {
			return undefined;
		}

		this._cached ??= this.doGetAvailableTypes(session.accessToken);
		return this._cached;
	}

	private async doGetAvailableTypes(token: string): Promise<AvailableEmbeddingTypes | undefined> {
		let response: Response;
		try {
			response = await getRequest(
				this._fetcherService,
				this._envService,
				this._telemetryService,
				this._domainService,
				this._capiClientService,
				{ type: RequestType.EmbeddingsModels },
				token,
				await createRequestHMAC(env.HMAC_SECRET),
				'copilot-panel',
				generateUuid(),
				undefined,
				getGithubMetadataHeaders(new CallTracker(), this._envService)
			);
		} catch (e) {
			this._logService.error('Error fetching available embedding types', e);
			return undefined;
		}

		if (!response.ok) {
			/* __GDPR__
				"githubAvailableEmbeddingTypes.getAvailableTypes.error" : {
					"owner": "mjbvz",
					"comment": "Information about failed githubAvailableEmbeddingTypes calls",
					"statusCode": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The response status code" }
				}
			*/
			this._telemetryService.sendMSFTTelemetryEvent('githubAvailableEmbeddingTypes.getAvailableTypes.error', {}, {
				statusCode: response.status,
			});

			return undefined;
		}
		type Model = {
			id: string;
			active: boolean;
		};

		type ModelsResponse = {
			models: Model[];
		};

		const jsonResponse: ModelsResponse = await response.json();

		const primary: EmbeddingType[] = [];
		const deprecated: EmbeddingType[] = [];

		for (const model of jsonResponse.models) {
			const resolvedType = new EmbeddingType(model.id);
			if (model.active === false) {
				deprecated.push(resolvedType);
			} else {
				primary.push(resolvedType);
			}
		}

		/* __GDPR__
			"githubAvailableEmbeddingTypes.getAvailableTypes.success" : {
				"owner": "mjbvz",
				"comment": "Information about successful githubAvailableEmbeddingTypes calls",
				"primaryEmbeddingTypes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "List of primary embedding types" },
				"deprecatedEmbeddingTypes": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "List of deprecated embedding types" }
			}
		*/
		this._telemetryService.sendMSFTTelemetryEvent('githubAvailableEmbeddingTypes.getAvailableTypes.success', {
			primaryEmbeddingTypes: primary.map(type => type.id).join(','),
			deprecatedEmbeddingTypes: deprecated.map(type => type.id).join(','),
		});

		return { primary, deprecated };
	}

	async getPreferredType(silent: boolean): Promise<EmbeddingType | undefined> {
		const all = await this.getAllAvailableTypes(silent);
		if (!all) {
			return undefined;
		}

		const preference = this._configurationService.getExperimentBasedConfig(ConfigKey.Internal.WorkspacePreferredEmbeddingsModel, this._experimentationService);
		if (preference) {
			const preferred = [...all.primary, ...all.deprecated].find(type => type.id === preference);
			if (preferred) {
				return preferred;
			}
		}

		return all.primary.at(0) ?? all.deprecated.at(0);
	}
}