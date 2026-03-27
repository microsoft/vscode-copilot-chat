/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { ChatImageMimeType, detectImageMimeType } from '../languageModelChatMessageHelpers';

describe('detectImageMimeType', () => {
	test('detects JPEG from magic bytes', () => {
		const data = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
		expect(detectImageMimeType(data)).toBe(ChatImageMimeType.JPEG);
	});

	test('detects PNG from magic bytes', () => {
		const data = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
		expect(detectImageMimeType(data)).toBe(ChatImageMimeType.PNG);
	});

	test('detects GIF from magic bytes', () => {
		const data = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
		expect(detectImageMimeType(data)).toBe(ChatImageMimeType.GIF);
	});

	test('detects WebP from magic bytes', () => {
		// RIFF....WEBP
		const data = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
		expect(detectImageMimeType(data)).toBe(ChatImageMimeType.WEBP);
	});

	test('detects BMP from magic bytes', () => {
		const data = new Uint8Array([0x42, 0x4D, 0x00, 0x00]);
		expect(detectImageMimeType(data)).toBe(ChatImageMimeType.BMP);
	});

	test('returns undefined for unknown format', () => {
		const data = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
		expect(detectImageMimeType(data)).toBeUndefined();
	});

	test('returns undefined for data shorter than 4 bytes', () => {
		const data = new Uint8Array([0xFF, 0xD8]);
		expect(detectImageMimeType(data)).toBeUndefined();
	});

	test('returns undefined for empty data', () => {
		const data = new Uint8Array(0);
		expect(detectImageMimeType(data)).toBeUndefined();
	});

	test('correctly identifies JPEG when file extension might suggest PNG', () => {
		// This is the actual bug scenario: file named .png but content is JPEG
		const jpegData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x10]);
		expect(detectImageMimeType(jpegData)).toBe(ChatImageMimeType.JPEG);
	});
});
