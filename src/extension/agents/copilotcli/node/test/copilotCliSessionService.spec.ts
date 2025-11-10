/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NullNativeEnvService } from '../../../../../platform/env/common/nullEnvService';
import { MockFileSystemService } from '../../../../../platform/filesystem/node/test/mockFileSystemService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore, IDisposable } from '../../../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatSessionStatus, EventEmitter } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { ICopilotCLISDK } from '../copilotCli';
import { ICopilotCLISession } from '../copilotcliSession';
import { CopilotCLISessionService } from '../copilotcliSessionService';

// --- Minimal SDK & dependency stubs ---------------------------------------------------------

interface TestSdkSession {
	readonly sessionId: string;
	readonly startTime: Date;
	messages: {}[];
	events: {}[];
	aborted: boolean;
	getChatContextMessages(): Promise<{}[]>;
	getEvents(): {}[];
	abort(): void;
	// Methods used by real wrapper but not all tests exercise them; provide no-op/throwing impls
	setAuthInfo?: (..._args: {}[]) => void;
	getSelectedModel?: () => Promise<string | undefined>;
	setSelectedModel?: (_model: string) => Promise<void>;
	send?: (_opts: {}) => Promise<void>;
	emit?: (..._args: {}[]) => void;
	on?: (..._args: {}[]) => void;
}

class FakeSdkSession implements TestSdkSession {
	public aborted = false;
	public messages: {}[] = [];
	public events: {}[] = [];
	constructor(public readonly sessionId: string, public readonly startTime: Date) { }
	getChatContextMessages(): Promise<{}[]> { return Promise.resolve(this.messages); }
	getEvents(): {}[] { return this.events; }
	abort(): void { this.aborted = true; }
}

class FakeCLISessionManager {
	public sessions = new Map<string, FakeSdkSession>();
	constructor(_opts: {}) { }
	createSession(_options: SessionOptions) {
		const id = `sess_${Math.random().toString(36).slice(2, 10)}`;
		const s = new FakeSdkSession(id, new Date());
		this.sessions.set(id, s);
		return Promise.resolve(s);
	}
	getSession(opts: SessionOptions & { sessionId: string }, _writable: boolean) {
		if (opts && opts.sessionId && this.sessions.has(opts.sessionId)) {
			return Promise.resolve(this.sessions.get(opts.sessionId));
		}
		return Promise.resolve(undefined);
	}
	listSessions() {
		return Promise.resolve(Array.from(this.sessions.values()).map(s => ({ sessionId: s.sessionId, startTime: s.startTime })));
	}
	deleteSession(id: string) { this.sessions.delete(id); return Promise.resolve(); }
	closeSession(_id: string) { return Promise.resolve(); }
}


describe('CopilotCLISessionService', () => {
	const disposables = new DisposableStore();
	let logService: ILogService;
	let instantiationService: IInstantiationService;
	let service: CopilotCLISessionService;
	let manager: FakeCLISessionManager;

	beforeEach(async () => {
		vi.useRealTimers();
		const sdk = {
			getPackage: vi.fn(async () => ({ internal: { CLISessionManager: FakeCLISessionManager } }))
		} as unknown as ICopilotCLISDK;

		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		logService = accessor.get(ILogService);
		instantiationService = {
			createInstance: (_ctor: unknown, _options: any, sdkSession: { sessionId: string }) => {
				const disposables = new DisposableStore();
				const _onDidChangeStatus = disposables.add(new EventEmitter<ChatSessionStatus>());
				const cliSession: (ICopilotCLISession & DisposableStore) = {
					sessionId: sdkSession.sessionId,
					status: undefined,
					onDidChangeStatus: _onDidChangeStatus.event,
					permissionRequested: undefined,
					handleRequest: vi.fn(async () => { }),
					addUserMessage: vi.fn(),
					addUserAssistantMessage: vi.fn(),
					getSelectedModelId: vi.fn(async () => 'gpt-test'),
					getChatHistory: vi.fn(async () => []),
					attachPermissionHandler: vi.fn(() => ({ dispose() { } })),
					get isDisposed() { return disposables.isDisposed; },
					dispose: () => { disposables.dispose(); },
					add: (d: IDisposable) => disposables.add(d)
				} as unknown as ICopilotCLISession & DisposableStore;
				return cliSession;
			}
		} as unknown as IInstantiationService;

		service = disposables.add(new CopilotCLISessionService(logService, sdk, instantiationService, new NullNativeEnvService(), new MockFileSystemService()));
		manager = await service.getSessionManager() as unknown as FakeCLISessionManager;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		disposables.clear();
	});

	// --- Tests ----------------------------------------------------------------------------------

	describe('CopilotCLISessionService.createSession', () => {
		it('get session will return the same session created using createSession', async () => {
			const session = await service.createSession('   ', { model: 'gpt-test', workingDirectory: '/tmp' }, CancellationToken.None);

			const existingSession = await service.getSession(session.sessionId, { readonly: false }, CancellationToken.None);

			expect(existingSession).toBe(session);
		});
		it('get session will return new once previous session is disposed', async () => {
			const session = await service.createSession('   ', { model: 'gpt-test', workingDirectory: '/tmp' }, CancellationToken.None);

			session.dispose();
			await new Promise(resolve => setTimeout(resolve, 0)); // allow dispose async cleanup to run
			const existingSession = await service.getSession(session.sessionId, { readonly: false }, CancellationToken.None);

			expect(existingSession).not.toBe(session);
		});
	});

	describe('CopilotCLISessionService.getSession missing', () => {
		it('returns undefined when underlying manager has no session', async () => {
			const result = await service.getSession('does-not-exist', { readonly: true }, CancellationToken.None);

			expect(result).toBeUndefined();
		});
	});

	describe('CopilotCLISessionService.getAllSessions', () => {
		it('will not list created sessions', async () => {
			await service.createSession('   ', { model: 'gpt-test', workingDirectory: '/tmp' }, CancellationToken.None);

			const s1 = new FakeSdkSession('s1', new Date(0));
			s1.messages.push({ role: 'user', content: 'a'.repeat(100) });
			const tsStr = '2024-01-01T00:00:00.000Z';
			s1.events.push({ type: 'assistant.message', timestamp: tsStr });
			manager.sessions.set(s1.sessionId, s1);

			const result = await service.getAllSessions(CancellationToken.None);

			expect(result.length).toBe(1);
			const item = result[0];
			expect(item.id).toBe('s1');
			expect(item.label.endsWith('...')).toBe(true); // truncated
			expect(item.label.length).toBeLessThanOrEqual(50);
		});
	});

	describe('CopilotCLISessionService.deleteSession', () => {
		it('disposes active wrapper, removes from manager and fires change event', async () => {
			const session = await service.createSession('to delete', {}, CancellationToken.None);
			const id = session!.sessionId;
			let fired = false;
			disposables.add(service.onDidChangeSessions(() => { fired = true; }));
			await service.deleteSession(id);

			expect(manager.sessions.has(id)).toBe(false);
			expect(fired).toBe(true);

			expect(await service.getSession(id, { readonly: false }, CancellationToken.None)).toBeUndefined();
		});
	});

	describe('CopilotCLISessionService.label generation', () => {
		it('uses first user message line when present', async () => {
			const s = new FakeSdkSession('lab1', new Date());
			s.messages.push({ role: 'user', content: 'Line1\nLine2' });
			manager.sessions.set(s.sessionId, s);

			const sessions = await service.getAllSessions(CancellationToken.None);
			const item = sessions.find(i => i.id === 'lab1');
			expect(item?.label).toBe('Line1');
		});
	});

	describe('CopilotCLISessionService.auto disposal timeout', () => {
		it.skip('disposes session after completion timeout and aborts underlying sdk session', async () => {
			vi.useFakeTimers();
			const session = await service.createSession('will timeout', {}, CancellationToken.None);

			vi.advanceTimersByTime(31000);
			await Promise.resolve(); // allow any pending promises to run

			// dispose should have been called by timeout
			expect(session.isDisposed).toBe(true);
		});
	});
});
