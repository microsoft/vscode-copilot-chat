/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderConfig } from '@github/copilot/sdk';
import { ConfigKey, type IConfigurationService } from '../../../../platform/configuration/common/configurationService';

/**
 * Whether the user has configured a custom model provider (BYOK).
 * Checks extension settings first, then falls back to the
 * `COPILOT_PROVIDER_BASE_URL` environment variable.
 */
export function isCopilotByokMode(configService: IConfigurationService): boolean {
	return !!getByokBaseUrl(configService);
}

/**
 * Builds a `ProviderConfig` from extension settings or BYOK environment variables.
 * Extension settings take precedence over environment variables.
 * Returns `undefined` if no custom provider base URL is configured.
 */
export function getCopilotByokProvider(configService: IConfigurationService): ProviderConfig | undefined {
	const baseUrl = getByokBaseUrl(configService);
	if (!baseUrl) {
		return undefined;
	}
	const limits = getCopilotByokTokenLimits(configService);
	// String settings use || because getConfig() returns undefined (not empty string) for
	// unconfigured settings, and || correctly falls through to the env var.
	// Number settings use isConfigured() because getConfig() returns 0 for unconfigured
	// integer settings, and 0 is falsy but semantically different from "not set".
	const type = configService.getConfig(ConfigKey.Advanced.CLIProviderType) || process.env['COPILOT_PROVIDER_TYPE'] || undefined;
	const wireApi = configService.getConfig(ConfigKey.Advanced.CLIProviderWireApi) || process.env['COPILOT_PROVIDER_WIRE_API'] || undefined;
	const apiKey = configService.getConfig(ConfigKey.Advanced.CLIProviderApiKey) || process.env['COPILOT_PROVIDER_API_KEY'] || undefined;
	const bearerToken = configService.getConfig(ConfigKey.Advanced.CLIProviderBearerToken) || process.env['COPILOT_PROVIDER_BEARER_TOKEN'] || undefined;
	const modelLimitsId = configService.getConfig(ConfigKey.Advanced.CLIProviderModelLimitsId) || process.env['COPILOT_PROVIDER_MODEL_LIMITS_ID'] || undefined;
	const azureApiVersion = configService.getConfig(ConfigKey.Advanced.CLIProviderAzureApiVersion) || process.env['COPILOT_PROVIDER_AZURE_API_VERSION'] || undefined;
	return {
		baseUrl,
		type: type as ProviderConfig['type'],
		wireApi: wireApi as ProviderConfig['wireApi'],
		apiKey,
		bearerToken,
		modelLimitsId,
		maxPromptTokens: limits.maxPromptTokens,
		maxOutputTokens: limits.maxOutputTokens,
		...(azureApiVersion ? { azure: { apiVersion: azureApiVersion } } : {}),
	};
}

/**
 * Whether Copilot CLI offline mode is enabled.
 * Checks extension settings first, then falls back to the
 * `COPILOT_OFFLINE` environment variable (only the exact string `"true"`).
 * When enabled, extension-side GitHub MCP server setup is skipped.
 */
export function isCopilotOfflineMode(configService: IConfigurationService): boolean {
	if (configService.getConfig(ConfigKey.Advanced.CLIOffline)) {
		return true;
	}
	return process.env['COPILOT_OFFLINE'] === 'true';
}

/**
 * Returns the BYOK model name.
 * Checks extension settings first, then falls back to `COPILOT_MODEL`.
 */
export function getCopilotByokModel(configService: IConfigurationService): string | undefined {
	return configService.getConfig(ConfigKey.Advanced.CLIProviderModel) || process.env['COPILOT_MODEL'] || undefined;
}

/**
 * Returns optional BYOK token limit overrides.
 * Checks extension settings first, then falls back to env vars.
 */
export function getCopilotByokTokenLimits(configService: IConfigurationService): { maxPromptTokens?: number; maxOutputTokens?: number } {
	const configMaxPrompt = configService.isConfigured(ConfigKey.Advanced.CLIProviderMaxPromptTokens) ? configService.getConfig(ConfigKey.Advanced.CLIProviderMaxPromptTokens) : undefined;
	const configMaxOutput = configService.isConfigured(ConfigKey.Advanced.CLIProviderMaxOutputTokens) ? configService.getConfig(ConfigKey.Advanced.CLIProviderMaxOutputTokens) : undefined;
	return {
		maxPromptTokens: configMaxPrompt ?? parseOptionalInt(process.env['COPILOT_PROVIDER_MAX_PROMPT_TOKENS']),
		maxOutputTokens: configMaxOutput ?? parseOptionalInt(process.env['COPILOT_PROVIDER_MAX_OUTPUT_TOKENS']),
	};
}

function getByokBaseUrl(configService: IConfigurationService): string | undefined {
	const configBaseUrl = configService.isConfigured(ConfigKey.Advanced.CLIProviderBaseUrl) ? configService.getConfig(ConfigKey.Advanced.CLIProviderBaseUrl) : undefined;
	return configBaseUrl || process.env['COPILOT_PROVIDER_BASE_URL'] || undefined;
}

function parseOptionalInt(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}
