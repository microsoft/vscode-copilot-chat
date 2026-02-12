/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';
import { IConfigurationService } from '../../../../../platform/configuration/common/configurationService';
import { ICAPIClientService } from '../../../../../platform/endpoint/common/capiClient';
import { ServicesAccessor } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotToken } from './auth/copilotTokenManager';
import { BuildInfo, ConfigKey, ConfigKeyType, getConfig } from './config';
import { ICompletionsRuntimeModeService } from './util/runtimeMode';
import { joinPath } from './util/uri';

type ServiceEndpoints = {
	proxy: string;
	'origin-tracker': string;
};

function getDefaultEndpoints(accessor: ServicesAccessor): ServiceEndpoints {
	const capi = accessor.get(ICAPIClientService);

	// Azure-only fork: prefer the user's Azure endpoint over the CAPI proxy URL,
	// which may point to GitHub's backend instead of the user's own Azure resource.
	const configService = accessor.get(IConfigurationService);
	const azureEndpoint = configService.getNonExtensionConfig<string>('yourcompany.ai.endpoint');
	const proxyUrl = azureEndpoint
		? azureEndpoint.replace(/\/$/, '')
		: capi.proxyBaseURL;

	return {
		proxy: proxyUrl,
		'origin-tracker': capi.originTrackerURL,
	};
}

/**
 * If a configuration value has been configured for any of `overrideKeys`, returns
 * that value. If `testOverrideKeys` is supplied and the run mode is test,
 * `testOverrideKeys` is used instead of `overrideKeys`.
 */
function urlConfigOverride(
	accessor: ServicesAccessor,
	overrideKeys: ConfigKeyType[],
	testOverrideKeys?: ConfigKeyType[]
): string | undefined {
	if (testOverrideKeys !== undefined && accessor.get(ICompletionsRuntimeModeService).isRunningInTest()) {
		for (const overrideKey of testOverrideKeys) {
			const override = getConfig<string>(accessor, overrideKey);
			if (override) { return override; }
		}
		return undefined;
	}

	for (const overrideKey of overrideKeys) {
		const override = getConfig<string>(accessor, overrideKey);
		if (override) { return override; }
	}
	return undefined;
}

function getEndpointOverrideUrl(accessor: ServicesAccessor, endpoint: keyof ServiceEndpoints): string | undefined {
	switch (endpoint) {
		case 'proxy':
			return urlConfigOverride(
				accessor,
				[ConfigKey.DebugOverrideProxyUrl, ConfigKey.DebugOverrideProxyUrlLegacy],
				[ConfigKey.DebugTestOverrideProxyUrl, ConfigKey.DebugTestOverrideProxyUrlLegacy]
			);
		case 'origin-tracker':
			if (!BuildInfo.isProduction()) {
				return urlConfigOverride(accessor, [ConfigKey.DebugSnippyOverrideUrl]);
			}
	}
}

/**
 * Azure-only fork: detect Azure OpenAI endpoint and construct proper URL.
 *
 * GitHub proxy URL pattern: {proxy}/v1/engines/{modelId}/completions
 * Azure OpenAI URL pattern: {endpoint}/openai/deployments/{deployment}/completions?api-version=2024-12-01-preview
 */
function isAzureOpenAIEndpoint(url: string): boolean {
	return url.includes('.openai.azure.com') || url.includes('.cognitiveservices.azure.com');
}

export function getEndpointUrl(
	accessor: ServicesAccessor,
	token: CopilotToken,
	endpoint: keyof ServiceEndpoints,
	...paths: string[]
): string {
	const root = getEndpointOverrideUrl(accessor, endpoint) ?? (token.endpoints ? token.endpoints[endpoint] : undefined) ?? getDefaultEndpoints(accessor)[endpoint];

	// Azure-only fork: rewrite URL for Azure OpenAI format
	if (isAzureOpenAIEndpoint(root) && endpoint === 'proxy') {
		// paths is typically ['v1/engines', modelId, 'completions']
		// We need to extract the model ID and endpoint type, then construct Azure URL
		if (paths.length >= 3 && paths[0] === 'v1/engines') {
			const modelId = paths[1];
			const endpointPath = paths.slice(2).join('/');
			const apiVersion = '2024-12-01-preview';
			return `${root}/openai/deployments/${modelId}/${endpointPath}?api-version=${apiVersion}`;
		}
	}

	return joinPath(root, ...paths);
}

/**
 * Return the endpoints from the most recent token, or fall back to the defaults if we don't have one.
 * Generally you should be using token.endpoints or getEndpointUrl() instead.
 */
export function getLastKnownEndpoints(accessor: ServicesAccessor) {
	return accessor.get(IAuthenticationService).copilotToken?.endpoints ?? getDefaultEndpoints(accessor);
}

