/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ServicesAccessor } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { CompletionsCapiBridge } from '../../bridge/src/completionsCapiBridge';
import { CopilotToken } from './auth/copilotTokenManager';
import { getLastCopilotToken } from './auth/copilotTokenNotifier';
import { ConfigKey, ConfigKeyType, getConfig, ICompletionsBuildInfoService } from './config';
import { ICompletionsContextService } from './context';
import { ICompletionsRuntimeModeService } from './util/runtimeMode';
import { joinPath } from './util/uri';

type ServiceEndpoints = {
	proxy: string;
	'origin-tracker': string;
};

function getDefaultEndpoints(accessor: ServicesAccessor): ServiceEndpoints {
	const ctx = accessor.get(ICompletionsContextService);
	const capi = ctx.get(CompletionsCapiBridge);
	return {
		proxy: capi.capiClientService.proxyBaseURL,
		'origin-tracker': capi.capiClientService.originTrackerURL,
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
	if (testOverrideKeys && accessor.get(ICompletionsRuntimeModeService).isRunningInTest()) {
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
			if (!accessor.get(ICompletionsBuildInfoService).isProduction()) {
				return urlConfigOverride(accessor, [ConfigKey.DebugSnippyOverrideUrl]);
			}
	}
}

export function getEndpointUrl(
	accessor: ServicesAccessor,
	token: CopilotToken,
	endpoint: keyof ServiceEndpoints,
	...paths: string[]
): string {
	const root = getEndpointOverrideUrl(accessor, endpoint) ?? (token.endpoints ? token.endpoints[endpoint] : undefined) ?? getDefaultEndpoints(accessor)[endpoint];
	return joinPath(root, ...paths);
}

/**
 * Return the endpoints from the most recent token, or fall back to the defaults if we don't have one.
 * Generally you should be using token.endpoints or getEndpointUrl() instead.
 */
export function getLastKnownEndpoints(accessor: ServicesAccessor) {
	return getLastCopilotToken(accessor)?.endpoints ?? getDefaultEndpoints(accessor);
}

