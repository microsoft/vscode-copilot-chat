/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderConfig } from '@github/copilot/sdk';

/**
 * Whether the user has configured a custom model provider (BYOK).
 * When `COPILOT_PROVIDER_BASE_URL` is set, the CLI uses this provider
 * instead of GitHub Copilot's model routing and GitHub authentication
 * is not required.
 */
export function isCopilotByokMode(): boolean {
	return !!process.env['COPILOT_PROVIDER_BASE_URL'];
}

/**
 * Builds a `ProviderConfig` from BYOK environment variables.
 * Returns `undefined` if `COPILOT_PROVIDER_BASE_URL` is not set.
 */
export function getCopilotByokProvider(): ProviderConfig | undefined {
	const baseUrl = process.env['COPILOT_PROVIDER_BASE_URL'];
	if (!baseUrl) {
		return undefined;
	}
	const limits = getCopilotByokTokenLimits();
	return {
		baseUrl,
		type: (process.env['COPILOT_PROVIDER_TYPE'] as ProviderConfig['type']) || undefined,
		wireApi: (process.env['COPILOT_PROVIDER_WIRE_API'] as ProviderConfig['wireApi']) || undefined,
		apiKey: process.env['COPILOT_PROVIDER_API_KEY'] || undefined,
		bearerToken: process.env['COPILOT_PROVIDER_BEARER_TOKEN'] || undefined,
		modelLimitsId: process.env['COPILOT_PROVIDER_MODEL_LIMITS_ID'] || undefined,
		maxPromptTokens: limits.maxPromptTokens,
		maxOutputTokens: limits.maxOutputTokens,
		...(process.env['COPILOT_PROVIDER_AZURE_API_VERSION']
			? { azure: { apiVersion: process.env['COPILOT_PROVIDER_AZURE_API_VERSION'] } }
			: {}),
	};
}

/**
 * Whether Copilot CLI offline mode is enabled for this extension integration.
 * Matches the CLI's env parsing: only the exact string `"true"` enables offline mode.
 * When enabled, extension-side GitHub MCP server setup is skipped.
 * Additional offline behavior may still be handled inside the CLI SDK itself.
 */
export function isCopilotOfflineMode(): boolean {
	return process.env['COPILOT_OFFLINE'] === 'true';
}

/**
 * Returns the BYOK model name from `COPILOT_MODEL`, if set.
 */
export function getCopilotByokModel(): string | undefined {
	return process.env['COPILOT_MODEL'] || undefined;
}

/**
 * Returns optional BYOK token limit overrides from env vars.
 */
export function getCopilotByokTokenLimits(): { maxPromptTokens?: number; maxOutputTokens?: number } {
	return {
		maxPromptTokens: parseOptionalInt(process.env['COPILOT_PROVIDER_MAX_PROMPT_TOKENS']),
		maxOutputTokens: parseOptionalInt(process.env['COPILOT_PROVIDER_MAX_OUTPUT_TOKENS']),
	};
}

function parseOptionalInt(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}
