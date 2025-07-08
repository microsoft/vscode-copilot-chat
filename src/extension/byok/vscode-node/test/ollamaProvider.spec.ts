/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import { OllamaModelRegistry } from '../ollamaProvider';
import { IFetcherService } from '../../../../platform/networking/common/fetcherService';
import { ILogService } from '../../../../platform/log/common/logService';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';

describe('OllamaModelRegistry', () => {
	let ollamaProvider: OllamaModelRegistry;
	let mockFetcherService: { fetch: MockedFunction<any> };
	let mockLogService: ILogService;
	let mockInstantiationService: IInstantiationService;

	beforeEach(() => {
		mockFetcherService = {
			fetch: vi.fn()
		};
		mockLogService = {} as ILogService;
		mockInstantiationService = {} as IInstantiationService;

		ollamaProvider = new OllamaModelRegistry(
			'http://localhost:11434',
			mockFetcherService as unknown as IFetcherService,
			mockLogService,
			mockInstantiationService
		);
	});

	describe('version checking', () => {
		it('should succeed when Ollama version is supported', async () => {
			// Mock version endpoint
			mockFetcherService.fetch.mockResolvedValueOnce({
				json: () => Promise.resolve({ version: '0.2.1' })
			});

			// Mock models endpoint
			mockFetcherService.fetch.mockResolvedValueOnce({
				json: () => Promise.resolve({ models: [{ model: 'llama2', name: 'Llama 2' }] })
			});

			const result = await ollamaProvider.getAllModels('');
			
			expect(result).toEqual([{ id: 'llama2', name: 'Llama 2' }]);
			expect(mockFetcherService.fetch).toHaveBeenCalledWith('http://localhost:11434/api/version', { method: 'GET' });
		});

		it('should throw error when Ollama version is too old', async () => {
			// Mock version endpoint with old version
			mockFetcherService.fetch.mockResolvedValueOnce({
				json: () => Promise.resolve({ version: '0.1.6' })
			});

			await expect(ollamaProvider.getAllModels('')).rejects.toThrow(
				'Ollama server version 0.1.6 is not supported. Please upgrade to version 0.1.7 or higher.'
			);
		});

		it('should throw error when version endpoint is not available', async () => {
			// Mock version endpoint failure
			mockFetcherService.fetch.mockRejectedValueOnce(new Error('Not found'));

			await expect(ollamaProvider.getAllModels('')).rejects.toThrow(
				'Unable to verify Ollama server version. Please ensure you have Ollama version 0.1.7 or higher installed.'
			);
		});

		it('should handle pre-release versions correctly', async () => {
			// Mock version endpoint with pre-release version
			mockFetcherService.fetch.mockResolvedValueOnce({
				json: () => Promise.resolve({ version: '0.2.0-beta.1' })
			});

			// Mock models endpoint
			mockFetcherService.fetch.mockResolvedValueOnce({
				json: () => Promise.resolve({ models: [] })
			});

			const result = await ollamaProvider.getAllModels('');
			expect(result).toEqual([]);
		});

		it('should fallback to /version endpoint if /api/version fails', async () => {
			// Mock /api/version endpoint failure 
			mockFetcherService.fetch.mockRejectedValueOnce(new Error('Not found'));
			
			// Mock fallback /version endpoint
			mockFetcherService.fetch.mockResolvedValueOnce({
				json: () => Promise.resolve({ version: '0.2.1' })
			});

			// Mock models endpoint
			mockFetcherService.fetch.mockResolvedValueOnce({
				json: () => Promise.resolve({ models: [{ model: 'llama2', name: 'Llama 2' }] })
			});

			const result = await ollamaProvider.getAllModels('');
			
			expect(result).toEqual([{ id: 'llama2', name: 'Llama 2' }]);
			expect(mockFetcherService.fetch).toHaveBeenCalledWith('http://localhost:11434/api/version', { method: 'GET' });
			expect(mockFetcherService.fetch).toHaveBeenCalledWith('http://localhost:11434/version', { method: 'GET' });
		});
	});

	describe('version parsing', () => {
		it('should correctly parse standard semantic versions', () => {
			const provider = ollamaProvider as any;
			
			expect(provider._parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
			expect(provider._parseVersion('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0 });
			expect(provider._parseVersion('10.20.30')).toEqual({ major: 10, minor: 20, patch: 30 });
		});

		it('should handle pre-release versions', () => {
			const provider = ollamaProvider as any;
			
			expect(provider._parseVersion('1.2.3-beta')).toEqual({ major: 1, minor: 2, patch: 3 });
			expect(provider._parseVersion('0.1.0-alpha.1')).toEqual({ major: 0, minor: 1, patch: 0 });
		});

		it('should throw error for invalid version formats', () => {
			const provider = ollamaProvider as any;
			
			expect(() => provider._parseVersion('1.2')).toThrow('Invalid version format');
			expect(() => provider._parseVersion('invalid')).toThrow('Invalid version format');
			expect(() => provider._parseVersion('')).toThrow('Invalid version format');
		});
	});

	describe('version comparison', () => {
		it('should correctly identify supported versions', () => {
			const provider = ollamaProvider as any;
			
			expect(provider._isVersionSupported('0.1.7')).toBe(true);  // Minimum
			expect(provider._isVersionSupported('0.1.8')).toBe(true);  // Patch higher
			expect(provider._isVersionSupported('0.2.0')).toBe(true);  // Minor higher
			expect(provider._isVersionSupported('1.0.0')).toBe(true);  // Major higher
		});

		it('should correctly identify unsupported versions', () => {
			const provider = ollamaProvider as any;
			
			expect(provider._isVersionSupported('0.1.6')).toBe(false); // Patch lower
			expect(provider._isVersionSupported('0.0.1')).toBe(false); // Minor lower
		});

		it('should handle invalid versions gracefully', () => {
			const provider = ollamaProvider as any;
			
			expect(provider._isVersionSupported('invalid')).toBe(false);
			expect(provider._isVersionSupported('')).toBe(false);
		});
	});
});