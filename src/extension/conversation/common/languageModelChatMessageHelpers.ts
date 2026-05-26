/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { LanguageModelDataPart } from '../../../vscodeTypes';

export enum ChatImageMimeType {
	PNG = 'image/png',
	JPEG = 'image/jpeg',
	GIF = 'image/gif',
	WEBP = 'image/webp',
	BMP = 'image/bmp',
}

export function isImageDataPart(part: unknown): part is LanguageModelDataPart {
	if (part instanceof LanguageModelDataPart && isChatImageMimeType(part.mimeType)) {
		return true;
	}

	return false;
}

/**
 * Detect the actual MIME type by inspecting the file's magic bytes,
 * since the declared mimeType (based on file extension) may be wrong.
 */
export function detectImageMimeType(data: Uint8Array): ChatImageMimeType | undefined {
	if (data.length < 4) {
		return undefined;
	}

	// JPEG: FF D8 FF
	if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
		return ChatImageMimeType.JPEG;
	}
	// PNG: 89 50 4E 47
	if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
		return ChatImageMimeType.PNG;
	}
	// GIF: 47 49 46 38
	if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
		return ChatImageMimeType.GIF;
	}
	// WebP: RIFF....WEBP
	if (data.length >= 12 &&
		data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
		data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
		return ChatImageMimeType.WEBP;
	}
	// BMP: 42 4D
	if (data[0] === 0x42 && data[1] === 0x4D) {
		return ChatImageMimeType.BMP;
	}

	return undefined;
}

function isChatImageMimeType(mimeType: string): mimeType is ChatImageMimeType {
	switch (mimeType) {
		case ChatImageMimeType.JPEG:
		case ChatImageMimeType.PNG:
		case ChatImageMimeType.GIF:
		case ChatImageMimeType.WEBP:
		case ChatImageMimeType.BMP:
			return true;
		default:
			return false;
	}
}
