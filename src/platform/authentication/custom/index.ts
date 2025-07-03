/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Custom Authentication Implementation for GitHub Copilot Chat
 *
 * This module provides custom authentication services that behave as if the user
 * is fully authenticated with access to all GitHub Copilot features:
 *
 * - Always authenticated with valid tokens
 * - Full permissive GitHub access (repo, workflow scopes)
 * - Business plan Copilot subscription
 * - VS Code team member benefits
 * - Azure DevOps integration
 * - Never expires tokens for uninterrupted service
 */

export { CustomAuthenticationService } from './customAuthenticationService';
export { getCustomAuthConfig, registerCustomAuthenticationServices, type CustomAuthConfig } from './customAuthServices';
export { CustomCopilotTokenManager } from './customCopilotTokenManager';

