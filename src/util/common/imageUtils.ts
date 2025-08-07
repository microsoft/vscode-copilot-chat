/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../vs/base/common/uri';


export function getImageDimensions(base64: string) {
	if (!base64.startsWith('data:image/')) {
		throw new Error("Could not read image: invalid base64 image string");
	}
	const rawString = base64.split(',')[1];
	switch (getMimeType(rawString)) {
		case 'image/png':
			return getPngDimensions(rawString);
		case 'image/gif':
			return getGifDimensions(rawString);
		case 'image/jpeg':
		case 'image/jpg':
			return getJpegDimensions(rawString);
		case 'image/webp':
			return getWebPDimensions(rawString);
		default:
			throw new Error("Unsupported image format");
	}
}

export function getPngDimensions(base64: string) {
	const header = atob(base64.slice(0, 50)).slice(16, 24);
	const uint8 = Uint8Array.from(header, c => c.charCodeAt(0));
	const dataView = new DataView(uint8.buffer);

	return {
		width: dataView.getUint32(0, false),
		height: dataView.getUint32(4, false)
	};
}

export function getGifDimensions(base64: string) {
	const header = atob(base64.slice(0, 50));
	const uint8 = Uint8Array.from(header, c => c.charCodeAt(0));
	const dataView = new DataView(uint8.buffer);

	return {
		width: dataView.getUint16(6, true),
		height: dataView.getUint16(8, true)
	};
}

export function getJpegDimensions(base64: string) {
	const binary = atob(base64);
	const uint8 = Uint8Array.from(binary, c => c.charCodeAt(0));
	const length = uint8.length;
	let offset = 2;

	while (offset < length) {
		const marker = (uint8[offset] << 8) | uint8[offset + 1];
		const segmentLength = (uint8[offset + 2] << 8) | uint8[offset + 3];

		if (marker >= 0xFFC0 && marker <= 0xFFC2) {
			const dataView = new DataView(uint8.buffer, offset + 5, 4);
			return {
				height: dataView.getUint16(0, false),
				width: dataView.getUint16(2, false)
			};
		}

		offset += 2 + segmentLength;
	}

	throw new Error("JPEG dimensions not found");
}

export function getWebPDimensions(base64String: string) {
	const binaryString = atob(base64String);
	const binaryData = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		binaryData[i] = binaryString.charCodeAt(i);
	}

	if (binaryString.slice(0, 4) !== "RIFF" || binaryString.slice(8, 12) !== "WEBP") {
		throw new Error("Not a valid WebP image.");
	}

	const chunkHeader = binaryString.slice(12, 16);

	if (chunkHeader === "VP8 ") {
		const width = (binaryData[26] | (binaryData[27] << 8)) & 0x3FFF;
		const height = (binaryData[28] | (binaryData[29] << 8)) & 0x3FFF;
		return { width, height };
	} else if (chunkHeader === "VP8L") {
		const width = (binaryData[21] | (binaryData[22] << 8)) & 0x3FFF;
		const height = (binaryData[23] | (binaryData[24] << 8)) & 0x3FFF;
		return { width, height };
	} else if (chunkHeader === "VP8X") {
		const width = ((binaryData[24] | (binaryData[25] << 8) | (binaryData[26] << 16)) & 0xFFFFFF) + 1;
		const height = ((binaryData[27] | (binaryData[28] << 8) | (binaryData[29] << 16)) & 0xFFFFFF) + 1;
		return { width, height };
	} else {
		throw new Error("Unsupported WebP format.");
	}
}

export function getMimeType(base64String: string): string | undefined {
	const mimeTypes: { [key: string]: string } = {
		'/9j/': 'image/jpeg',
		'iVBOR': 'image/png',
		'R0lGOD': 'image/gif',
		'UklGR': 'image/webp',
	};

	for (const prefix of Object.keys(mimeTypes)) {
		if (base64String.startsWith(prefix)) {
			return mimeTypes[prefix];
		}
	}
}

export function extractImageAttributes(line: string, refineExisting?: boolean): string | undefined {
	// Regex to match markdown image syntax ![alt text](<?image_path>?)
	const markdownImageRegex = /!\[([^\]]*)\]\(<?([^)<>]+?)>?\)/;
	// Updated regex to match HTML image syntax with alt and src in any order
	const htmlImageRegex = /<img\s+(?:alt=["']([^"']*)["']\s*)?src=["']([^"']+)["'](?:\s*alt=["']([^"']*)["'])?/;

	let match;
	let imagePath = '';
	let altText = '';

	if ((match = markdownImageRegex.exec(line)) !== null) {
		imagePath = match[2];
		altText = match[1];
	} else if ((match = htmlImageRegex.exec(line)) !== null) {
		imagePath = match[2]; // src is always the second group
		altText = match[1] || match[3] || ''; // alt is sometimes first or third
	} else {
		// Try Learn Markdown format - check if it's a Learn Markdown image
		const learnMarkdownRegex = /:::image\s+.*?source=["']([^"']+)["'].*?:::/;
		const sourceMatch = learnMarkdownRegex.exec(line);
		if (sourceMatch) {
			imagePath = sourceMatch[1];
			// Check if there's an alt-text attribute
			const altTextRegex = /alt-text=["']([^"']*?)["']/;
			const altMatch = altTextRegex.exec(line);
			altText = altMatch ? altMatch[1] : '';
		} else {
			return undefined;
		}
	}

	if (refineExisting ? !altText : !!altText) {
		return undefined;
	}

	return imagePath;
}

/**
 * Upload image data to GitHub Copilot chat attachments endpoint
 * @param binaryData The image binary data as VSBuffer
 * @param name The name for the uploaded file
 * @param mimeType The MIME type of the image
 * @param token The authentication token for GitHub API
 * @returns Promise<URI> The URI of the uploaded image
 */
export async function chatImageUploader(binaryData: Uint8Array, name: string, mimeType: string | undefined, token: string | undefined): Promise<URI> {
	if (!mimeType || !token) {
		throw new Error('Missing required mimeType or token for image upload');
	}

	const sanitizedName = name.replace(/\s+/g, '').replace(/%20/g, '');
	let uploadName = sanitizedName;
	const subtype = mimeType.split('/')[1].split('+')[0].toLowerCase();
	if (!uploadName.toLowerCase().endsWith(`.${subtype}`)) {
		uploadName = `${uploadName}.${subtype}`;
	}
	const url = `https://uploads.github.com/copilot/chat/attachments?name=${uploadName}&content_type=${mimeType}`;

	const init: RequestInit = {
		method: 'POST',
		body: binaryData,
		credentials: 'include',
		headers: {
			'Content-Type': 'application/octet-stream',
			'Authorization': `Bearer ${token}`
		}
	};

	try {
		const response = await fetch(url, init);
		if (!response.ok) {
			throw new Error(`Invalid GitHub URL provided: ${response.status} ${response.statusText}`);
		}
		const result = await response.json() as { url: string };
		return URI.parse(result.url);
	} catch (error) {
		throw new Error(`Error uploading image: ${error}`);
	}
}
