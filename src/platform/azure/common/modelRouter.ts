/*---------------------------------------------------------------------------------------------
 *  Azure Model Router
 *  Routes different feature types (chat, embeddings, completions, code-apply)
 *  to the appropriate Azure OpenAI deployment based on VS Code settings.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { createServiceIdentifier } from '../../../util/common/services';

export const IModelRouter = createServiceIdentifier<IModelRouter>('IModelRouter');

export type FeatureType = 'chat' | 'embeddings' | 'completions' | 'code-apply' | 'intent-detection';

export interface DeploymentRouting {
	deploymentName: string;
	apiVersion: string;
}

export interface IModelRouter {
	readonly _serviceBrand: undefined;

	/**
	 * Get the deployment to use for a given feature type.
	 */
	getDeployment(feature: FeatureType): DeploymentRouting;

	/**
	 * Get the Azure OpenAI endpoint URL.
	 */
	getEndpoint(): string;
}

export class AzureModelRouter implements IModelRouter {

	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) { }

	getEndpoint(): string {
		return this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.endpoint') || '';
	}

	getDeployment(feature: FeatureType): DeploymentRouting {
		const routing = this._configurationService.getNonExtensionConfig<Record<string, string>>('yourcompany.ai.routing') || {};
		const deployments = this._configurationService.getNonExtensionConfig<Record<string, { apiVersion?: string }>>('yourcompany.ai.deployments') || {};

		// Look up routing: feature → deployment name
		const deploymentName = routing[feature] || this._getDefaultDeployment(feature);
		const deploymentConfig = deployments[deploymentName];
		const apiVersion = deploymentConfig?.apiVersion || '2024-12-01-preview';

		this._logService.debug(`Model router: ${feature} → ${deploymentName} (api-version: ${apiVersion})`);

		return { deploymentName, apiVersion };
	}

	private _getDefaultDeployment(feature: FeatureType): string {
		// Sensible defaults based on feature type
		switch (feature) {
			case 'embeddings':
				return this._configurationService.getNonExtensionConfig<string>('yourcompany.ai.embeddingsDeployment') || 'text-embedding-3-small';
			case 'completions':
				return this._getFirstDeployment() || 'gpt-4o';
			case 'code-apply':
				return 'gpt-4o-mini';
			case 'intent-detection':
				return 'gpt-4o-mini';
			case 'chat':
			default:
				return this._getFirstDeployment() || 'gpt-4o';
		}
	}

	private _getFirstDeployment(): string {
		const deployments = this._configurationService.getNonExtensionConfig<Record<string, unknown>>('yourcompany.ai.deployments') || {};
		const keys = Object.keys(deployments);
		return keys[0] || '';
	}
}
