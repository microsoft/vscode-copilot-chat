/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CompletionsAuthenticationServiceBridge } from '../../../bridge/src/completionsAuthenticationServiceBridge';
import { CompletionsExperimentationServiceBridge } from '../../../bridge/src/completionsExperimentationServiceBridge';
import { CopilotToken } from '../auth/copilotTokenManager';
import { getUserKind } from '../auth/orgs';
import {
	BuildInfo,
	BuildType,
	ConfigKey,
	getBuildType,
	getConfig,
	getVersion
} from '../config';
import { Context } from '../context';
import { Filter, Release } from './filters';
import { getEngineRequestInfo } from '../openai/config';
import { IDisposable } from '../../../../../../util/vs/base/common/lifecycle';

export function setupCompletionsExperimentationService(ctx: Context): IDisposable {
	const authService = ctx.get(CompletionsAuthenticationServiceBridge).authenticationService;

	const disposable = authService.onDidAccessTokenChange(() => {
		authService.getCopilotToken()
			.then(t => updateCompletionsFilters(ctx, t))
			.catch(err => { });
	});

	updateCompletionsFilters(ctx, authService.copilotToken);

	return disposable;
}

function getPluginRelease(ctx: Context): Release {
	if (getBuildType(ctx) === BuildType.NIGHTLY) {
		return Release.Nightly;
	}
	return Release.Stable;
}

function updateCompletionsFilters(ctx: Context, token: Omit<CopilotToken, "token"> | undefined) {
	const exp = ctx.get(CompletionsExperimentationServiceBridge);

	const filters = createCompletionsFilters(ctx, token);

	exp.experimentationService.setCompletionsFilters(filters);
}

export function createCompletionsFilters(ctx: Context, token: Omit<CopilotToken, "token"> | undefined) {
	const filters = new Map<Filter, string>();

	filters.set(Filter.ExtensionRelease, getPluginRelease(ctx));
	filters.set(Filter.CopilotOverrideEngine, getConfig(ctx, ConfigKey.DebugOverrideEngine) || getConfig(ctx, ConfigKey.DebugOverrideEngineLegacy));
	filters.set(Filter.CopilotClientVersion, ctx.get(BuildInfo).isProduction() ? getVersion(ctx) : '1.999.0');

	if (token) {
		const userKind = getUserKind(token);
		const customModel = token.getTokenValue('ft') ?? '';
		const orgs = token.getTokenValue('ol') ?? '';
		const customModelNames = token.getTokenValue('cml') ?? '';
		const copilotTrackingId = token.getTokenValue('tid') ?? '';

		filters.set(Filter.CopilotUserKind, userKind);
		filters.set(Filter.CopilotCustomModel, customModel);
		filters.set(Filter.CopilotOrgs, orgs);
		filters.set(Filter.CopilotCustomModelNames, customModelNames);
		filters.set(Filter.CopilotTrackingId, copilotTrackingId);
		filters.set(Filter.CopilotUserKind, getUserKind(token));
	}

	const model = getEngineRequestInfo(ctx).modelId;
	filters.set(Filter.CopilotEngine, model);
	return filters;
}