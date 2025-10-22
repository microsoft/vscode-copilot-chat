/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CompletionsCapiBridge } from '../../bridge/src/completionsCapiBridge';
import { CopilotToken } from './auth/copilotTokenManager';
import { getLastCopilotToken } from './auth/copilotTokenNotifier';
import { ConfigKey, ConfigKeyType, getConfig, isProduction } from './config';
import { Context } from './context';
import { isRunningInTest } from './testing/runtimeMode';
import { joinPath } from './util/uri';

type ServiceEndpoints = {
	proxy: string;
	'origin-tracker': string;
};

function getDefaultEndpoints(ctx: Context): ServiceEndpoints {
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
	ctx: Context,
	overrideKeys: ConfigKeyType[],
	testOverrideKeys?: ConfigKeyType[]
): string | undefined {
	if (testOverrideKeys && isRunningInTest(ctx)) {
		for (const overrideKey of testOverrideKeys) {
			const override = getConfig<string>(ctx, overrideKey);
			if (override) { return override; }
		}
		return undefined;
	}

	for (const overrideKey of overrideKeys) {
		const override = getConfig<string>(ctx, overrideKey);
		if (override) { return override; }
	}
	return undefined;
}

function getEndpointOverrideUrl(ctx: Context, endpoint: keyof ServiceEndpoints): string | undefined {
	switch (endpoint) {
		case 'proxy':
			return urlConfigOverride(
				ctx,
				[ConfigKey.DebugOverrideProxyUrl, ConfigKey.DebugOverrideProxyUrlLegacy],
				[ConfigKey.DebugTestOverrideProxyUrl, ConfigKey.DebugTestOverrideProxyUrlLegacy]
			);
		case 'origin-tracker':
			if (!isProduction(ctx)) {
				return urlConfigOverride(ctx, [ConfigKey.DebugSnippyOverrideUrl]);
			}
	}
}

export function getEndpointUrl(
	ctx: Context,
	token: CopilotToken,
	endpoint: keyof ServiceEndpoints,
	...paths: string[]
): string {
	const root = getEndpointOverrideUrl(ctx, endpoint) ?? (token.endpoints ? token.endpoints[endpoint] : undefined) ?? getDefaultEndpoints(ctx)[endpoint];
	return joinPath(root, ...paths);
}

/**
 * Return the endpoints from the most recent token, or fall back to the defaults if we don't have one.
 * Generally you should be using token.endpoints or getEndpointUrl() instead.
 */
export function getLastKnownEndpoints(ctx: Context) {
	return getLastCopilotToken(ctx)?.endpoints ?? getDefaultEndpoints(ctx);
}

