/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { ICAPIClientService } from '../../../endpoint/common/capiClient';
import { NullTelemetryService } from '../../../telemetry/common/nullTelemetryService';
import { TestLogService } from '../../../testing/common/testLogService';
import { HeadersImpl, WebSocketConnection } from '../../common/fetcherService';
import { ChatWebSocketManager } from '../chatWebSocketManager';

class FakeWebSocket extends EventTarget {
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readonly CLOSING = 2;
	readonly CLOSED = 3;
	readyState = this.CONNECTING;
	readonly sent: string[] = [];

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = this.CLOSED;
	}

	simulateOpen(): void {
		this.readyState = this.OPEN;
		this.dispatchEvent(new Event('open'));
	}

	simulateMessage(data: string): void {
		this.dispatchEvent(Object.assign(new Event('message'), { data }));
	}
}

function createFakeCAPIClientService(ws: FakeWebSocket): ICAPIClientService {
	return {
		createResponsesWebSocket: async () => ({
			webSocket: ws as unknown as WebSocket,
			responseHeaders: new HeadersImpl({}),
			responseStatusCode: 101,
			responseStatusText: 'Switching Protocols',
		} satisfies WebSocketConnection as unknown as WebSocketConnection),
	} as unknown as ICAPIClientService;
}

describe('ChatWebSocketManager', () => {
	let disposables: DisposableStore;
	let ws: FakeWebSocket;
	let manager: ChatWebSocketManager;

	beforeEach(() => {
		disposables = new DisposableStore();
		ws = new FakeWebSocket();
	});

	afterEach(() => {
		disposables.dispose();
	});

	async function getConnection(headers: Record<string, string> = {}) {
		manager = new ChatWebSocketManager(
			new TestLogService(),
			createFakeCAPIClientService(ws),
			new NullTelemetryService(),
		);
		disposables.add(manager);
		const connectPromise = manager.getOrCreateConnection('conv-1', 'turn-1', headers);
		// Defer open event to allow connect() to attach listeners first
		await Promise.resolve();
		ws.simulateOpen();
		return connectPromise;
	}

	const completedEvent = JSON.stringify({ type: 'response.completed', response: { id: 'resp-1' } });

	describe('initiator field on response.create message', () => {
		it('sets initiator to "user" when userInitiated is true', async () => {
			const connection = await getConnection();
			const cts = disposables.add(new CancellationTokenSource());
			const handle = connection.sendRequest(
				{ model: 'test-model', messages: [], stream: true },
				{ userInitiated: true },
				cts.token,
			);

			expect(ws.sent).toHaveLength(1);
			const message = JSON.parse(ws.sent[0]);
			expect(message.initiator).toBe('user');
			expect(message.type).toBe('response.create');

			ws.simulateMessage(completedEvent);
			await handle.done;
		});

		it('sets initiator to "agent" when userInitiated is false', async () => {
			const connection = await getConnection();
			const cts = disposables.add(new CancellationTokenSource());
			const handle = connection.sendRequest(
				{ model: 'test-model', messages: [], stream: true },
				{ userInitiated: false },
				cts.token,
			);

			expect(ws.sent).toHaveLength(1);
			const message = JSON.parse(ws.sent[0]);
			expect(message.initiator).toBe('agent');

			ws.simulateMessage(completedEvent);
			await handle.done;
		});

		it('strips the stream property from the message', async () => {
			const connection = await getConnection();
			const cts = disposables.add(new CancellationTokenSource());
			const handle = connection.sendRequest(
				{ model: 'test-model', messages: [], stream: true },
				{ userInitiated: true },
				cts.token,
			);

			const message = JSON.parse(ws.sent[0]);
			expect(message.stream).toBeUndefined();
			expect(message.model).toBe('test-model');

			ws.simulateMessage(completedEvent);
			await handle.done;
		});
	});
});
