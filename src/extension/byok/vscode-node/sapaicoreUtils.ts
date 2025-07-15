/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { type AiDeploymentList, type AiDeploymentStatus, DeploymentApi, ScenarioApi, type AiModelList } from '@sap-ai-sdk/ai-api';

/**
 * Retrieve information about all models available in LLM global scenario.
 * @param scenarioId - ID of the global scenario.
 * @param resourceGroup - AI-Resource-Group where the resources are available.
 * @returns All models in given scenario.
 */
export async function getModelsInScenario(
	scenarioId: string,
	resourceGroup: string
): Promise<AiModelList> {
	return ScenarioApi.scenarioQueryModels(scenarioId, {
		'AI-Resource-Group': resourceGroup
	}).execute();
}

/**
 * Get all deployments filtered by status.
 * @param resourceGroup - AI-Resource-Group where the resources are available.
 * @param status - Optional query parameter to filter deployments by status.
 * @returns List of deployments.
 */
export async function getDeployments(
	resourceGroup: string,
	status?: AiDeploymentStatus
): Promise<AiDeploymentList> {
	// check for optional query parameters.
	const queryParams = status ? { status } : {};
	return DeploymentApi.deploymentQuery(queryParams, {
		'AI-Resource-Group': resourceGroup
	}).execute();
}