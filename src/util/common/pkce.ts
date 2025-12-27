/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth2 authorization code flow
 * Implements RFC 7636 - https://tools.ietf.org/html/rfc7636
 *
 * Based on VS Code's microsoft-authentication extension implementation.
 */

function dec2hex(dec: number): string {
	return ('0' + dec.toString(16)).slice(-2);
}

function sha256(plain: string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(plain);
	return crypto.subtle.digest('SHA-256', data);
}

function base64urlencode(a: ArrayBuffer): string {
	let str = '';
	const bytes = new Uint8Array(a);
	const len = bytes.byteLength;
	for (let i = 0; i < len; i++) {
		str += String.fromCharCode(bytes[i]);
	}
	// Use btoa for base64 encoding (browser-compatible)
	return btoa(str)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/**
 * Generate cryptographically secure random string for PKCE code verifier
 * Generates 56 characters (28 random bytes as hex)
 */
export function generateCodeVerifier(): string {
	const array = new Uint32Array(56 / 2);
	crypto.getRandomValues(array);
	return Array.from(array, dec2hex).join('');
}

/**
 * Generate code challenge from code verifier using SHA-256
 * code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
 */
export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
	const hashed = await sha256(codeVerifier);
	return base64urlencode(hashed);
}

/**
 * Generate random state parameter for CSRF protection
 */
export function generateState(): string {
	return generateCodeVerifier();
}

/**
 * Generate random nonce for OpenID Connect
 */
export function generateNonce(): string {
	return generateCodeVerifier();
}
