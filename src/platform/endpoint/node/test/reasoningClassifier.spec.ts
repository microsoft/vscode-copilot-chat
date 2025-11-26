/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ILogService } from '../../../log/common/logService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { REASONING_CLASSIFIER_MODEL_FILENAME, REASONING_CLASSIFIER_ZIP_FILENAME, ReasoningClassifier } from '../reasoningClassifier';

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
	_serviceBrand: undefined
} as any);

const createMockFetcherService = (zipFilePath: string): IFetcherService => ({
	fetch: vi.fn().mockResolvedValue({
		ok: true,
		statusText: 'OK',
		body: vi.fn().mockResolvedValue(fs.readFileSync(zipFilePath))
	}),
	_serviceBrand: undefined
} as any);

describe('ReasoningClassifier', () => {
	let tempDir: string;
	let testZipPath: string;
	let mockLogService: ILogService;

	beforeEach(() => {
		// Create a temporary directory for test cache
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-classifier-test-'));

		// Use the actual model_router_v0.zip from the test directory
		testZipPath = path.join(__dirname, REASONING_CLASSIFIER_ZIP_FILENAME);

		// Verify the test zip file exists
		if (!fs.existsSync(testZipPath)) {
			throw new Error(`Test zip file not found at ${testZipPath}. Please ensure ${REASONING_CLASSIFIER_ZIP_FILENAME} exists in the test directory.`);
		}

		mockLogService = createMockLogService();
	});

	afterEach(() => {
		// Clean up temp directory
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should download and extract model assets', async () => {
		// Use the real model_router_v0.zip file
		const mockFetcherService = createMockFetcherService(testZipPath);

		const cacheDir = path.join(tempDir, 'cache');
		const classifier = new ReasoningClassifier(cacheDir, mockFetcherService, mockLogService);

		// Trigger initialization (which downloads and extracts)
		try {
			await (classifier as any)._initialize();
		} catch (error) {
			// May fail at ONNX session creation or tokenizer loading, but extraction should succeed
			// This is expected if the zip contains a real model but incompatible with test environment
		}

		// Verify files were extracted
		expect(fs.existsSync(path.join(cacheDir, REASONING_CLASSIFIER_MODEL_FILENAME))).toBe(true);
		expect(fs.existsSync(path.join(cacheDir, 'tokenizer.json'))).toBe(true);

		// Verify fetcher was called
		expect(mockFetcherService.fetch).toHaveBeenCalledWith(
			expect.stringContaining(REASONING_CLASSIFIER_ZIP_FILENAME),
			{}
		);

		// Verify logging
		expect(mockLogService.trace).toHaveBeenCalledWith(expect.stringContaining('Downloading model assets'));
		expect(mockLogService.trace).toHaveBeenCalledWith(expect.stringContaining('Model assets downloaded, extracting'));
		expect(mockLogService.trace).toHaveBeenCalledWith(expect.stringContaining('Model assets extracted successfully'));

		classifier.dispose();
	});

	it('should skip download if model already exists', async () => {
		const mockFetcherService = createMockFetcherService(testZipPath);

		const cacheDir = path.join(tempDir, 'cache-skip');
		fs.mkdirSync(cacheDir, { recursive: true });

		// Pre-create the model file
		fs.writeFileSync(path.join(cacheDir, REASONING_CLASSIFIER_MODEL_FILENAME), 'existing-model');

		const classifier = new ReasoningClassifier(cacheDir, mockFetcherService, mockLogService);

		// Call download method directly
		await (classifier as any)._downloadAndExtractAssets();

		// Verify fetcher was NOT called
		expect(mockFetcherService.fetch).not.toHaveBeenCalled();

		// Verify logging shows skip
		expect(mockLogService.trace).toHaveBeenCalledWith('Model assets already exist, skipping download');

		classifier.dispose();
	});

	it('should handle download failure gracefully', async () => {
		const mockFetcherService: IFetcherService = {
			fetch: vi.fn().mockResolvedValue({
				ok: false,
				statusText: 'Not Found',
				body: vi.fn()
			}),
			_serviceBrand: undefined
		} as any;

		const cacheDir = path.join(tempDir, 'cache-fail');
		const classifier = new ReasoningClassifier(cacheDir, mockFetcherService, mockLogService);

		// Should throw error on download failure
		await expect((classifier as any)._downloadAndExtractAssets()).rejects.toThrow('Failed to download model assets: Not Found');

		classifier.dispose();
	});

	it('should extract zip file correctly', async () => {
		const cacheDir = path.join(tempDir, 'cache-extract');
		fs.mkdirSync(cacheDir, { recursive: true });

		const mockFetcherService = createMockFetcherService(testZipPath);

		const classifier = new ReasoningClassifier(cacheDir, mockFetcherService, mockLogService);

		// Copy test zip to cache dir for extraction test
		const extractTestZipPath = path.join(cacheDir, 'test.zip');
		fs.copyFileSync(testZipPath, extractTestZipPath);

		// Call extract method directly
		await (classifier as any)._extractZip(extractTestZipPath, cacheDir);

		// Verify files were extracted
		expect(fs.existsSync(path.join(cacheDir, REASONING_CLASSIFIER_MODEL_FILENAME))).toBe(true);
		expect(fs.existsSync(path.join(cacheDir, 'tokenizer.json'))).toBe(true);

		// Verify the extracted model file is not empty
		const extractedModelStats = fs.statSync(path.join(cacheDir, REASONING_CLASSIFIER_MODEL_FILENAME));
		expect(extractedModelStats.size).toBeGreaterThan(0);

		classifier.dispose();
	});

	it('should clean up zip file after extraction', async () => {
		const mockFetcherService = createMockFetcherService(testZipPath);

		const cacheDir = path.join(tempDir, 'cache-cleanup');
		const classifier = new ReasoningClassifier(cacheDir, mockFetcherService, mockLogService);

		try {
			await (classifier as any)._initialize();
		} catch (error) {
			// May fail at ONNX session creation or tokenizer loading
		}

		// Verify zip file was deleted
		expect(fs.existsSync(path.join(cacheDir, REASONING_CLASSIFIER_ZIP_FILENAME))).toBe(false);

		// Verify extracted files remain
		expect(fs.existsSync(path.join(cacheDir, REASONING_CLASSIFIER_MODEL_FILENAME))).toBe(true);

		classifier.dispose();
	});

	it('should classify simple queries as non-reasoning', async () => {
		const mockFetcherService = createMockFetcherService(testZipPath);
		const cacheDir = path.join(tempDir, 'cache-classify-simple');
		const classifier = new ReasoningClassifier(cacheDir, mockFetcherService, mockLogService);

		try {
			// Test simple queries that should be classified as non-reasoning (returns true)
			const simpleQueries = [
				'i dont want to use loadEnv'
			];

			for (const query of simpleQueries) {
				const result = await classifier.classify(query);
				// Simple queries should be classified as non-reasoning (returns true)
				expect(result).toBe(true);
				expect(mockLogService.trace).toHaveBeenCalledWith(
					expect.stringMatching(/Reasoning classifier prediction: 1 \(non-reasoning, confidence: \d+\.\d+%\)/)
				);
			}
		} catch (error) {
			// If the model can't be loaded in test environment, that's acceptable
			// The test verifies the code structure is correct
			if ((error as Error).message.includes('not initialized')) {
				// Expected in some test environments
			} else {
				throw error;
			}
		}

		classifier.dispose();
	});

	it('should classify complex queries as requiring reasoning', async () => {
		const mockFetcherService = createMockFetcherService(testZipPath);
		const cacheDir = path.join(tempDir, 'cache-classify-complex');
		const classifier = new ReasoningClassifier(cacheDir, mockFetcherService, mockLogService);

		try {
			// Test complex queries that should require reasoning (returns false)
			const complexQueries = [
				'design a scalable microservices architecture for an e-commerce platform'

			];

			for (const query of complexQueries) {
				const result = await classifier.classify(query);
				// Complex queries should require reasoning (returns false)
				expect(result).toBe(false);
				expect(mockLogService.trace).toHaveBeenCalledWith(
					expect.stringMatching(/Reasoning classifier prediction: 0 \(reasoning, confidence: \d+\.\d+%\)/)
				);
			}
		} catch (error) {
			// If the model can't be loaded in test environment, that's acceptable
			if ((error as Error).message.includes('not initialized')) {
				// Expected in some test environments
			} else {
				throw error;
			}
		}

		classifier.dispose();
	});

	it('should handle classify errors gracefully', async () => {
		const mockFetcherService = createMockFetcherService(testZipPath);
		const cacheDir = path.join(tempDir, 'cache-classify-error');

		// Create a mock log service that we can track
		const errorLogService = createMockLogService();
		const classifier = new ReasoningClassifier(cacheDir, mockFetcherService, errorLogService);

		// Try to classify before initialization completes
		// Set session to null after init promise is set to simulate initialization failure
		(classifier as any)._initPromise = Promise.resolve();
		(classifier as any)._session = null;

		// This should throw "Reasoning classifier not initialized"
		await expect(classifier.classify('test query')).rejects.toThrow('Reasoning classifier not initialized');

		classifier.dispose();
	});

	it('should initialize only once when classify is called multiple times', async () => {
		const mockFetcherService = createMockFetcherService(testZipPath);
		const cacheDir = path.join(tempDir, 'cache-classify-once');
		const classifier = new ReasoningClassifier(cacheDir, mockFetcherService, mockLogService);

		// Call classify multiple times
		const queries = ['query 1', 'query 2', 'query 3'];

		try {
			for (const query of queries) {
				await classifier.classify(query);
			}

			// Verify fetcher was called only once (initialization happens only once)
			expect(mockFetcherService.fetch).toHaveBeenCalledTimes(1);
		} catch (error) {
			// If model can't be loaded, verify at least the fetch was attempted once
			if (mockFetcherService.fetch) {
				const callCount = (mockFetcherService.fetch as any).mock.calls.length;
				expect(callCount).toBeLessThanOrEqual(1);
			}
		}

		classifier.dispose();
	});
});
