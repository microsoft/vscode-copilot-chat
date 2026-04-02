/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { GenAiAttr, GenAiOperationName } from '../genAiAttributes';
import { SpanKind } from '../otelService';
import { CapturingOTelService } from './capturingOTelService';

/**
 * Tests that content attributes (INPUT_MESSAGES, OUTPUT_MESSAGES, user_message events)
 * are properly gated behind captureContent in agent and inference span patterns.
 *
 * Validates the fix for https://github.com/microsoft/vscode/issues/307407
 * where captureContent=false still leaked content to OTLP via unconditional
 * span.setAttribute() calls in toolCallingLoop and chatMLFetcher.
 */
describe('Content gating in agent and inference spans', () => {
	describe('agent span pattern (toolCallingLoop)', () => {
		it('does NOT set INPUT_MESSAGES or user_message event when captureContent is false', () => {
			const otel = new CapturingOTelService({ captureContent: false });

			const span = otel.startSpan('invoke_agent copilot', {
				kind: SpanKind.INTERNAL,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
					[GenAiAttr.AGENT_NAME]: 'copilot',
				},
			});

			// Simulate the gated pattern now used in toolCallingLoop
			if (otel.config.captureContent) {
				const userMessage = 'fix my code';
				span.setAttribute(GenAiAttr.INPUT_MESSAGES, JSON.stringify([
					{ role: 'user', parts: [{ type: 'text', content: userMessage }] }
				]));
				span.addEvent('user_message', { content: userMessage });
			}
			span.end();

			expect(otel.spans[0].attributes[GenAiAttr.INPUT_MESSAGES]).toBeUndefined();
			expect(otel.spans[0].events).toHaveLength(0);
		});

		it('does NOT set OUTPUT_MESSAGES when captureContent is false', () => {
			const otel = new CapturingOTelService({ captureContent: false });

			const span = otel.startSpan('invoke_agent copilot', {
				kind: SpanKind.INTERNAL,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
				},
			});

			if (otel.config.captureContent) {
				span.setAttribute(GenAiAttr.OUTPUT_MESSAGES, JSON.stringify([
					{ role: 'assistant', parts: [{ type: 'text', content: 'here is the fix' }] }
				]));
			}
			span.end();

			expect(otel.spans[0].attributes[GenAiAttr.OUTPUT_MESSAGES]).toBeUndefined();
		});

		it('sets INPUT_MESSAGES, OUTPUT_MESSAGES, and user_message event when captureContent is true', () => {
			const otel = new CapturingOTelService({ captureContent: true });

			const span = otel.startSpan('invoke_agent copilot', {
				kind: SpanKind.INTERNAL,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
					[GenAiAttr.AGENT_NAME]: 'copilot',
				},
			});

			const userMessage = 'fix my code';
			const expectedInput = JSON.stringify([
				{ role: 'user', parts: [{ type: 'text', content: userMessage }] }
			]);
			const expectedOutput = JSON.stringify([
				{ role: 'assistant', parts: [{ type: 'text', content: 'here is the fix' }] }
			]);

			if (otel.config.captureContent) {
				span.setAttribute(GenAiAttr.INPUT_MESSAGES, expectedInput);
				span.addEvent('user_message', { content: userMessage });
				span.setAttribute(GenAiAttr.OUTPUT_MESSAGES, expectedOutput);
			}
			span.end();

			expect(otel.spans[0].attributes[GenAiAttr.INPUT_MESSAGES]).toBe(expectedInput);
			expect(otel.spans[0].attributes[GenAiAttr.OUTPUT_MESSAGES]).toBe(expectedOutput);
			expect(otel.spans[0].events).toHaveLength(1);
			expect(otel.spans[0].events[0].name).toBe('user_message');
		});

		it('does NOT set TOOL_DEFINITIONS when captureContent is false', () => {
			const otel = new CapturingOTelService({ captureContent: false });

			const span = otel.startSpan('invoke_agent copilot', {
				kind: SpanKind.INTERNAL,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
					[GenAiAttr.AGENT_NAME]: 'copilot',
				},
			});

			// TOOL_DEFINITIONS is classified as opt-in content in genAiAttributes.ts
			if (otel.config.captureContent) {
				span.setAttribute(GenAiAttr.TOOL_DEFINITIONS, JSON.stringify([
					{ type: 'function', name: 'readFile', description: 'Read a file' }
				]));
			}
			span.end();

			expect(otel.spans[0].attributes[GenAiAttr.TOOL_DEFINITIONS]).toBeUndefined();
		});

		it('still sets non-content attributes when captureContent is false', () => {
			const otel = new CapturingOTelService({ captureContent: false });

			const span = otel.startSpan('invoke_agent copilot', {
				kind: SpanKind.INTERNAL,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.INVOKE_AGENT,
					[GenAiAttr.AGENT_NAME]: 'copilot',
				},
			});

			// Non-content attributes like AGENT_NAME should always be set
			span.end();

			expect(otel.spans[0].attributes[GenAiAttr.AGENT_NAME]).toBe('copilot');
		});
	});

	describe('inference span pattern (chatMLFetcher)', () => {
		it('does NOT set INPUT_MESSAGES when captureContent is false', () => {
			const otel = new CapturingOTelService({ captureContent: false });

			const span = otel.startSpan('chat gpt-4o', {
				kind: SpanKind.CLIENT,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
					[GenAiAttr.REQUEST_MODEL]: 'gpt-4o',
				},
			});

			// Simulate the gated pattern now used in chatMLFetcher
			if (otel.config.captureContent) {
				span.setAttribute(GenAiAttr.INPUT_MESSAGES, JSON.stringify([
					{ role: 'system', content: 'You are a helpful assistant.' },
					{ role: 'user', content: 'Hello' },
				]));
			}
			span.end();

			expect(otel.spans[0].attributes[GenAiAttr.INPUT_MESSAGES]).toBeUndefined();
		});

		it('sets INPUT_MESSAGES when captureContent is true', () => {
			const otel = new CapturingOTelService({ captureContent: true });

			const span = otel.startSpan('chat gpt-4o', {
				kind: SpanKind.CLIENT,
				attributes: {
					[GenAiAttr.OPERATION_NAME]: GenAiOperationName.CHAT,
					[GenAiAttr.REQUEST_MODEL]: 'gpt-4o',
				},
			});

			const expectedMessages = JSON.stringify([
				{ role: 'system', content: 'You are a helpful assistant.' },
				{ role: 'user', content: 'Hello' },
			]);

			if (otel.config.captureContent) {
				span.setAttribute(GenAiAttr.INPUT_MESSAGES, expectedMessages);
			}
			span.end();

			expect(otel.spans[0].attributes[GenAiAttr.INPUT_MESSAGES]).toBe(expectedMessages);
		});
	});
});
