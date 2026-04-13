/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isRepoMemoryEntry, normalizeCitations, type MemoryPromptResponse, type UserMemoryEntry } from '../agentMemoryService';

describe('AgentMemoryService', () => {
	describe('isRepoMemoryEntry', () => {
		it('should return true for valid entry with required fields only', () => {
			const entry: unknown = {
				subject: 'testing',
				fact: 'Use vitest for unit tests'
			};
			expect(isRepoMemoryEntry(entry)).toBe(true);
		});

		it('should return true for valid entry with all fields', () => {
			const entry: unknown = {
				subject: 'testing',
				fact: 'Use vitest for unit tests',
				citations: ['src/test.ts:10'],
				reason: 'Important for consistency',
				category: 'general'
			};
			expect(isRepoMemoryEntry(entry)).toBe(true);
		});

		it('should return true for entry with legacy string citations', () => {
			const entry: unknown = {
				subject: 'testing',
				fact: 'Use vitest for unit tests',
				citations: 'src/test.ts:10, src/other.ts:20'
			};
			expect(isRepoMemoryEntry(entry)).toBe(true);
		});

		it('should return false for null', () => {
			expect(isRepoMemoryEntry(null)).toBe(false);
		});

		it('should return false for undefined', () => {
			expect(isRepoMemoryEntry(undefined)).toBe(false);
		});

		it('should return false for non-object', () => {
			expect(isRepoMemoryEntry('string')).toBe(false);
			expect(isRepoMemoryEntry(123)).toBe(false);
		});

		it('should return false for missing subject', () => {
			const entry: unknown = {
				fact: 'Use vitest for unit tests'
			};
			expect(isRepoMemoryEntry(entry)).toBe(false);
		});

		it('should return false for missing fact', () => {
			const entry: unknown = {
				subject: 'testing'
			};
			expect(isRepoMemoryEntry(entry)).toBe(false);
		});

		it('should return false for non-string subject', () => {
			const entry: unknown = {
				subject: 123,
				fact: 'Use vitest for unit tests'
			};
			expect(isRepoMemoryEntry(entry)).toBe(false);
		});

		it('should return false for invalid citations type', () => {
			const entry: unknown = {
				subject: 'testing',
				fact: 'Use vitest for unit tests',
				citations: 123
			};
			expect(isRepoMemoryEntry(entry)).toBe(false);
		});

		it('should return false for citations array with non-string elements', () => {
			const entry: unknown = {
				subject: 'testing',
				fact: 'Use vitest for unit tests',
				citations: [123, 'src/test.ts:10']
			};
			expect(isRepoMemoryEntry(entry)).toBe(false);
		});
	});

	describe('normalizeCitations', () => {
		it('should return undefined for undefined input', () => {
			expect(normalizeCitations(undefined)).toBeUndefined();
		});

		it('should split comma-separated string into array', () => {
			const result = normalizeCitations('src/a.ts:10, src/b.ts:20');
			expect(result).toEqual(['src/a.ts:10', 'src/b.ts:20']);
		});

		it('should trim whitespace from citations', () => {
			const result = normalizeCitations('  src/a.ts:10  ,  src/b.ts:20  ');
			expect(result).toEqual(['src/a.ts:10', 'src/b.ts:20']);
		});

		it('should filter out empty citations', () => {
			const result = normalizeCitations('src/a.ts:10, , src/b.ts:20');
			expect(result).toEqual(['src/a.ts:10', 'src/b.ts:20']);
		});

		it('should return array input unchanged', () => {
			const input = ['src/a.ts:10', 'src/b.ts:20'];
			const result = normalizeCitations(input);
			expect(result).toEqual(input);
		});

		it('should handle single citation string', () => {
			const result = normalizeCitations('src/a.ts:10');
			expect(result).toEqual(['src/a.ts:10']);
		});

		it('should handle empty string', () => {
			const result = normalizeCitations('');
			expect(result).toEqual([]);
		});
	});

	describe('UserMemoryEntry', () => {
		it('should accept entry with required fields only', () => {
			const entry: UserMemoryEntry = {
				subject: 'preferences',
				fact: 'Prefer tabs over spaces',
			};
			expect(entry.subject).toBe('preferences');
			expect(entry.fact).toBe('Prefer tabs over spaces');
			expect(entry.citations).toBeUndefined();
			expect(entry.reason).toBeUndefined();
		});

		it('should accept entry with all optional fields', () => {
			const entry: UserMemoryEntry = {
				subject: 'preferences',
				fact: 'Prefer tabs over spaces',
				citations: ['src/editorconfig:1'],
				reason: 'User stated this during onboarding',
			};
			expect(entry.citations).toEqual(['src/editorconfig:1']);
			expect(entry.reason).toBe('User stated this during onboarding');
		});

		it('should accept string citations for backward compatibility', () => {
			const entry: UserMemoryEntry = {
				subject: 'preferences',
				fact: 'Prefer tabs over spaces',
				citations: 'src/editorconfig:1, src/other.ts:5',
			};
			expect(typeof entry.citations).toBe('string');
		});

		it('should not include category field (user memories have no category)', () => {
			const entry: UserMemoryEntry = {
				subject: 'preferences',
				fact: 'Prefer tabs over spaces',
			};
			expect('category' in entry).toBe(false);
		});
	});

	describe('MemoryPromptResponse', () => {
		it('should hold a prompt string', () => {
			const response: MemoryPromptResponse = {
				prompt: 'The following are repository memories for owner/repo...',
			};
			expect(response.prompt).toBe('The following are repository memories for owner/repo...');
		});

		it('should accept an empty prompt string', () => {
			const response: MemoryPromptResponse = { prompt: '' };
			expect(response.prompt).toBe('');
		});
	});
});
