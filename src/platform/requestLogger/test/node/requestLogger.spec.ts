/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest';
import { CapturingToken } from '../../common/capturingToken';
import { LoggedInfoKind, LoggedRequestKind } from '../../node/requestLogger';
import { TestRequestLogger } from './testRequestLogger';

describe('RequestLogger', () => {
	let logger: TestRequestLogger;

	beforeEach(() => {
		logger = new TestRequestLogger();
	});

	describe('captureInvocation and parent token grouping', () => {
		it('entries outside captureInvocation have no parent token', () => {
			logger.addEntry({
				type: LoggedRequestKind.MarkdownContentRequest,
				debugName: 'outsideEntry',
				startTimeMs: Date.now(),
				icon: undefined,
				markdownContent: 'Some content',
				isConversationRequest: false
			});

			const entries = logger.getRequests();
			expect(entries).toHaveLength(1);
			expect(entries[0].token).toBeUndefined();
		});

		it('entries inside captureInvocation have the parent token', async () => {
			const parentToken = new CapturingToken('Test prompt', 'comment', false);

			await logger.captureInvocation(parentToken, async () => {
				logger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'insideEntry',
					startTimeMs: Date.now(),
					icon: undefined,
					markdownContent: 'Some content',
					isConversationRequest: false
				});
			});

			const entries = logger.getRequests();
			expect(entries).toHaveLength(1);
			expect(entries[0].token).toBe(parentToken);
		});

		it('all entries inside same captureInvocation share the same parent token', async () => {
			const parentToken = new CapturingToken('Test prompt', 'comment', false);

			await logger.captureInvocation(parentToken, async () => {
				logger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'entry1',
					startTimeMs: Date.now(),
					icon: undefined,
					markdownContent: 'Content 1',
					isConversationRequest: false
				});

				logger.logToolCall('tool-1', 'grep_search', { query: 'test' }, { content: [] });

				logger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'entry2',
					startTimeMs: Date.now(),
					icon: undefined,
					markdownContent: 'Content 2',
					isConversationRequest: false
				});

				logger.logToolCall('tool-2', 'read_file', { path: '/test.ts' }, { content: [] });
			});

			const entries = logger.getRequests();
			expect(entries).toHaveLength(4);

			// All entries should have the same parent token
			for (const entry of entries) {
				expect(entry.token).toBe(parentToken);
			}
		});

		it('entries before, inside, and after captureInvocation are grouped correctly', async () => {
			// Entry BEFORE captureInvocation (no parent)
			logger.addEntry({
				type: LoggedRequestKind.MarkdownContentRequest,
				debugName: 'beforeEntry',
				startTimeMs: Date.now(),
				icon: undefined,
				markdownContent: 'Before',
				isConversationRequest: false
			});

			// Entries INSIDE captureInvocation (with parent)
			const parentToken = new CapturingToken('Tool loop', 'comment', false);
			await logger.captureInvocation(parentToken, async () => {
				logger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'insideEntry1',
					startTimeMs: Date.now(),
					icon: undefined,
					markdownContent: 'Inside 1',
					isConversationRequest: false
				});

				logger.logToolCall('tool-1', 'grep_search', { query: 'test' }, { content: [] });
			});

			// Entry AFTER captureInvocation (no parent)
			logger.addEntry({
				type: LoggedRequestKind.MarkdownContentRequest,
				debugName: 'afterEntry',
				startTimeMs: Date.now(),
				icon: undefined,
				markdownContent: 'After',
				isConversationRequest: false
			});

			const entries = logger.getRequests();
			expect(entries).toHaveLength(4);

			// Group entries by parent token
			const withoutToken = entries.filter(e => e.token === undefined);
			const withToken = entries.filter(e => e.token !== undefined);

			expect(withoutToken).toHaveLength(2);
			expect(withToken).toHaveLength(2);

			// Verify the entries without token are the ones outside captureInvocation
			const withoutTokenNames = withoutToken.map(e =>
				e.kind === LoggedInfoKind.Request ? e.entry.debugName : e.name
			);
			expect(withoutTokenNames).toContain('beforeEntry');
			expect(withoutTokenNames).toContain('afterEntry');

			// Verify the entries with token are the ones inside captureInvocation
			const withTokenNames = withToken.map(e =>
				e.kind === LoggedInfoKind.Request ? e.entry.debugName :
					e.kind === LoggedInfoKind.ToolCall ? e.name : e.id
			);
			expect(withTokenNames).toContain('insideEntry1');
			expect(withTokenNames).toContain('grep_search');

			// All entries with token should have the same parent
			for (const entry of withToken) {
				expect(entry.token).toBe(parentToken);
			}
		});

		it('nested captureInvocation uses innermost token', async () => {
			const outerToken = new CapturingToken('Outer', 'comment', false);
			const innerToken = new CapturingToken('Inner', 'comment', false);

			await logger.captureInvocation(outerToken, async () => {
				logger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'outerEntry',
					startTimeMs: Date.now(),
					icon: undefined,
					markdownContent: 'Outer level',
					isConversationRequest: false
				});

				await logger.captureInvocation(innerToken, async () => {
					logger.addEntry({
						type: LoggedRequestKind.MarkdownContentRequest,
						debugName: 'innerEntry',
						startTimeMs: Date.now(),
						icon: undefined,
						markdownContent: 'Inner level',
						isConversationRequest: false
					});
				});
			});

			const entries = logger.getRequests();
			expect(entries).toHaveLength(2);

			const outerEntry = entries.find(e => e.kind === LoggedInfoKind.Request && e.entry.debugName === 'outerEntry');
			const innerEntry = entries.find(e => e.kind === LoggedInfoKind.Request && e.entry.debugName === 'innerEntry');

			expect(outerEntry?.token).toBe(outerToken);
			expect(innerEntry?.token).toBe(innerToken);
		});

		it('tool calls get parent token from captureInvocation context', async () => {
			const parentToken = new CapturingToken('Tool calling loop', 'comment', false);

			await logger.captureInvocation(parentToken, async () => {
				logger.logToolCall('tool-1', 'grep_search', { query: 'test' }, { content: [] });
				logger.logToolCall('tool-2', 'read_file', { path: '/file.ts' }, { content: [] });
				logger.logToolCall('tool-3', 'semantic_search', { query: 'find code' }, { content: [] });
			});

			const entries = logger.getRequests();
			expect(entries).toHaveLength(3);

			// All tool calls should have the same parent token
			const toolCalls = entries.filter(e => e.kind === LoggedInfoKind.ToolCall);
			expect(toolCalls).toHaveLength(3);

			for (const toolCall of toolCalls) {
				expect(toolCall.token).toBe(parentToken);
			}

			// Verify tool call names
			const toolNames = toolCalls.map(e => e.kind === LoggedInfoKind.ToolCall ? e.name : '');
			expect(toolNames).toContain('grep_search');
			expect(toolNames).toContain('read_file');
			expect(toolNames).toContain('semantic_search');
		});

		it('logModelListCall outside captureInvocation creates top-level entry', () => {
			logger.logModelListCall('model-list-1', {} as any, []);

			const entries = logger.getRequests();
			expect(entries).toHaveLength(1);
			expect(entries[0].token).toBeUndefined();
			expect(entries[0].kind).toBe(LoggedInfoKind.Request);

			if (entries[0].kind === LoggedInfoKind.Request) {
				expect(entries[0].entry.debugName).toBe('modelList');
			}
		});

		it('async work scheduled outside captureInvocation loses parent context', async () => {
			// This test demonstrates the core problem: when async work is scheduled
			// outside the captureInvocation callback (e.g., via setTimeout, separate
			// Promise chains, or subagent invocations), the AsyncLocalStorage context
			// is lost and entries appear as top-level orphans.

			const parentToken = new CapturingToken('Parent request', 'comment', false);
			let deferredLogFn: (() => void) | undefined;

			await logger.captureInvocation(parentToken, async () => {
				// This entry is inside captureInvocation - has parent token
				logger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'directEntry',
					startTimeMs: Date.now(),
					icon: undefined,
					markdownContent: 'Direct',
					isConversationRequest: false
				});

				// Simulate scheduling work for later (like a subagent would)
				// This captures the function but doesn't run it yet
				deferredLogFn = () => {
					logger.addEntry({
						type: LoggedRequestKind.MarkdownContentRequest,
						debugName: 'deferredEntry',
						startTimeMs: Date.now(),
						icon: undefined,
						markdownContent: 'Deferred',
						isConversationRequest: false
					});
				};
			});

			// Now run the deferred function OUTSIDE captureInvocation
			// This simulates what happens when a subagent runs after the parent context ends
			deferredLogFn?.();

			const entries = logger.getRequests();
			expect(entries).toHaveLength(2);

			const directEntry = entries.find(e =>
				e.kind === LoggedInfoKind.Request && e.entry.debugName === 'directEntry'
			);
			const deferredEntry = entries.find(e =>
				e.kind === LoggedInfoKind.Request && e.entry.debugName === 'deferredEntry'
			);

			// Direct entry has parent token
			expect(directEntry?.token).toBe(parentToken);

			// PROBLEM: Deferred entry has NO parent token because it ran outside captureInvocation
			// This is the "orphan entry" problem we need to solve
			expect(deferredEntry?.token).toBeUndefined();
		});

		it('demonstrates how explicit token passing could solve the orphan problem', async () => {
			// This test shows the DESIRED behavior: if we could pass the token explicitly,
			// deferred/subagent work could maintain proper grouping

			const parentToken = new CapturingToken('Parent request', 'comment', false);

			// Simulate a "subagent" that receives the parent token explicitly
			const simulateSubagent = async (inheritedToken: CapturingToken) => {
				// The subagent wraps its work in its own captureInvocation
				// but uses a token that references the parent
				const subagentToken = new CapturingToken(
					`Subagent of: ${inheritedToken.label}`,
					'comment',
					false
				);

				await logger.captureInvocation(subagentToken, async () => {
					logger.addEntry({
						type: LoggedRequestKind.MarkdownContentRequest,
						debugName: 'subagentEntry',
						startTimeMs: Date.now(),
						icon: undefined,
						markdownContent: 'From subagent',
						isConversationRequest: false
					});
				});
			};

			await logger.captureInvocation(parentToken, async () => {
				logger.addEntry({
					type: LoggedRequestKind.MarkdownContentRequest,
					debugName: 'parentEntry',
					startTimeMs: Date.now(),
					icon: undefined,
					markdownContent: 'From parent',
					isConversationRequest: false
				});

				// Pass the token to the subagent
				await simulateSubagent(parentToken);
			});

			const entries = logger.getRequests();
			expect(entries).toHaveLength(2);

			// Both entries have tokens (though different ones)
			// The key insight: we need a way to link subagent tokens to parent tokens
			const parentEntry = entries.find(e =>
				e.kind === LoggedInfoKind.Request && e.entry.debugName === 'parentEntry'
			);
			const subagentEntry = entries.find(e =>
				e.kind === LoggedInfoKind.Request && e.entry.debugName === 'subagentEntry'
			);

			expect(parentEntry?.token).toBe(parentToken);
			expect(subagentEntry?.token).toBeDefined();
			expect(subagentEntry?.token?.label).toBe('Subagent of: Parent request');
		});
	});

	describe('clear', () => {
		it('removes all entries', async () => {
			const parentToken = new CapturingToken('Test', 'comment', false);

			logger.addEntry({
				type: LoggedRequestKind.MarkdownContentRequest,
				debugName: 'entry1',
				startTimeMs: Date.now(),
				icon: undefined,
				markdownContent: 'Content',
				isConversationRequest: false
			});

			await logger.captureInvocation(parentToken, async () => {
				logger.logToolCall('tool-1', 'test_tool', {}, { content: [] });
			});

			expect(logger.getRequests()).toHaveLength(2);

			logger.clear();

			expect(logger.getRequests()).toHaveLength(0);
		});
	});
});
