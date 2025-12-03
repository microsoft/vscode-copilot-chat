/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export async function createRequestHMAC(hmacSecret: string | undefined): Promise<string | undefined> {
	// If we don't have the right env variables this could happen
	if (!hmacSecret) {
		return undefined;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(hmacSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);

	const current = Math.floor(Date.now() / 1000).toString();
	const textEncoder = new TextEncoder();
	const data = textEncoder.encode(current);

	const signature = await crypto.subtle.sign("HMAC", key, data);
	const signatureArray = Array.from(new Uint8Array(signature));
	const signatureHex = signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');

	return `${current}.${signatureHex}`;
}

export async function createSha256Hash(data: string | Uint8Array): Promise<string> {
	const dataUint8 = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	const hashBuffer = await crypto.subtle.digest('SHA-256', dataUint8);
	const hashArray = new Uint8Array(hashBuffer);
	let hashHex = '';
	for (const byte of hashArray) {
		hashHex += byte.toString(16).padStart(2, '0');
	}

	return hashHex;
}

const _cachedSha256Hashes = new Map<string, string>();
export async function cacheSha256Hash(text: string): Promise<void> {
	if (_cachedSha256Hashes.has(text)) {
		return;
	}

	_cachedSha256Hashes.set(text, ''); // Placeholder to avoid duplicate work
	const hash = await createSha256Hash(text);
	_cachedSha256Hashes.set(text, hash);
}
export function getSha256Hash(text: string): string {
	const hash = _cachedSha256Hashes.get(text);
	if (!hash) {
		throw new Error(`Expected hash to already be cached: '${text}'`);
	}

	return hash;
}
