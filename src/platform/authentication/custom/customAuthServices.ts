/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ExtensionContext } from 'vscode';
import { IInstantiationServiceBuilder } from '../../../util/common/services';
import { SyncDescriptor } from '../../../util/vs/platform/instantiation/common/descriptors';
import { IAuthenticationService } from '../common/authentication';
import { ICopilotTokenManager } from '../common/copilotTokenManager';
import { CustomAuthenticationService } from './customAuthenticationService';
import { CustomCopilotTokenManager } from './customCopilotTokenManager';

/**
 * Configuration for custom authentication services
 */
export interface CustomAuthConfig {
	/** API key for your custom authentication system */
	apiKey: string;
	/** Endpoint URL for token acquisition */
	endpoint: string;
	/** Organization/provider name for display */
	orgProvider: string;
}

/**
 * Registers custom authentication services that behave as if the user is fully authenticated
 * with access to all GitHub Copilot features.
 *
 * This replaces the default authentication services with implementations that:
 * - Always return valid tokens
 * - Grant full permissive access
 * - Enable all Copilot features
 * - Simulate a business plan subscription
 *
 * @param builder The service builder to register services with
 * @param extensionContext VS Code extension context
 * @param customConfig Configuration for the custom authentication
 */
export function registerCustomAuthenticationServices(
	builder: IInstantiationServiceBuilder,
	extensionContext: ExtensionContext,
	customConfig: CustomAuthConfig
): void {
	// Register custom token manager that always provides valid tokens
	builder.define(ICopilotTokenManager, new SyncDescriptor(CustomCopilotTokenManager, [
		customConfig.apiKey,
		customConfig.endpoint
	]));

	// Register custom authentication service with full access
	builder.define(IAuthenticationService, new SyncDescriptor(CustomAuthenticationService, [
		customConfig.orgProvider
	]));
}

/**
 * Helper function to get custom authentication configuration from environment variables
 * or VS Code settings.
 */
export function getCustomAuthConfig(): CustomAuthConfig | undefined {
	const apiKey = process.env.CUSTOM_COPILOT_API_KEY || '';
	const endpoint = process.env.CUSTOM_COPILOT_ENDPOINT || 'https://custom-auth.example.com/token';
	const orgProvider = process.env.CUSTOM_ORG_PROVIDER || 'CustomOrg';

	if (!apiKey) {
		return undefined;
	}

	return {
		apiKey,
		endpoint,
		orgProvider
	};
}
