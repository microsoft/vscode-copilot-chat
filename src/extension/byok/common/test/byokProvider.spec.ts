/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { BYOKModelCapabilities, resolveModelInfo } from '../byokProvider';

describe('resolveModelInfo', () => {
	const providerName = 'test-provider';
	const modelId = 'test-model';

	it('should default streaming to true when not specified in modelCapabilities', () => {
		const modelCapabilities: BYOKModelCapabilities = {
			name: 'Test Model',
			maxInputTokens: 4096,
			maxOutputTokens: 2048,
			toolCalling: true,
			vision: false,
		};

		const result = resolveModelInfo(modelId, providerName, undefined, modelCapabilities);

		expect(result.capabilities.supports.streaming).toBe(true);
	});

	it('should respect streaming: false in modelCapabilities', () => {
		const modelCapabilities: BYOKModelCapabilities = {
			name: 'Test Model',
			maxInputTokens: 4096,
			maxOutputTokens: 2048,
			toolCalling: true,
			vision: false,
			streaming: false,
		};

		const result = resolveModelInfo(modelId, providerName, undefined, modelCapabilities);

		expect(result.capabilities.supports.streaming).toBe(false);
	});

	it('should respect streaming: true in modelCapabilities', () => {
		const modelCapabilities: BYOKModelCapabilities = {
			name: 'Test Model',
			maxInputTokens: 4096,
			maxOutputTokens: 2048,
			toolCalling: true,
			vision: false,
			streaming: true,
		};

		const result = resolveModelInfo(modelId, providerName, undefined, modelCapabilities);

		expect(result.capabilities.supports.streaming).toBe(true);
	});

	it('should default streaming to true when not specified in knownModels', () => {
		const knownModels = {
			[modelId]: {
				name: 'Test Model',
				maxInputTokens: 4096,
				maxOutputTokens: 2048,
				toolCalling: true,
				vision: false,
			},
		};

		const result = resolveModelInfo(modelId, providerName, knownModels);

		expect(result.capabilities.supports.streaming).toBe(true);
	});

	it('should respect streaming: false in knownModels', () => {
		const knownModels = {
			[modelId]: {
				name: 'Test Model',
				maxInputTokens: 4096,
				maxOutputTokens: 2048,
				toolCalling: true,
				vision: false,
				streaming: false,
			},
		};

		const result = resolveModelInfo(modelId, providerName, knownModels);

		expect(result.capabilities.supports.streaming).toBe(false);
	});

	it('should respect streaming: true in knownModels', () => {
		const knownModels = {
			[modelId]: {
				name: 'Test Model',
				maxInputTokens: 4096,
				maxOutputTokens: 2048,
				toolCalling: true,
				vision: false,
				streaming: true,
			},
		};

		const result = resolveModelInfo(modelId, providerName, knownModels);

		expect(result.capabilities.supports.streaming).toBe(true);
	});

	it('should prioritize modelCapabilities streaming over knownModels', () => {
		const knownModels = {
			[modelId]: {
				name: 'Test Model',
				maxInputTokens: 4096,
				maxOutputTokens: 2048,
				toolCalling: true,
				vision: false,
				streaming: true,
			},
		};

		const modelCapabilities: BYOKModelCapabilities = {
			name: 'Test Model Override',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			toolCalling: false,
			vision: true,
			streaming: false,
		};

		const result = resolveModelInfo(modelId, providerName, knownModels, modelCapabilities);

		// modelCapabilities should take precedence
		expect(result.capabilities.supports.streaming).toBe(false);
		expect(result.name).toBe('Test Model Override');
	});

	it('should default streaming to true when neither modelCapabilities nor knownModels are provided', () => {
		const result = resolveModelInfo(modelId, providerName, undefined);

		expect(result.capabilities.supports.streaming).toBe(true);
	});

	it('should correctly set all other capabilities when streaming is false', () => {
		const modelCapabilities: BYOKModelCapabilities = {
			name: 'Non-Streaming Model',
			maxInputTokens: 4096,
			maxOutputTokens: 2048,
			toolCalling: true,
			vision: true,
			thinking: true,
			streaming: false,
		};

		const result = resolveModelInfo(modelId, providerName, undefined, modelCapabilities);

		expect(result.capabilities.supports.streaming).toBe(false);
		expect(result.capabilities.supports.tool_calls).toBe(true);
		expect(result.capabilities.supports.vision).toBe(true);
		expect(result.capabilities.supports.thinking).toBe(true);
	});
});
