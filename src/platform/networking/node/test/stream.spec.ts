/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { ILogService } from '../../../log/common/logService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { Response } from '../../common/fetcherService';
import { SSEProcessor } from '../stream';

describe('SSEProcessor', () => {
	const mockLogService = {
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		public: {
			debug: vi.fn(),
		}
	} as unknown as ILogService;

	const mockTelemetryService = {
		sendGHTelemetryEvent: vi.fn(),
	} as unknown as ITelemetryService;

	const createMockResponse = (chunks: string[]): Response => {
		const stream = Readable.from(chunks);
		return {
			body: async () => stream,
			headers: {
				get: (key: string) => {
					if (key === 'x-request-id') {
						return 'req-id';
					}
					return undefined;
				}
			}
		} as unknown as Response;
	};

	it('should emit text and thinking separately when they arrive in the same chunk', async () => {
		const chunk = `data: {"choices":[{"index":0,"delta":{"content":"Hello ","reasoning_opaque":"thinking..."}}]}\n\n`;
		const response = createMockResponse([chunk, `data: [DONE]\n\n`]);

		const processor = await SSEProcessor.create(
			mockLogService,
			mockTelemetryService,
			1,
			response
		);

		const callbacks: any[] = [];
		const finishedCb = async (text: string, index: number, delta: any) => {
			callbacks.push({ text, index, delta });
			return undefined;
		};

		for await (const _ of processor.processSSE(finishedCb)) { }

		// We expect 2 callbacks:
		// 1. Text: "Hello "
		// 2. Thinking: "thinking..."
		expect(callbacks.length).toBe(2);

		expect(callbacks[0].delta.text).toBe('Hello ');
		expect(callbacks[0].delta.thinking).toBeUndefined();

		expect(callbacks[1].delta.text).toBe('');
		expect(callbacks[1].delta.thinking).toEqual({ id: 'thinking...', text: undefined });
	});

	it('should emit text and thinking separately when text is accumulated', async () => {
		const chunk1 = `data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n`;
		const chunk2 = `data: {"choices":[{"index":0,"delta":{"content":" World","reasoning_opaque":"thinking..."}}]}\n\n`;
		const response = createMockResponse([chunk1, chunk2, `data: [DONE]\n\n`]);

		const processor = await SSEProcessor.create(
			mockLogService,
			mockTelemetryService,
			1,
			response
		);

		const callbacks: any[] = [];
		const finishedCb = async (text: string, index: number, delta: any) => {
			callbacks.push({ text, index, delta });
			return undefined;
		};

		for await (const _ of processor.processSSE(finishedCb)) { }

		// 1. Text: "Hello"
		// 2. Text: " World"
		// 3. Thinking: "thinking..."
		expect(callbacks.length).toBe(3);

		expect(callbacks[0].delta.text).toBe('Hello');
		expect(callbacks[1].delta.text).toBe(' World');
		expect(callbacks[1].delta.thinking).toBeUndefined();

		expect(callbacks[2].delta.text).toBe('');
		expect(callbacks[2].delta.thinking).toEqual({ id: 'thinking...', text: undefined });
	});
});
