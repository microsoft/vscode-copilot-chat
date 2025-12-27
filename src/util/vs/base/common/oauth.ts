/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Decode base64url string (JWT format)
 */
function decodeBase64(input: string): string {
// Convert base64url to base64
const base64 = input
.replace(/-/g, '+')
.replace(/_/g, '/');

// Decode base64 to string
try {
return atob(base64);
} catch {
throw new Error('Invalid base64 encoding');
}
}

/**
 * Base OAuth 2.0 error codes as specified in RFC 6749.
 */
export const enum AuthorizationErrorType {
InvalidRequest = 'invalid_request',
InvalidClient = 'invalid_client',
InvalidGrant = 'invalid_grant',
UnauthorizedClient = 'unauthorized_client',
UnsupportedGrantType = 'unsupported_grant_type',
InvalidScope = 'invalid_scope'
}

/**
 * Metadata about an OAuth 2.0 Authorization Server.
 */
export interface IAuthorizationServerMetadata {
issuer: string;
authorization_endpoint?: string;
token_endpoint?: string;
revocation_endpoint?: string;
scopes_supported?: string[];
response_types_supported: string[];
grant_types_supported?: string[];
code_challenge_methods_supported?: string[];
}

/**
 * Token response from OAuth 2.0 authorization server.
 */
export interface IAuthorizationTokenResponse {
access_token: string;
token_type: string;
expires_in?: number;
refresh_token?: string;
scope?: string;
id_token?: string;
}

/**
 * Standard JWT claims as defined in RFC 7519.
 */
export interface IAuthorizationJWTClaims {
iss?: string;
sub?: string;
aud?: string | string[];
exp?: number;
nbf?: number;
iat?: number;
jti?: string;
email?: string;
email_verified?: boolean;
name?: string;
given_name?: string;
family_name?: string;
middle_name?: string;
nickname?: string;
preferred_username?: string;
profile?: string;
picture?: string;
website?: string;
gender?: string;
birthdate?: string;
zoneinfo?: string;
locale?: string;
phone_number?: string;
phone_number_verified?: boolean;
address?: {
formatted?: string;
street_address?: string;
locality?: string;
region?: string;
postal_code?: string;
country?: string;
};
updated_at?: number;
[key: string]: any;
}

/**
 * Parse JWT token and extract claims.
 */
export function getClaimsFromJWT(token: string): IAuthorizationJWTClaims {
const parts = token.split('.');
if (parts.length !== 3) {
throw new Error('Invalid JWT token format: token must have three parts separated by dots');
}

const [_header, payload, _signature] = parts;

try {
const decodedPayload = JSON.parse(decodeBase64(payload));
if (typeof decodedPayload !== 'object') {
throw new Error('Invalid JWT token format: payload is not a JSON object');
}

return decodedPayload;
} catch (e) {
if (e instanceof Error) {
throw new Error(`Failed to parse JWT token: ${e.message}`);
}
throw new Error('Failed to parse JWT token');
}
}
