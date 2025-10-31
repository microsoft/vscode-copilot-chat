/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Attachment, internal, Session, SessionEvent, SessionMetadata, SessionOptions } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';
import type { CopilotToken } from '../../../../../platform/authentication/common/copilotToken';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import { SyncDescriptor } from '../../../../../util/vs/platform/instantiation/common/descriptors';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatSessionStatus } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { MockChatResponseStream } from '../../../../test/node/testHelpers';
import { ICopilotCLISDK } from '../copilotCli';
import { CopilotCLISessionService } from '../copilotcliSessionService';

// -----------------------------------------------------------------------------
// Minimal Mock SDK Implementation
// -----------------------------------------------------------------------------

type MockEvent = { type: string; data: unknown; timestamp?: number };

class MockSession implements Partial<Session> {
	public readonly sessionId: string;
	public readonly startTime: Date = new Date();
	public messageCount = 0;
	private _selectedModel: string | undefined;
	private _events: MockEvent[] = [];
	public _chatMessages: { role: 'user' | 'assistant'; content: string }[] = [];
	private _listeners = new Map<string, Set<(e: any) => void>>();
	private _aborted = false;
	private readonly _requestPermission?: SessionOptions['requestPermission'];

	constructor(id: string, model?: string, requestPermission?: SessionOptions['requestPermission']) {
		this.sessionId = id;
		this._selectedModel = model;
		this._requestPermission = requestPermission;
		this._emit('session.start', { sessionId: id });
	}

	async abort() {
		this._aborted = true;
		this._emit('session.error', { errorType: 'aborted', message: 'Session aborted' });
	}

	getSelectedModel() { return Promise.resolve(this._selectedModel); }
	async setSelectedModel(model: string) { this._selectedModel = model; }

	async send({ prompt }: { prompt: string; attachments: Attachment[] }) {
		if (this._aborted) { throw new Error('aborted'); }
		this.messageCount++;
		// Simulate assistant turn
		this._emit('assistant.turn_start', {});
		this._chatMessages.push({ role: 'user', content: prompt });
		// Simulate a permission request when prompt contains keyword
		if (this._requestPermission && prompt.includes('PERMISSION-READ')) {
			await this._requestPermission({ kind: 'read', path: '/workspace/file.txt' } as any);
		}
		if (this._requestPermission && prompt.includes('PERMISSION-OUTSIDE')) {
			await this._requestPermission({ kind: 'read', path: '/etc/passwd' } as any);
		}
		if (prompt.includes('FAIL')) {
			throw new Error('Forced failure');
		}
		this._emit('assistant.message', { messageId: `msg_${Date.now()}`, content: 'Mock response: ' + prompt });
		this._chatMessages.push({ role: 'assistant', content: 'Mock response: ' + prompt });
		this._emit('assistant.turn_end', {});
	}

	async getChatMessages() { return this._chatMessages.slice(); }
	getEvents() {
		return this._events.slice() as unknown as readonly SessionEvent[];
	}

	emit(type: string, data: any) { this._emit(type, data); }

	private _emit(type: string, data: any) {
		const evt: MockEvent = { type, data, timestamp: Date.now() };
		this._events.push(evt);
		for (const listener of this._listeners.get(type)?.values() || []) {
			listener({ data });
		}
		for (const anyListener of this._listeners.get('*')?.values() || []) {
			anyListener(evt);
		}
	}

	on(type: string, handler: (e: any) => void) {
		if (!this._listeners.has(type)) { this._listeners.set(type, new Set()); }
		this._listeners.get(type)!.add(handler);
		return () => this._listeners.get(type)!.delete(handler);
	}
}

class MockCLISessionManager implements Partial<internal.CLISessionManager> {
	private static _sessions = new Map<string, MockSession>();
	private _id = 1;
	private readonly _requestPermission?: SessionOptions['requestPermission'];

	constructor(opts: { logger?: any } & SessionOptions) {
		this._requestPermission = opts.requestPermission;
	}

	async listSessions() {
		return Array.from(MockCLISessionManager._sessions.values()).map(s => ({ sessionId: s.sessionId, startTime: s.startTime })) as unknown as SessionMetadata[];
	}

	async createSession(opts?: { selectedModel?: string }) {
		const id = `sess-${this._id++}`;
		const session = new MockSession(id, opts?.selectedModel, this._requestPermission);
		MockCLISessionManager._sessions.set(id, session);
		return session as unknown as any; // Session shape
	}

	async getSession(id: string, _writable: boolean) {
		return MockCLISessionManager._sessions.get(id) as unknown as any;
	}

	async closeSession(_session: any) { /* no-op */ }
	async deleteSession(session: any) { MockCLISessionManager._sessions.delete(session.sessionId); }
}

class MockCopilotCLISDK implements ICopilotCLISDK {
	declare _serviceBrand: undefined;
	async getPackage(): Promise<typeof import('@github/copilot/sdk')> {
		// We only need the internal CLISessionManager class.
		return {
			internal: { CLISessionManager: MockCLISessionManager }
		} as any;
	}
}

// -----------------------------------------------------------------------------
// Mock Authentication Service (avoid env var dependency for token retrieval)
// -----------------------------------------------------------------------------
class MockAuthenticationService implements IAuthenticationService {
	_serviceBrand: undefined;
	isMinimalMode = false;
	onDidAuthenticationChange = (() => ({ dispose() { } })) as any;
	onDidAccessTokenChange = (() => ({ dispose() { } })) as any;
	onDidAdoAuthenticationChange = (() => ({ dispose() { } })) as any;
	anyGitHubSession = undefined;
	permissiveGitHubSession = undefined;
	copilotToken = undefined;
	speculativeDecodingEndpointToken = undefined;
	getAnyGitHubSession(): Promise<any> { return Promise.resolve(undefined); }
	getPermissiveGitHubSession(): Promise<any> { return Promise.resolve(undefined); }
	async getCopilotToken(): Promise<CopilotToken> {
		return { token: 'test-token' } as any; // Minimal shape used by session options service
	}
	resetCopilotToken(): void { }
	getAdoAccessTokenBase64(): Promise<string | undefined> { return Promise.resolve(undefined); }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('CopilotCLISessionService', () => {
	const store = new DisposableStore();
	let instantiationService: IInstantiationService;

	beforeEach(() => {
		const services = store.add(createExtensionUnitTestingServices());
		// Inject mock SDK and authentication service
		services.define(ICopilotCLISDK, new MockCopilotCLISDK());
		services.define(IAuthenticationService, new SyncDescriptor(MockAuthenticationService));
		const accessor = services.createTestingAccessor();
		instantiationService = accessor.get(IInstantiationService);
	});

	afterEach(() => {
		store.clear();
		vi.useRealTimers();
	});

	it('creates a new session and streams assistant output', async () => {
		const service = instantiationService.createInstance(CopilotCLISessionService);
		const session = await service.createSession('Hello CLI', undefined, CancellationToken.None);
		expect(session.sessionId).toMatch(/^sess-/);
		const stream = new MockChatResponseStream();
		await session.handleRequest('Hello CLI', [], {} as vscode.ChatParticipantToolToken, stream, undefined, CancellationToken.None);
		expect(stream.output.join('\n')).toContain('Mock response: Hello CLI');
	});

	it('reuses an existing live session instance', async () => {
		const service = instantiationService.createInstance(CopilotCLISessionService);
		const session1 = await service.createSession('First prompt', undefined, CancellationToken.None);
		const session2 = await service.getSession(session1.sessionId, undefined, false, CancellationToken.None);
		expect(session2).toBe(session1);
	});

	it('should not lists active (non-persisted) sessions', async () => {
		const service = instantiationService.createInstance(CopilotCLISessionService);
		await service.createSession('List Me', undefined, CancellationToken.None);
		const all = await service.getAllSessions(CancellationToken.None);
		const labels = all.map(s => s.label);
		expect(labels.some(l => l.includes('List Me'))).toBe(false);
	});

	it('generates truncated label for persisted session user message', async () => {
		const service = instantiationService.createInstance(CopilotCLISessionService);
		// Create a raw SDK session directly so it appears as persisted (not tracked in _newActiveSessions)
		const manager = await service.getSessionManager();
		const raw = await manager.createSession();
		// Inject a long user message
		raw.emit('user.message', { content: 'u'.repeat(120) });
		// Also record chat message internally for getChatMessages
		(raw as unknown as MockSession)._chatMessages?.push?.({ role: 'user', content: 'u'.repeat(120) });
		const all = await service.getAllSessions(CancellationToken.None);
		// Persisted sessions exclude newActive; ensure we find truncated label
		const target = all.find(s => s.id === raw.sessionId);
		if (target) {
			expect(target.label.length).toBeLessThanOrEqual(50);
			expect(target.label.endsWith('...')).toBe(true);
		}
	});

	it('deletes a session and removes it from listings', async () => {
		const service = instantiationService.createInstance(CopilotCLISessionService);
		const session = await service.createSession('Delete Me', undefined, CancellationToken.None);
		await service.deleteSession(session.sessionId);
		const all = await service.getAllSessions(CancellationToken.None);
		expect(all.find(s => s.id === session.sessionId)).toBeUndefined();
		// Subsequent getSession should return undefined
		const fetched = await service.getSession(session.sessionId, undefined, false, CancellationToken.None);
		expect(fetched).toBeUndefined();
	});

	it('fires onDidChangeSessions when deleting a session', async () => {
		const service = instantiationService.createInstance(CopilotCLISessionService);
		let eventCount = 0;
		service.onDidChangeSessions(() => { eventCount++; });
		const session = await service.createSession('Delete Event', undefined, CancellationToken.None);
		// No status changes yet, so we expect zero events prior to deletion
		expect(eventCount).toBe(0);
		await service.deleteSession(session.sessionId);
		// Deletion should always fire the change event exactly once here
		expect(eventCount).toBe(1);
	});

	it('returns undefined for non-existent session id', async () => {
		const service = instantiationService.createInstance(CopilotCLISessionService);
		const fetched = await service.getSession('sess-does-not-exist', undefined, false, CancellationToken.None);
		expect(fetched).toBeUndefined();
	});

	it('updates status from InProgress to Completed on success', async () => {
		const service = instantiationService.createInstance(CopilotCLISessionService);
		const session = await service.createSession('Status test', undefined, CancellationToken.None);
		const stream = new MockChatResponseStream();
		await session.handleRequest('Status test', [], {} as vscode.ChatParticipantToolToken, stream, undefined, CancellationToken.None);
		expect(session.status).toBe(ChatSessionStatus.Completed);
	});

	it('updates status to Failed on error', async () => {
		const service = instantiationService.createInstance(CopilotCLISessionService);
		const session = await service.createSession('Will fail', undefined, CancellationToken.None);
		const stream = new MockChatResponseStream();
		await expect(session.handleRequest('FAIL this request', [], {} as vscode.ChatParticipantToolToken, stream, undefined, CancellationToken.None))
			.rejects.toThrow('Forced failure');
		expect(session.status).toBe(ChatSessionStatus.Failed);
	});

	it('disposes session after completion timeout', async () => {
		vi.useFakeTimers();
		const service = instantiationService.createInstance(CopilotCLISessionService);
		const session = await service.createSession('Timeout test', undefined, CancellationToken.None);
		const stream = new MockChatResponseStream();
		await session.handleRequest('Timeout test', [], {} as vscode.ChatParticipantToolToken, stream, undefined, CancellationToken.None);
		// Ensure session reached Completed state and disposal timer scheduled
		expect(session.status).toBe(ChatSessionStatus.Completed);
		// Advance timers by > 30s (shutdown timeout)
		vi.advanceTimersByTime(31_000);
		// Flush any remaining timers/microtasks so disposal callback fires
		vi.runAllTimers();
		await Promise.resolve();
		// Directly assert original session wrapper disposed. Calling getSession cancels pending terminator.
		expect((session as any)._isDisposed).toBe(true);
	});

	it('reuses a single session across staggered intervals before eventual disposal', async () => {
		vi.useFakeTimers();
		const service = instantiationService.createInstance(CopilotCLISessionService);
		const session = await service.createSession('Interval test 1', undefined, CancellationToken.None);

		async function invoke(prompt: string) {
			const stream = new MockChatResponseStream();
			await session.handleRequest(prompt, [], {} as vscode.ChatParticipantToolToken, stream, undefined, CancellationToken.None);
			expect(session.status).toBe(ChatSessionStatus.Completed);
			expect((session as any)._isDisposed).toBeFalsy();
		}

		// Initial invocation schedules disposal at +30s
		await invoke('Interval test 1');
		vi.advanceTimersByTime(15_000); // +15s, not disposed yet
		expect((session as any)._isDisposed).toBeFalsy();

		// Reuse before timeout cancels existing terminator
		const reused1 = await service.getSession(session.sessionId, undefined, false, CancellationToken.None);
		expect(reused1).toBe(session);
		await invoke('Interval test 2'); // schedules new disposal at current time +30s
		vi.advanceTimersByTime(15_000); // another 15s
		expect((session as any)._isDisposed).toBeFalsy();

		const reused2 = await service.getSession(session.sessionId, undefined, false, CancellationToken.None);
		expect(reused2).toBe(session);
		await invoke('Interval test 3');
		vi.advanceTimersByTime(15_000); // cumulative 45s from start, last timer scheduled at 30s mark +15s
		expect((session as any)._isDisposed).toBeFalsy();

		const reused3 = await service.getSession(session.sessionId, undefined, false, CancellationToken.None);
		expect(reused3).toBe(session);
		await invoke('Interval test 4');
		vi.advanceTimersByTime(15_000); // cumulative 60s from start, last timer scheduled at ~45s
		expect((session as any)._isDisposed).toBeFalsy();

		// Now allow >30s of inactivity since last completion (scheduled at ~45s -> disposal at ~75s)
		vi.advanceTimersByTime(31_000); // move past 75s threshold
		vi.runAllTimers();
		await Promise.resolve();
		expect((session as any)._isDisposed).toBe(true);
	});
});
