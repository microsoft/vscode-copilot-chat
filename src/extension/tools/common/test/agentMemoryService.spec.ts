/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { isRepoMemoryEntry, normalizeCitations, RepoMemoryEntry } from '../agentMemoryService';

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

	describe('deduplicateMemories', () => {
		// Helper function to deduplicate (same logic as in RepoMemoryContextPrompt)
		function deduplicateMemories(memories: RepoMemoryEntry[]): RepoMemoryEntry[] {
			const seen = new Set<string>();
			const deduplicated: RepoMemoryEntry[] = [];

			for (const memory of memories) {
				const key = `${memory.subject.toLowerCase()}|${memory.fact.toLowerCase()}`;
				if (!seen.has(key)) {
					seen.add(key);
					deduplicated.push(memory);
				}
			}

			return deduplicated;
		}

		it('should return empty array for empty input', () => {
			expect(deduplicateMemories([])).toEqual([]);
		});

		it('should return single memory unchanged', () => {
			const memories: RepoMemoryEntry[] = [{
				subject: 'testing',
				fact: 'Use vitest'
			}];
			expect(deduplicateMemories(memories)).toEqual(memories);
		});

		it('should remove duplicate memories by subject+fact', () => {
			const memories: RepoMemoryEntry[] = [
				{ subject: 'testing', fact: 'Use vitest' },
				{ subject: 'testing', fact: 'Use vitest' }
			];
			const result = deduplicateMemories(memories);
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ subject: 'testing', fact: 'Use vitest' });
		});

		it('should be case-insensitive when deduplicating', () => {
			const memories: RepoMemoryEntry[] = [
				{ subject: 'Testing', fact: 'Use Vitest' },
				{ subject: 'testing', fact: 'use vitest' }
			];
			const result = deduplicateMemories(memories);
			expect(result).toHaveLength(1);
		});

		it('should keep first occurrence (CAPI memories added first)', () => {
			const capiMemory: RepoMemoryEntry = {
				subject: 'testing',
				fact: 'Use vitest',
				reason: 'From CAPI',
				category: 'general'
			};
			const localMemory: RepoMemoryEntry = {
				subject: 'testing',
				fact: 'Use vitest',
				reason: 'From local'
			};
			const result = deduplicateMemories([capiMemory, localMemory]);
			expect(result).toHaveLength(1);
			expect(result[0].reason).toBe('From CAPI');
		});

		it('should keep different memories with same subject but different facts', () => {
			const memories: RepoMemoryEntry[] = [
				{ subject: 'testing', fact: 'Use vitest' },
				{ subject: 'testing', fact: 'Use jest' }
			];
			const result = deduplicateMemories(memories);
			expect(result).toHaveLength(2);
		});

		it('should keep different memories with same fact but different subjects', () => {
			const memories: RepoMemoryEntry[] = [
				{ subject: 'testing', fact: 'Use TypeScript' },
				{ subject: 'linting', fact: 'Use TypeScript' }
			];
			const result = deduplicateMemories(memories);
			expect(result).toHaveLength(2);
		});
	});
});
