/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import {
	ContentBlock,
	isAssistantMessageEntry,
	isSummaryEntry,
	isUserMessageEntry,
	parseSessionEntry,
	SessionEntry,
	vAssistantMessageEntry,
	vChainLinkEntry,
	vIsoTimestamp,
	vQueueOperationEntry,
	vSummaryEntry,
	vUserMessageEntry,
	vUuid,
} from '../claudeSessionSchema';

describe('claudeSessionSchema', () => {
	// ========================================================================
	// Primitive Validators
	// ========================================================================

	describe('vIsoTimestamp', () => {
		const validator = vIsoTimestamp();

		it('should accept valid ISO timestamps', () => {
			const timestamps = [
				'2026-01-31T00:34:50.025Z',
				'2026-01-31T00:34:50Z',
				'2026-01-31T00:34:50.123456Z',
				'2026-01-31T00:34:50+00:00',
				'2026-01-31T00:34:50-05:00',
			];

			for (const ts of timestamps) {
				const result = validator.validate(ts);
				expect(result.error).toBeUndefined();
				expect(result.content).toBe(ts);
			}
		});

		it('should reject invalid timestamps', () => {
			const invalid = [
				'2026-01-31',
				'00:34:50',
				'not a timestamp',
				123456789,
				null,
				undefined,
			];

			for (const val of invalid) {
				const result = validator.validate(val);
				expect(result.error).toBeDefined();
			}
		});
	});

	describe('vUuid', () => {
		const validator = vUuid();

		it('should accept valid UUIDs with lenient validator', () => {
			const uuids = [
				'6762c0b9-ee55-42cc-8998-180da7f37462',
				'8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				'ABCD1234-5678-90AB-CDEF-1234567890AB',
				'any-string-is-ok',
				'a139fcf', // agent ID format
			];

			for (const uuid of uuids) {
				const result = validator.validate(uuid);
				expect(result.error).toBeUndefined();
				expect(result.content).toBe(uuid);
			}
		});

		it('should reject non-strings and empty strings', () => {
			const invalid = [
				'',
				123,
				null,
				undefined,
			];

			for (const val of invalid) {
				const result = validator.validate(val);
				expect(result.error).toBeDefined();
			}
		});
	});

	// ========================================================================
	// Entry Type Validators
	// ========================================================================

	describe('vQueueOperationEntry', () => {
		const validator = vQueueOperationEntry;

		it('should validate queue operation entries', () => {
			const entry = {
				type: 'queue-operation',
				operation: 'dequeue',
				timestamp: '2026-01-31T00:34:50.025Z',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
			};

			const result = validator.validate(entry);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(entry);
		});

		it('should reject invalid queue operations', () => {
			const invalid = {
				type: 'queue-operation',
				operation: 'invalid-op',
				timestamp: '2026-01-31T00:34:50.025Z',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
			};

			const result = validator.validate(invalid);
			expect(result.error).toBeDefined();
		});
	});

	describe('vUserMessageEntry', () => {
		const validator = vUserMessageEntry;

		it('should validate user message with string content', () => {
			const entry = {
				parentUuid: null,
				isSidechain: false,
				userType: 'external',
				cwd: '/Users/test/project',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				version: '2.1.5',
				gitBranch: 'main',
				slug: 'test-session',
				type: 'user',
				message: {
					role: 'user',
					content: 'Hello, Claude!',
				},
				uuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				timestamp: '2026-01-31T00:34:50.049Z',
			};

			const result = validator.validate(entry);
			expect(result.error).toBeUndefined();
			expect(result.content?.uuid).toBe(entry.uuid);
			expect(result.content?.type).toBe('user');
		});

		it('should validate user message with tool result content', () => {
			const entry = {
				parentUuid: 'e8ee0e3d-16e4-4d9a-848d-83f44455177f',
				isSidechain: false,
				userType: 'external',
				cwd: '/Users/test/project',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				version: '2.1.5',
				gitBranch: 'main',
				slug: 'test-session',
				type: 'user',
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							content: 'File contents here',
							is_error: false,
							tool_use_id: 'toolu_01NSgUsqzqDUKrS2oKjXrgEC',
						},
					],
				},
				uuid: 'b8f8ef99-7fc8-4672-aaba-260da4e3cc9f',
				timestamp: '2026-01-31T00:35:43.115Z',
				toolUseResult: 'Success',
				sourceToolAssistantUUID: 'e8ee0e3d-16e4-4d9a-848d-83f44455177f',
			};

			const result = validator.validate(entry);
			expect(result.error).toBeUndefined();
			expect(result.content?.uuid).toBe(entry.uuid);
		});

		it('should reject user message without required fields', () => {
			const invalid = {
				type: 'user',
				// Missing uuid, sessionId, timestamp, message
			};

			const result = validator.validate(invalid);
			expect(result.error).toBeDefined();
		});
	});

	describe('vAssistantMessageEntry', () => {
		const validator = vAssistantMessageEntry;

		it('should validate assistant message with text content', () => {
			const entry = {
				parentUuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				isSidechain: false,
				userType: 'external',
				cwd: '/Users/test/project',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				version: '2.1.5',
				gitBranch: 'main',
				slug: 'test-session',
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'text',
							text: 'Hello! How can I help you?',
						},
					],
					id: 'msg_01QZbFH3Rf2fSjUw9sDRakwH',
					model: 'claude-opus-4-5-20251101',
					type: 'message',
					stop_reason: 'end_turn',
					stop_sequence: null,
					usage: {
						cache_creation: {
							ephemeral_1h_input_tokens: 0,
							ephemeral_5m_input_tokens: 3328,
						},
						cache_creation_input_tokens: 3328,
						cache_read_input_tokens: 19083,
						input_tokens: 8,
						output_tokens: 360,
					},
				},
				uuid: 'cc74a117-72ce-4ea6-8d01-4401e60ddfeb',
				timestamp: '2026-01-31T00:35:43.061Z',
			};

			const result = validator.validate(entry);
			expect(result.error).toBeUndefined();
			expect(result.content?.uuid).toBe(entry.uuid);
			expect(result.content?.type).toBe('assistant');
		});

		it('should validate assistant message with thinking block', () => {
			const entry = {
				parentUuid: 'test-parent-uuid-1234-5678-1234567890ab',
				isSidechain: true,
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'thinking',
							signature: 'EpECCkYICxgC...',
							thinking: 'The user is asking...',
						},
					],
					id: 'msg_01Au8b3kwPEGT4Cj6KHiBJda',
					model: 'claude-haiku-4-5-20251001',
					type: 'message',
					stop_reason: null,
					stop_sequence: null,
					usage: {
						cache_creation: {
							ephemeral_1h_input_tokens: 0,
							ephemeral_5m_input_tokens: 11606,
						},
						cache_creation_input_tokens: 11606,
						cache_read_input_tokens: 0,
						input_tokens: 10,
						output_tokens: 3,
					},
				},
				uuid: 'cc74a117-72ce-4ea6-8d01-4401e60ddabc',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				timestamp: '2026-01-31T00:36:00.000Z',
				agentId: 'a139fcf',
			};

			const result = validator.validate(entry);
			expect(result.error).toBeUndefined();
			expect(result.content?.agentId).toBe('a139fcf');
		});

		it('should validate assistant message with tool use', () => {
			const entry = {
				parentUuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				isSidechain: false,
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_01NSgUsqzqDUKrS2oKjXrgEC',
							name: 'Read',
							input: { file_path: '/path/to/file.ts' },
							caller: { type: 'direct' },
						},
					],
					id: 'msg_01QZbFH3Rf2fSjUw9sDRakwH',
					model: 'claude-opus-4-5-20251101',
					type: 'message',
					stop_reason: 'tool_use',
					stop_sequence: null,
				},
				uuid: 'e8ee0e3d-16e4-4d9a-848d-83f44455177f',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				timestamp: '2026-01-31T00:35:30.000Z',
			};

			const result = validator.validate(entry);
			expect(result.error).toBeUndefined();
		});
	});

	describe('vSummaryEntry', () => {
		const validator = vSummaryEntry;

		it('should validate summary entries', () => {
			const entry = {
				type: 'summary',
				summary: 'Implementing dark mode feature',
				leafUuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
			};

			const result = validator.validate(entry);
			expect(result.error).toBeUndefined();
			expect(result.content).toEqual(entry);
		});

		it('should reject summary without leafUuid', () => {
			const invalid = {
				type: 'summary',
				summary: 'Test summary',
			};

			const result = validator.validate(invalid);
			expect(result.error).toBeDefined();
		});
	});

	describe('vChainLinkEntry', () => {
		const validator = vChainLinkEntry;

		it('should validate chain link entries', () => {
			const entry = {
				uuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				parentUuid: 'abcdefab-1234-5678-9012-123456789abc',
				isSidechain: true,
				isMeta: true,
			};

			const result = validator.validate(entry);
			expect(result.error).toBeUndefined();
			expect(result.content?.uuid).toBe(entry.uuid);
		});

		it('should validate chain link with null parent', () => {
			const entry = {
				uuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				parentUuid: null,
			};

			const result = validator.validate(entry);
			expect(result.error).toBeUndefined();
		});
	});

	// ========================================================================
	// Type Guards
	// ========================================================================

	describe('type guards', () => {
		it('isUserMessageEntry should identify user messages', () => {
			const userMsg = {
				type: 'user' as const,
				uuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				timestamp: '2026-01-31T00:34:50.049Z',
				parentUuid: null,
				message: { role: 'user' as const, content: 'Hello' },
			};

			expect(isUserMessageEntry(userMsg as SessionEntry)).toBe(true);
			expect(isAssistantMessageEntry(userMsg as SessionEntry)).toBe(false);
		});

		it('isAssistantMessageEntry should identify assistant messages', () => {
			const assistantMsg = {
				type: 'assistant' as const,
				uuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				timestamp: '2026-01-31T00:34:50.049Z',
				parentUuid: null,
				message: { role: 'assistant' as const, content: [] as ContentBlock[] },
			};

			expect(isAssistantMessageEntry(assistantMsg as unknown as SessionEntry)).toBe(true);
			expect(isUserMessageEntry(assistantMsg as unknown as SessionEntry)).toBe(false);
		});

		it('isSummaryEntry should identify summary entries', () => {
			const summary = {
				type: 'summary' as const,
				summary: 'Test',
				leafUuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
			};

			expect(isSummaryEntry(summary as SessionEntry)).toBe(true);
		});
	});

	// ========================================================================
	// parseSessionEntry
	// ========================================================================

	describe('parseSessionEntry', () => {
		it('should parse valid queue operation', () => {
			const line = '{"type":"queue-operation","operation":"dequeue","timestamp":"2026-01-31T00:34:50.025Z","sessionId":"6762c0b9-ee55-42cc-8998-180da7f37462"}';
			const result = parseSessionEntry(line, 1);

			expect(result.success).toBe(true);
			if (result.success && 'type' in result.value) {
				expect(result.value.type).toBe('queue-operation');
			}
		});

		it('should parse valid user message', () => {
			const line = JSON.stringify({
				parentUuid: null,
				isSidechain: false,
				type: 'user',
				message: { role: 'user', content: 'Hello' },
				uuid: '8d4dcda5-3984-42c4-9b9e-d57f64a924dc',
				sessionId: '6762c0b9-ee55-42cc-8998-180da7f37462',
				timestamp: '2026-01-31T00:34:50.049Z',
			});
			const result = parseSessionEntry(line, 1);

			expect(result.success).toBe(true);
			if (result.success && 'type' in result.value) {
				expect(result.value.type).toBe('user');
			}
		});

		it('should return error for invalid JSON', () => {
			const line = 'not valid json';
			const result = parseSessionEntry(line, 5);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.lineNumber).toBe(5);
				expect(result.error.message).toContain('JSON parse error');
			}
		});

		it('should return error for unknown entry type', () => {
			const line = '{"type":"unknown-type","foo":"bar"}';
			const result = parseSessionEntry(line, 10);

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.lineNumber).toBe(10);
				expect(result.error.parsedType).toBe('unknown-type');
			}
		});
	});
});
