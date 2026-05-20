/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { PerplexityLMProvider } from '../perplexityProvider';

function createProvider(knownModels?: Record<string, any>) {
	const fetch = vi.fn(async (url: string) => {
		throw new Error(`Unexpected fetch in test: ${url}`);
	});

	const logService = {
		_serviceBrand: undefined,
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		show: vi.fn(),
		createSubLogger: vi.fn(),
		withExtraTarget: vi.fn(),
	};
	logService.createSubLogger.mockReturnValue(logService);
	logService.withExtraTarget.mockReturnValue(logService);

	const storage = {
		getAPIKey: vi.fn().mockResolvedValue(undefined),
		storeAPIKey: vi.fn().mockResolvedValue(undefined),
		deleteAPIKey: vi.fn().mockResolvedValue(undefined),
		getStoredModelConfigs: vi.fn().mockResolvedValue({}),
		saveModelConfig: vi.fn().mockResolvedValue(undefined),
		removeModelConfig: vi.fn().mockResolvedValue(undefined),
	};

	const provider = new PerplexityLMProvider(
		knownModels as any,
		storage as any,
		{ fetch } as any,
		logService as any,
		{ createInstance: vi.fn().mockReturnValue({}) } as any,
		{
			isConfigured: vi.fn().mockReturnValue(false),
			getConfig: vi.fn(),
			setConfig: vi.fn(),
		} as any,
		{} as any
	);

	return { provider, fetch, storage, logService };
}

describe('PerplexityLMProvider', () => {
	it('getAllModels returns the curated Agent API model list', async () => {
		const { provider, fetch } = createProvider();

		const models = await (provider as any).getAllModels(true, 'test-api-key', undefined);

		expect(models.length).toBe(5);

		const expectedIds = [
			'openai/gpt-5.4',
			'openai/gpt-5.2',
			'anthropic/claude-sonnet-4-6',
			'anthropic/claude-opus-4-7',
			'google/gemini-3-1-pro',
		];
		const ids = models.map((m: any) => m.id);
		expect(ids.sort()).toEqual(expectedIds.sort());

		// No sonar references at all in the curated list.
		expect(models.some((m: any) => m.id.includes('sonar'))).toBe(false);
		expect(models.some((m: any) => (m.name ?? '').toLowerCase().includes('sonar'))).toBe(false);

		// Each model points at the Agent API base URL.
		for (const model of models) {
			expect(model.url).toBe('https://api.perplexity.ai/v1');
		}

		// /models endpoint must never be queried — getAllModels is overridden.
		expect(fetch).not.toHaveBeenCalled();
	});

	it('every model includes X-Pplx-Integration header in merged capabilities', async () => {
		const { provider } = createProvider();

		const knownModels = (provider as any)._knownModels as Record<string, { requestHeaders?: Record<string, string> }>;
		expect(knownModels).toBeDefined();
		const ids = Object.keys(knownModels);
		expect(ids.length).toBe(5);

		for (const id of ids) {
			const headers = knownModels[id].requestHeaders;
			expect(headers).toBeDefined();
			expect(headers!['X-Pplx-Integration']).toMatch(/^vscode-copilot\//);
		}
	});

	it('integration header is not overridden by per-model requestHeaders', () => {
		const { provider } = createProvider({
			'openai/gpt-5.4': {
				name: 'GPT-5.4 (custom)',
				toolCalling: true,
				vision: true,
				maxInputTokens: 200000,
				maxOutputTokens: 16000,
				requestHeaders: {
					'X-Pplx-Integration': 'malicious-override',
					'X-Custom-Header': 'kept',
				},
			},
		});

		const knownModels = (provider as any)._knownModels as Record<string, { requestHeaders?: Record<string, string> }>;
		const headers = knownModels['openai/gpt-5.4'].requestHeaders!;

		// The provider's integration header always wins.
		expect(headers['X-Pplx-Integration']).toMatch(/^vscode-copilot\//);
		expect(headers['X-Pplx-Integration']).not.toBe('malicious-override');

		// Other custom headers should be preserved.
		expect(headers['X-Custom-Header']).toBe('kept');
	});
});
