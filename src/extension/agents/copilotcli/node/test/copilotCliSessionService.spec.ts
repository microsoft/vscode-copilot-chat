/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SessionOptions, SweCustomAgent } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatContext } from 'vscode';
import { CancellationToken } from 'vscode-languageserver-protocol';
import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';
import { IConfigurationService } from '../../../../../platform/configuration/common/configurationService';
import { NullNativeEnvService } from '../../../../../platform/env/common/nullEnvService';
import { IVSCodeExtensionContext } from '../../../../../platform/extContext/common/extensionContext';
import { MockFileSystemService } from '../../../../../platform/filesystem/node/test/mockFileSystemService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { NullMcpService } from '../../../../../platform/mcp/common/mcpService';
import { NullRequestLogger } from '../../../../../platform/requestLogger/node/nullRequestLogger';
import { MockExtensionContext } from '../../../../../platform/test/node/extensionContext';
import { NullWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../../util/common/test/simpleMock';
import { Event } from '../../../../../util/vs/base/common/event';
import { DisposableStore, IReference, toDisposable } from '../../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { FakeToolsService } from '../../common/copilotCLITools';
import { IChatDelegationSummaryService } from '../../common/delegationSummaryService';
import { COPILOT_CLI_DEFAULT_AGENT_ID, ICopilotCLIAgents, ICopilotCLISDK } from '../copilotCli';
import { ICopilotCLIImageSupport } from '../copilotCLIImageSupport';
import { CopilotCLISession, ICopilotCLISession } from '../copilotcliSession';
import { CopilotCLISessionService, CopilotCLISessionWorkspaceTracker } from '../copilotcliSessionService';
import { CustomSessionTitleService } from '../customSessionTitleServiceImpl';
import { CopilotCLIMCPHandler } from '../mcpHandler';

// --- Minimal SDK & dependency stubs ---------------------------------------------------------

export class MockCliSdkSession {
	public emittedEvents: { event: string; content: string | undefined }[] = [];
	public aborted = false;
	public messages: {}[] = [];
	public events: {}[] = [];
	public summary?: string;
	constructor(public readonly sessionId: string, public readonly startTime: Date) { }
	getChatContextMessages(): Promise<{}[]> { return Promise.resolve(this.messages); }
	getEvents(): {}[] { return this.events; }
	abort(): void { this.aborted = true; }
	emit(event: string, args: { content: string | undefined }): void {
		this.emittedEvents.push({ event, content: args.content });
	}
	clearCustomAgent() {
		return;
	}
}

export class MockCliSdkSessionManager {
	public sessions = new Map<string, MockCliSdkSession>();
	constructor(_opts: {}) { }
	createSession(_options: SessionOptions) {
		const id = `sess_${Math.random().toString(36).slice(2, 10)}`;
		const s = new MockCliSdkSession(id, new Date());
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
		return Promise.resolve(Array.from(this.sessions.values()).map(s => ({ sessionId: s.sessionId, startTime: s.startTime, modifiedTime: s.startTime, summary: s.summary })));
	}
	deleteSession(id: string) { this.sessions.delete(id); return Promise.resolve(); }
	closeSession(_id: string) { return Promise.resolve(); }
}

export class NullCopilotCLIAgents implements ICopilotCLIAgents {
	_serviceBrand: undefined;
	readonly onDidChangeAgents: Event<void> = Event.None;
	async getAgents(): Promise<SweCustomAgent[]> {
		return [];
	}
	async getDefaultAgent(): Promise<string> {
		return COPILOT_CLI_DEFAULT_AGENT_ID;
	}
	async getSessionAgent(_sessionId: string): Promise<string | undefined> {
		return undefined;
	}
	resolveAgent(_agentId: string): Promise<SweCustomAgent | undefined> {
		return Promise.resolve(undefined);
	}
	setDefaultAgent(_agent: string | undefined): Promise<void> {
		return Promise.resolve();
	}
	trackSessionAgent(_sessionId: string, agent: string | undefined): Promise<void> {
		return Promise.resolve();
	}
}

export class NullICopilotCLIImageSupport implements ICopilotCLIImageSupport {
	_serviceBrand: undefined;
	storeImage(_imageData: Uint8Array, _mimeType: string): Promise<URI> {
		return Promise.resolve(URI.file('/dev/null'));
	}
	isTrustedImage(_imageUri: URI): boolean {
		return false;
	}
}

describe('CopilotCLISessionService', () => {
	const disposables = new DisposableStore();
	let logService: ILogService;
	let instantiationService: IInstantiationService;
	let service: CopilotCLISessionService;
	let manager: MockCliSdkSessionManager;
	beforeEach(async () => {
		vi.useRealTimers();
		const sdk = {
			getPackage: vi.fn(async () => ({ internal: { LocalSessionManager: MockCliSdkSessionManager, NoopTelemetryService: class { } } }))
		} as unknown as ICopilotCLISDK;

		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		logService = accessor.get(ILogService);
		const workspaceService = new NullWorkspaceService();
		const cliAgents = new NullCopilotCLIAgents();
		const authService = {
			getCopilotToken: vi.fn(async () => ({ token: 'test-token' })),
		} as unknown as IAuthenticationService;
		const delegationService = new class extends mock<IChatDelegationSummaryService>() {
			override async summarize(context: ChatContext, token: CancellationToken): Promise<string | undefined> {
				return undefined;
			}
		}();
		instantiationService = {
			invokeFunction(fn: (accessor: unknown, ...args: any[]) => any, ...args: any[]): any {
				return fn(accessor, ...args);
			},
			createInstance: (ctor: unknown, options: any, sdkSession: any) => {
				if (ctor === CopilotCLISessionWorkspaceTracker) {
					return new class extends mock<CopilotCLISessionWorkspaceTracker>() {
						override async initialize(): Promise<void> { return; }
						override async trackSession(_sessionId: string, _operation: 'add' | 'delete'): Promise<void> {
							return;
						}
						override shouldShowSession(_sessionId: string): { isOldGlobalSession?: boolean; isWorkspaceSession?: boolean } {
							return { isOldGlobalSession: false, isWorkspaceSession: true };
						}
					}();
				}
				return disposables.add(new CopilotCLISession(options, sdkSession, logService, workspaceService, sdk, instantiationService, delegationService, new NullRequestLogger(), new NullICopilotCLIImageSupport(), new FakeToolsService()));
			}
		} as unknown as IInstantiationService;
		const configurationService = accessor.get(IConfigurationService);
		const nullMcpServer = disposables.add(new NullMcpService());
		const titleServce = new CustomSessionTitleService(new MockExtensionContext() as unknown as IVSCodeExtensionContext);
		service = disposables.add(new CopilotCLISessionService(logService, sdk, instantiationService, new NullNativeEnvService(), new MockFileSystemService(), new CopilotCLIMCPHandler(logService, authService, configurationService, nullMcpServer), cliAgents, workspaceService, titleServce));
		manager = await service.getSessionManager() as unknown as MockCliSdkSessionManager;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		disposables.clear();
	});

	// --- Tests ----------------------------------------------------------------------------------

	describe('CopilotCLISessionService.createSession', () => {
		it('get session will return the same session created using createSession', async () => {
			const session = await service.createSession({ model: 'gpt-test', workingDirectory: URI.file('/tmp') }, CancellationToken.None);

			const existingSession = await service.getSession(session.object.sessionId, { readonly: false }, CancellationToken.None);

			expect(existingSession).toBe(session);
		});
		it('get session will return new once previous session is disposed', async () => {
			const session = await service.createSession({ model: 'gpt-test', workingDirectory: URI.file('/tmp') }, CancellationToken.None);

			session.dispose();
			await new Promise(resolve => setTimeout(resolve, 0)); // allow dispose async cleanup to run
			const existingSession = await service.getSession(session.object.sessionId, { readonly: false }, CancellationToken.None);

			expect(existingSession?.object).toBeDefined();
			expect(existingSession?.object).not.toBe(session);
			expect(existingSession?.object.sessionId).toBe(session.object.sessionId);
		});

		it('passes clientName: vscode to session manager', async () => {
			const createSessionSpy = vi.spyOn(manager, 'createSession');
			await service.createSession({ model: 'gpt-test', workingDirectory: URI.file('/tmp') }, CancellationToken.None);

			expect(createSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
				clientName: 'vscode'
			}));
		});
	});

	describe('CopilotCLISessionService.getSession concurrency & locking', () => {
		it('concurrent getSession calls for same id create only one wrapper', async () => {
			const targetId = 'concurrent';
			const sdkSession = new MockCliSdkSession(targetId, new Date());
			manager.sessions.set(targetId, sdkSession);
			const originalGetSession = manager.getSession.bind(manager);
			const getSessionSpy = vi.fn((opts: SessionOptions & { sessionId: string }, writable: boolean) => {
				// Introduce delay to force overlapping acquire attempts
				return new Promise(resolve => setTimeout(() => resolve(originalGetSession(opts, writable)), 20));
			});
			manager.getSession = getSessionSpy as unknown as typeof manager.getSession;

			const promises: Promise<IReference<ICopilotCLISession> | undefined>[] = [];
			for (let i = 0; i < 10; i++) {
				promises.push(service.getSession(targetId, { readonly: false }, CancellationToken.None));
			}
			const results = await Promise.all(promises);
			// All results refer to same instance
			const first = results.shift()!;
			for (const r of results) {
				expect(r).toBe(first);
			}
			expect(getSessionSpy).toHaveBeenCalledTimes(1);

			// Verify ref-count like disposal only disposes when all callers release
			let sentinelDisposed = false;
			(first.object as CopilotCLISession).add(toDisposable(() => { sentinelDisposed = true; }));

			results.forEach(r => r?.dispose());
			expect(sentinelDisposed).toBe(false);

			// Only after disposing the last reference is the session disposed.
			first.dispose();
			expect(sentinelDisposed).toBe(true);
		});

		it('getSession for different ids does not block on mutex for another id', async () => {
			const slowId = 'slow';
			const fastId = 'fast';
			manager.sessions.set(slowId, new MockCliSdkSession(slowId, new Date()));
			manager.sessions.set(fastId, new MockCliSdkSession(fastId, new Date()));

			const originalGetSession = manager.getSession.bind(manager);
			manager.getSession = vi.fn((opts: SessionOptions & { sessionId: string }, writable: boolean) => {
				if (opts.sessionId === slowId) {
					return new Promise(resolve => setTimeout(() => resolve(originalGetSession(opts, writable)), 40));
				}
				return originalGetSession(opts, writable);
			}) as unknown as typeof manager.getSession;

			const slowPromise = service.getSession(slowId, { readonly: false }, CancellationToken.None).then(() => 'slow');
			const fastPromise = service.getSession(fastId, { readonly: false }, CancellationToken.None).then(() => 'fast');
			const firstResolved = await Promise.race([slowPromise, fastPromise]);
			expect(firstResolved).toBe('fast');
		});

		it('session only fully disposes after all acquired references dispose', async () => {
			const id = 'refcount';
			manager.sessions.set(id, new MockCliSdkSession(id, new Date()));
			// Acquire 5 times sequentially
			const sessions: IReference<ICopilotCLISession>[] = [];
			for (let i = 0; i < 5; i++) {
				sessions.push((await service.getSession(id, { readonly: false }, CancellationToken.None))!);
			}
			const base = sessions[0];
			for (const s of sessions) {
				expect(s).toBe(base);
			}
			let sentinelDisposed = false;
			const lastSession = sessions.pop()!;
			(lastSession.object as CopilotCLISession).add(toDisposable(() => { sentinelDisposed = true; }));
			// Dispose all other session refs, session should not yet be disposed
			sessions.forEach(s => s.dispose());
			expect(sentinelDisposed).toBe(false);
			// Final dispose triggers actual disposal
			lastSession.dispose();
			expect(sentinelDisposed).toBe(true);
		});
	});

	describe('CopilotCLISessionService.getSession missing', () => {
		it('returns undefined when underlying manager has no session', async () => {
			const session = await service.getSession('does-not-exist', { readonly: true }, CancellationToken.None);
			disposables.add(session!);
			expect(session).toBeUndefined();
		});
	});

	describe('CopilotCLISessionService.getAllSessions', () => {
		it('will not list created sessions', async () => {
			const session = await service.createSession({ model: 'gpt-test', workingDirectory: URI.file('/tmp') }, CancellationToken.None);
			disposables.add(session);

			const s1 = new MockCliSdkSession('s1', new Date(0));
			s1.messages.push({ role: 'user', content: 'a'.repeat(100) });
			s1.events.push({ type: 'user.message', data: { content: 'a'.repeat(100) }, timestamp: '2024-01-01T00:00:00.000Z' });
			manager.sessions.set(s1.sessionId, s1);

			const result = await service.getAllSessions(() => true, CancellationToken.None);

			expect(result.length).toBe(1);
			const item = result[0];
			expect(item.id).toBe('s1');
		});
	});

	describe('CopilotCLISessionService.deleteSession', () => {
		it('disposes active wrapper, removes from manager and fires change event', async () => {
			const session = await service.createSession({}, CancellationToken.None);
			const id = session!.object.sessionId;
			let fired = false;
			disposables.add(session);
			disposables.add(service.onDidChangeSessions(() => { fired = true; }));
			await service.deleteSession(id);

			expect(manager.sessions.has(id)).toBe(false);
			expect(fired).toBe(true);

			expect(await service.getSession(id, { readonly: false }, CancellationToken.None)).toBeUndefined();
		});
	});

	describe('CopilotCLISessionService.label generation', () => {
		it('uses first user message line when present', async () => {
			const s = new MockCliSdkSession('lab1', new Date());
			s.messages.push({ role: 'user', content: 'Line1\nLine2' });
			s.events.push({ type: 'user.message', data: { content: 'Line1\nLine2' }, timestamp: Date.now().toString() });
			manager.sessions.set(s.sessionId, s);

			const sessions = await service.getAllSessions(() => true, CancellationToken.None);
			const item = sessions.find(i => i.id === 'lab1');
			expect(item?.label).includes('Line1');
			expect(item?.label).includes('Line2');
		});

		it('uses clean summary from metadata without loading the full session', async () => {
			const s = new MockCliSdkSession('summary1', new Date());
			s.summary = 'Fix the login bug';
			s.events.push({ type: 'user.message', data: { content: 'Fix the login bug in auth.ts' }, timestamp: Date.now().toString() });
			manager.sessions.set(s.sessionId, s);

			const getSessionSpy = vi.spyOn(manager, 'getSession');
			const sessions = await service.getAllSessions(() => true, CancellationToken.None);

			const item = sessions.find(i => i.id === 'summary1');
			expect(item?.label).toBe('Fix the login bug');
			// Should not have loaded the full session since summary was clean
			expect(getSessionSpy).not.toHaveBeenCalled();
		});

		it('falls through to session load when summary contains angle bracket', async () => {
			const s = new MockCliSdkSession('truncated1', new Date());
			s.summary = 'Fix the bug... <current_dateti...';
			s.events.push({ type: 'user.message', data: { content: 'Fix the bug in the parser' }, timestamp: Date.now().toString() });
			manager.sessions.set(s.sessionId, s);

			const getSessionSpy = vi.spyOn(manager, 'getSession');
			const sessions = await service.getAllSessions(() => true, CancellationToken.None);

			const item = sessions.find(i => i.id === 'truncated1');
			expect(item?.label).toBe('Fix the bug in the parser');
			// Should have loaded the full session because summary had '<'
			expect(getSessionSpy).toHaveBeenCalled();
		});

		it('uses cached label on second call without loading session again', async () => {
			const s = new MockCliSdkSession('cache1', new Date());
			// No summary forces session load on first call
			s.events.push({ type: 'user.message', data: { content: 'Refactor the tests' }, timestamp: Date.now().toString() });
			manager.sessions.set(s.sessionId, s);

			// First call - loads session and caches the label
			const sessions1 = await service.getAllSessions(() => true, CancellationToken.None);
			const item1 = sessions1.find(i => i.id === 'cache1');
			expect(item1?.label).toBe('Refactor the tests');

			// Now spy on getSession for the second call
			const getSessionSpy = vi.spyOn(manager, 'getSession');

			// Second call - should use cached label
			const sessions2 = await service.getAllSessions(() => true, CancellationToken.None);
			const item2 = sessions2.find(i => i.id === 'cache1');
			expect(item2?.label).toBe('Refactor the tests');
			// Should not have loaded the full session on second call
			expect(getSessionSpy).not.toHaveBeenCalled();
		});

		it('cached label takes priority over metadata summary', async () => {
			const s = new MockCliSdkSession('priority1', new Date());
			// No summary initially - forces session load and caching
			s.events.push({ type: 'user.message', data: { content: 'Original label from events' }, timestamp: Date.now().toString() });
			manager.sessions.set(s.sessionId, s);

			// First call caches label from events
			const sessions1 = await service.getAllSessions(() => true, CancellationToken.None);
			expect(sessions1.find(i => i.id === 'priority1')?.label).toBe('Original label from events');

			// Now add a summary to the metadata - the cached label should still be used
			s.summary = 'Different summary label';

			const sessions2 = await service.getAllSessions(() => true, CancellationToken.None);
			expect(sessions2.find(i => i.id === 'priority1')?.label).toBe('Original label from events');
		});

		it('populates cache after loading session for label', async () => {
			const s = new MockCliSdkSession('populate1', new Date());
			s.events.push({ type: 'user.message', data: { content: 'Add unit tests for auth' }, timestamp: Date.now().toString() });
			manager.sessions.set(s.sessionId, s);

			await service.getAllSessions(() => true, CancellationToken.None);

			// Verify the internal cache was populated
			const labelCache = (service as any)._sessionLabels as Map<string, string>;
			expect(labelCache.get('populate1')).toBe('Add unit tests for auth');
		});

		it('does not cache when using clean summary from metadata directly', async () => {
			const s = new MockCliSdkSession('nocache1', new Date());
			s.summary = 'Clean summary without brackets';
			manager.sessions.set(s.sessionId, s);

			await service.getAllSessions(() => true, CancellationToken.None);

			// The cache should not have an entry since the summary was used directly
			const labelCache = (service as any)._sessionLabels as Map<string, string>;
			expect(labelCache.has('nocache1')).toBe(false);
		});
	});

	describe('CopilotCLISessionService.auto disposal timeout', () => {
		it.skip('disposes session after completion timeout and aborts underlying sdk session', async () => {
			vi.useFakeTimers();
			const session = await service.createSession({}, CancellationToken.None);

			vi.advanceTimersByTime(31000);
			await Promise.resolve(); // allow any pending promises to run

			// dispose should have been called by timeout
			expect(session.object.isDisposed).toBe(true);
		});
	});
});
