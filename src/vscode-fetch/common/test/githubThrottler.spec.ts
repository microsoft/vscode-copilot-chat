/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { GitHubThrottlerRegistry, isGitHubUrl } from '../githubThrottler';
import { FetchModuleResponse } from '../types';

function mockResponse(headers: Record<string, string | null> = {}): FetchModuleResponse {
	return {
		status: 200,
		ok: true,
		headers: { get: (name: string) => headers[name] ?? null },
		text: () => Promise.resolve(''),
		json: () => Promise.resolve({}),
	};
}

describe('isGitHubUrl', () => {
	it('should match github.com', () => {
		expect(isGitHubUrl('https://api.github.com/repos/foo/bar')).toBe(true);
	});

	it('should match ghe.com', () => {
		expect(isGitHubUrl('https://my-company.ghe.com/api/v3/repos')).toBe(true);
	});

	it('should match subdomain of github.com', () => {
		expect(isGitHubUrl('https://api.github.com/users')).toBe(true);
	});

	it('should not match unrelated URLs', () => {
		expect(isGitHubUrl('https://example.com/github.com')).toBe(false);
		expect(isGitHubUrl('https://notgithub.com/repos')).toBe(false);
	});

	it('should return false for invalid URLs', () => {
		expect(isGitHubUrl('not-a-url')).toBe(false);
	});
});

describe('GitHubThrottlerRegistry', () => {
	it('should return immediately for unknown endpoints', async () => {
		const registry = new GitHubThrottlerRegistry();
		const slot = await registry.acquireSlot('GET', 'https://api.github.com/repos');
		// Should not block
		slot.release();
	});

	it('should learn bucket from response and track quota', () => {
		const registry = new GitHubThrottlerRegistry();

		registry.recordResponse('GET', 'https://api.github.com/repos', mockResponse({
			'x-github-quota-bucket-name': 'search-api',
			'x-github-total-quota-used': '50',
		}));

		// After recording, the endpoint should have a throttler
		// We test indirectly: acquiring a slot should still resolve
		// since quota 50 < target 80
		const slotPromise = registry.acquireSlot('GET', 'https://api.github.com/repos');
		expect(slotPromise).resolves.toBeDefined();
	});

	it('should clear all state on clear()', () => {
		const registry = new GitHubThrottlerRegistry();

		registry.recordResponse('GET', 'https://api.github.com/repos', mockResponse({
			'x-github-quota-bucket-name': 'test-bucket',
			'x-github-total-quota-used': '50',
		}));

		registry.clear();

		// After clear, endpoint is unknown again → immediate slot
		const slotPromise = registry.acquireSlot('GET', 'https://api.github.com/repos');
		expect(slotPromise).resolves.toBeDefined();
	});

	it('should handle missing quota headers gracefully', () => {
		const registry = new GitHubThrottlerRegistry();

		// No quota headers at all
		registry.recordResponse('GET', 'https://api.github.com/repos', mockResponse({}));

		// Should not throw
		const slotPromise = registry.acquireSlot('GET', 'https://api.github.com/repos');
		expect(slotPromise).resolves.toBeDefined();
	});

	it('should learn bucket even without quota-used header', () => {
		const registry = new GitHubThrottlerRegistry();

		registry.recordResponse('GET', 'https://api.github.com/repos', mockResponse({
			'x-github-quota-bucket-name': 'my-bucket',
		}));

		// Should still have created a throttler for this endpoint
		const slotPromise = registry.acquireSlot('GET', 'https://api.github.com/repos');
		expect(slotPromise).resolves.toBeDefined();
	});

	it('should normalize endpoint keys by pathname', async () => {
		const registry = new GitHubThrottlerRegistry();

		// Record with query string
		registry.recordResponse('GET', 'https://api.github.com/repos?page=1', mockResponse({
			'x-github-quota-bucket-name': 'repos-bucket',
			'x-github-total-quota-used': '10',
		}));

		// Should resolve same throttler for same pathname without query string
		const slot = await registry.acquireSlot('GET', 'https://api.github.com/repos?page=2');
		slot.release();
	});

	it('should use custom target when provided', () => {
		const logger = { warn: vi.fn(), error: vi.fn() };
		const registry = new GitHubThrottlerRegistry(50, logger);

		registry.recordResponse('GET', 'https://api.github.com/repos', mockResponse({
			'x-github-quota-bucket-name': 'test',
			'x-github-total-quota-used': '10',
		}));

		// Logger should have been called for new bucket
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('new bucket'));
	});
});
