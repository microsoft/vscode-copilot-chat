/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isGeminiFamily, modelSupportsImageMimeType } from '../chatModelCapabilities';

describe('chatModelCapabilities', () => {
	describe('isGeminiFamily', () => {
		it('should detect Gemini models by family name', () => {
			expect(isGeminiFamily({ family: 'gemini-1.5-pro' } as any)).toBe(true);
			expect(isGeminiFamily({ family: 'gemini-2.0-flash' } as any)).toBe(true);
			expect(isGeminiFamily({ family: 'Gemini-3-Ultra' } as any)).toBe(true);
			expect(isGeminiFamily({ family: 'GEMINI' } as any)).toBe(true);
		});

		it('should return false for non-Gemini models', () => {
			expect(isGeminiFamily({ family: 'gpt-4' } as any)).toBe(false);
			expect(isGeminiFamily({ family: 'claude-3.5-sonnet' } as any)).toBe(false);
			expect(isGeminiFamily({ family: 'gpt-5' } as any)).toBe(false);
		});

		it('should handle edge cases', () => {
			expect(isGeminiFamily(undefined)).toBe(false);
			expect(isGeminiFamily(null as any)).toBe(false);
			expect(isGeminiFamily('')).toBe(false);
		});
	});

	describe('modelSupportsImageMimeType', () => {
		describe('Gemini models', () => {
			const geminiModel = { family: 'gemini-1.5-pro' } as any;

			it('should support PNG images', () => {
				expect(modelSupportsImageMimeType(geminiModel, 'image/png')).toBe(true);
			});

			it('should support JPEG images', () => {
				expect(modelSupportsImageMimeType(geminiModel, 'image/jpeg')).toBe(true);
			});

			it('should support WEBP images', () => {
				expect(modelSupportsImageMimeType(geminiModel, 'image/webp')).toBe(true);
			});

			it('should support HEIC images', () => {
				expect(modelSupportsImageMimeType(geminiModel, 'image/heic')).toBe(true);
			});

			it('should support HEIF images', () => {
				expect(modelSupportsImageMimeType(geminiModel, 'image/heif')).toBe(true);
			});

			it('should NOT support GIF images', () => {
				expect(modelSupportsImageMimeType(geminiModel, 'image/gif')).toBe(false);
			});

			it('should NOT support BMP images', () => {
				expect(modelSupportsImageMimeType(geminiModel, 'image/bmp')).toBe(false);
			});

			it('should NOT support SVG images', () => {
				expect(modelSupportsImageMimeType(geminiModel, 'image/svg+xml')).toBe(false);
			});
		});

		describe('Non-Gemini models', () => {
			const gptModel = { family: 'gpt-4' } as any;
			const claudeModel = { family: 'claude-3.5-sonnet' } as any;

			it('should support all common image formats', () => {
				expect(modelSupportsImageMimeType(gptModel, 'image/png')).toBe(true);
				expect(modelSupportsImageMimeType(gptModel, 'image/jpeg')).toBe(true);
				expect(modelSupportsImageMimeType(gptModel, 'image/gif')).toBe(true);
				expect(modelSupportsImageMimeType(gptModel, 'image/webp')).toBe(true);
				expect(modelSupportsImageMimeType(gptModel, 'image/bmp')).toBe(true);

				expect(modelSupportsImageMimeType(claudeModel, 'image/png')).toBe(true);
				expect(modelSupportsImageMimeType(claudeModel, 'image/jpeg')).toBe(true);
				expect(modelSupportsImageMimeType(claudeModel, 'image/gif')).toBe(true);
				expect(modelSupportsImageMimeType(claudeModel, 'image/webp')).toBe(true);
			});
		});
	});
});
