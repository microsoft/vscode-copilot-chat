/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ILogService } from '../../../log/common/logService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { REASONING_CLASSIFIER_API_URL, ReasoningClassifier } from '../reasoningClassifier';

// Mock services
const createMockLogService = (): ILogService => ({
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	getLevel: vi.fn(),
	flush: vi.fn(),
	dispose: vi.fn(),
	show: vi.fn(),
	_serviceBrand: undefined
} as unknown as ILogService);

interface MockApiResponse {
	text: string;
	predicted_label: 'needs_reasoning' | 'no_reasoning';
	confidence: number;
	scores: {
		needs_reasoning: number;
		no_reasoning: number;
	};
}

const createMockFetcherService = (response: MockApiResponse): IFetcherService => ({
	fetch: vi.fn().mockResolvedValue({
		ok: true,
		statusText: 'OK',
		text: vi.fn().mockResolvedValue(JSON.stringify(response))
	}),
	_serviceBrand: undefined
} as unknown as IFetcherService);

const createFailingFetcherService = (statusText: string): IFetcherService => ({
	fetch: vi.fn().mockResolvedValue({
		ok: false,
		statusText,
		text: vi.fn()
	}),
	_serviceBrand: undefined
} as unknown as IFetcherService);

describe('ReasoningClassifier', () => {
	let mockLogService: ILogService;

	beforeEach(() => {
		mockLogService = createMockLogService();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('should classify query requiring reasoning correctly', async () => {
		const mockResponse: MockApiResponse = {
			text: 'design a scalable microservices architecture',
			predicted_label: 'needs_reasoning',
			confidence: 0.75,
			scores: {
				needs_reasoning: 0.75,
				no_reasoning: 0.25
			}
		};
		const mockFetcherService = createMockFetcherService(mockResponse);

		const classifier = new ReasoningClassifier(mockFetcherService, mockLogService);
		const result = await classifier.classify('design a scalable microservices architecture');

		// needs_reasoning should return false (reasoning IS required)
		expect(result).toBe(false);
		expect(mockFetcherService.fetch).toHaveBeenCalledWith(
			REASONING_CLASSIFIER_API_URL,
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: 'design a scalable microservices architecture' })
			})
		);
		expect(mockLogService.trace).toHaveBeenCalledWith(
			expect.stringContaining('needs_reasoning')
		);
	});

	it('should classify simple query as non-reasoning', async () => {
		const mockResponse: MockApiResponse = {
			text: 'what is the syntax for a for loop',
			predicted_label: 'no_reasoning',
			confidence: 0.85,
			scores: {
				needs_reasoning: 0.15,
				no_reasoning: 0.85
			}
		};
		const mockFetcherService = createMockFetcherService(mockResponse);

		const classifier = new ReasoningClassifier(mockFetcherService, mockLogService);
		const result = await classifier.classify('what is the syntax for a for loop');

		// no_reasoning should return true (reasoning is NOT required)
		expect(result).toBe(true);
		expect(mockLogService.trace).toHaveBeenCalledWith(
			expect.stringContaining('no_reasoning')
		);
	});

	it('should handle API failure gracefully', async () => {
		const mockFetcherService = createFailingFetcherService('Service Unavailable');

		const classifier = new ReasoningClassifier(mockFetcherService, mockLogService);

		await expect(classifier.classify('test query')).rejects.toThrow('Reasoning classifier API request failed: Service Unavailable');
		expect(mockLogService.error).toHaveBeenCalledWith(
			'Reasoning classification failed',
			expect.any(Error)
		);
	});

	it('should send correct request format to API', async () => {
		const mockResponse: MockApiResponse = {
			text: 'Help me write a python function',
			predicted_label: 'needs_reasoning',
			confidence: 0.52,
			scores: {
				needs_reasoning: 0.52,
				no_reasoning: 0.48
			}
		};
		const mockFetcherService = createMockFetcherService(mockResponse);

		const classifier = new ReasoningClassifier(mockFetcherService, mockLogService);
		await classifier.classify('Help me write a python function');

		expect(mockFetcherService.fetch).toHaveBeenCalledTimes(1);
		expect(mockFetcherService.fetch).toHaveBeenCalledWith(
			expect.any(String),
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{"text":"Help me write a python function"}'
			}
		);
	});

	it('should log classification results with confidence scores', async () => {
		const mockResponse: MockApiResponse = {
			text: 'test query',
			predicted_label: 'no_reasoning',
			confidence: 0.65,
			scores: {
				needs_reasoning: 0.35,
				no_reasoning: 0.65
			}
		};
		const mockFetcherService = createMockFetcherService(mockResponse);

		const classifier = new ReasoningClassifier(mockFetcherService, mockLogService);
		await classifier.classify('test query');

		expect(mockLogService.trace).toHaveBeenCalledWith(
			expect.stringMatching(/no_reasoning.*confidence.*65\.0%.*needs_reasoning.*35\.0%.*no_reasoning.*65\.0%/)
		);
	});

	it('should handle multiple consecutive classifications', async () => {
		const mockResponse: MockApiResponse = {
			text: 'query',
			predicted_label: 'no_reasoning',
			confidence: 0.7,
			scores: {
				needs_reasoning: 0.3,
				no_reasoning: 0.7
			}
		};
		const mockFetcherService = createMockFetcherService(mockResponse);

		const classifier = new ReasoningClassifier(mockFetcherService, mockLogService);

		// Make multiple classifications
		await classifier.classify('query 1');
		await classifier.classify('query 2');
		await classifier.classify('query 3');

		// Each classification should make a separate API call
		expect(mockFetcherService.fetch).toHaveBeenCalledTimes(3);
	});
});
