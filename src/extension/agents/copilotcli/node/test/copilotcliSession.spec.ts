/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Session } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationSession } from 'vscode';
import { IAuthenticationService } from '../../../../../platform/authentication/common/authentication';
import { IGitService } from '../../../../../platform/git/common/gitService';
import { ILogService } from '../../../../../platform/log/common/logService';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../../util/common/test/simpleMock';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import * as path from '../../../../../util/vs/base/common/path';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatSessionStatus, Uri } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { MockChatResponseStream } from '../../../../test/node/testHelpers';
import { ExternalEditTracker } from '../../../common/externalEditTracker';
import { CopilotCLISessionOptions } from '../copilotCli';
import { CopilotCLISession } from '../copilotcliSession';
import { PermissionRequest } from '../permissionHelpers';

// Minimal shapes for types coming from the Copilot SDK we interact with
interface MockSdkEventHandler { (payload: unknown): void }
type MockSdkEventMap = Map<string, Set<MockSdkEventHandler>>;

class MockSdkSession {
	onHandlers: MockSdkEventMap = new Map();
	public sessionId = 'mock-session-id';
	public _selectedModel: string | undefined = 'modelA';
	public authInfo: unknown;

	on(event: string, handler: MockSdkEventHandler) {
		if (!this.onHandlers.has(event)) {
			this.onHandlers.set(event, new Set());
		}
		this.onHandlers.get(event)!.add(handler);
		return () => this.onHandlers.get(event)!.delete(handler);
	}

	emit(event: string, data: unknown) {
		this.onHandlers.get(event)?.forEach(h => h({ data }));
	}

	async send({ prompt }: { prompt: string }) {
		// Simulate a normal successful turn with a message
		this.emit('assistant.turn_start', {});
		this.emit('assistant.message', { content: `Echo: ${prompt}` });
		this.emit('assistant.turn_end', {});
	}

	setAuthInfo(info: any) { this.authInfo = info; }
	async getSelectedModel() { return this._selectedModel; }
	async setSelectedModel(model: string) { this._selectedModel = model; }
	async getEvents() { return []; }
}

function createWorkspaceService(root: string): IWorkspaceService {
	const rootUri = Uri.file(root);
	return new class extends TestWorkspaceService {
		override getWorkspaceFolders() {
			return [
				rootUri
			];
		}
		override getWorkspaceFolder(uri: Uri) {
			return uri.fsPath.startsWith(rootUri.fsPath) ? rootUri : undefined;
		}
	};
}


describe('CopilotCLISession', () => {
	const disposables = new DisposableStore();
	let sdkSession: MockSdkSession;
	let workspaceService: IWorkspaceService;
	let logger: ILogService;
	let gitService: IGitService;
	let sessionOptions: CopilotCLISessionOptions;
	let authService: IAuthenticationService;
	let instaService: IInstantiationService;
	beforeEach(async () => {
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		logger = accessor.get(ILogService);
		gitService = accessor.get(IGitService);
		authService = new class extends mock<IAuthenticationService>() {
			override async getAnyGitHubSession() {
				return {
					accessToken: '',
				} satisfies Partial<AuthenticationSession> as AuthenticationSession;
			}
		}();
		sdkSession = new MockSdkSession();
		sessionOptions = new CopilotCLISessionOptions({}, logger);
		workspaceService = createWorkspaceService('/workspace');
		instaService = services.seal();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		disposables.clear();
	});


	async function createSession(): Promise<CopilotCLISession> {
		return disposables.add(new CopilotCLISession(
			sessionOptions,
			sdkSession as unknown as Session,
			gitService,
			logger,
			workspaceService,
			authService,
			instaService
		));
	}

	it('handles a successful request and streams assistant output', async () => {
		const session = await createSession();
		const stream = new MockChatResponseStream();

		// Attach stream first, then invoke with new signature (no stream param)
		session.attachStream(stream);
		await session.handleRequest('Hello', [], undefined, CancellationToken.None);

		expect(session.status).toBe(ChatSessionStatus.Completed);
		expect(stream.output.join('\n')).toContain('Echo: Hello');
		// Listeners are disposed after completion, so we only assert original streamed content.
	});

	it('switches model when different modelId provided', async () => {
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest('Hi', [], 'modelB', CancellationToken.None);

		expect(sdkSession._selectedModel).toBe('modelB');
	});

	it('fails request when underlying send throws', async () => {
		// Force send to throw
		sdkSession.send = async () => { throw new Error('network'); };
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest('Boom', [], undefined, CancellationToken.None);

		expect(session.status).toBe(ChatSessionStatus.Failed);
		expect(stream.output.join('\n')).toContain('Error: network');
	});

	it('emits status events on successful request', async () => {
		const session = await createSession();
		const statuses: (ChatSessionStatus | undefined)[] = [];
		const listener = disposables.add(session.onDidChangeStatus(s => statuses.push(s)));
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest('Status OK', [], 'modelA', CancellationToken.None);
		listener.dispose?.();

		expect(statuses).toEqual([ChatSessionStatus.InProgress, ChatSessionStatus.Completed]);
		expect(session.status).toBe(ChatSessionStatus.Completed);
	});

	it('emits status events on failed request', async () => {
		// Force failure
		sdkSession.send = async () => { throw new Error('boom'); };
		const session = await createSession();
		const statuses: (ChatSessionStatus | undefined)[] = [];
		const listener = disposables.add(session.onDidChangeStatus(s => statuses.push(s)));
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest('Will Fail', [], undefined, CancellationToken.None);
		listener.dispose?.();

		expect(statuses).toEqual([ChatSessionStatus.InProgress, ChatSessionStatus.Failed]);
		expect(session.status).toBe(ChatSessionStatus.Failed);
		expect(stream.output.join('\n')).toContain('Error: boom');
	});

	it('auto-approves read permission inside workspace without external handler', async () => {
		// Keep session active while requesting permission
		let resolveSend: () => void;
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		const handlePromise = session.handleRequest('Test', [], undefined, CancellationToken.None);

		// Path must be absolute within workspace, should auto-approve
		const result = await sessionOptions.toSessionOptions().requestPermission!({ kind: 'read', path: path.join('/workspace', 'file.ts'), intention: 'Read file' });
		resolveSend!();
		await handlePromise;
		expect(result).toEqual({ kind: 'approved' });
	});

	it('auto-approves read permission inside working directory without external handler', async () => {
		// Keep session active while requesting permission
		let resolveSend: () => void;
		sessionOptions = new CopilotCLISessionOptions({ workingDirectory: '/workingDirectory' }, logger);
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		const handlePromise = session.handleRequest('Test', [], undefined, CancellationToken.None);

		// Path must be absolute within workspace, should auto-approve
		const result = await sessionOptions.toSessionOptions().requestPermission!({ kind: 'read', path: path.join('/workingDirectory', 'file.ts'), intention: 'Read file' });
		resolveSend!();
		await handlePromise;
		expect(result).toEqual({ kind: 'approved' });
	});

	it('requires read permission outside workspace and working directory', async () => {
		// Keep session active while requesting permission
		let resolveSend: () => void;
		let askedForPermission: PermissionRequest | undefined = undefined;
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);

		disposables.add(session.attachPermissionHandler((permission) => {
			askedForPermission = permission;
			return Promise.resolve(false);
		}));
		const handlePromise = session.handleRequest('Test', [], undefined, CancellationToken.None);

		// Path must be absolute within workspace, should auto-approve
		const file = path.join('/workingDirectory', 'file.ts');
		const result = await sessionOptions.toSessionOptions().requestPermission!({ kind: 'read', path: file, intention: 'Read file' });
		resolveSend!();
		await handlePromise;
		expect(result).toEqual({ kind: 'denied-interactively-by-user' });
		expect(askedForPermission).not.toBeUndefined();
		expect(askedForPermission!.kind).toBe('read');
		expect((askedForPermission as unknown as { path: string })!.path).toBe(file);
	});

	it('approves write permission when handler returns true', async () => {
		const session = await createSession();
		// Register approval handler
		disposables.add(session.attachPermissionHandler(async () => true));
		let resolveSend: () => void;
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		const handlePromise = session.handleRequest('Write', [], undefined, CancellationToken.None);

		const result = await sessionOptions.toSessionOptions().requestPermission!({ kind: 'write', fileName: 'a.ts', intention: 'Update file', diff: '' });
		resolveSend!();
		await handlePromise;
		expect(result).toEqual({ kind: 'approved' });
	});

	it('denies write permission when handler returns false', async () => {
		const session = await createSession();
		session.attachPermissionHandler(async () => false);
		let resolveSend: () => void;
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		const handlePromise = session.handleRequest('Write', [], undefined, CancellationToken.None);

		const result = await sessionOptions.toSessionOptions().requestPermission!({ kind: 'write', fileName: 'b.ts', intention: 'Update file', diff: '' });
		resolveSend!();
		await handlePromise;
		expect(result).toEqual({ kind: 'denied-interactively-by-user' });
	});

	it('denies write permission when handler throws', async () => {
		const session = await createSession();
		session.attachPermissionHandler(async () => { throw new Error('oops'); });
		let resolveSend: () => void;
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		const handlePromise = session.handleRequest('Write', [], undefined, CancellationToken.None);

		const result = await sessionOptions.toSessionOptions().requestPermission!({ kind: 'write', fileName: 'err.ts', intention: 'Update file', diff: '' });
		resolveSend!();
		await handlePromise;
		expect(result).toEqual({ kind: 'denied-interactively-by-user' });
	});

	it('preserves order of edit toolCallIds and permissions for multiple pending edits', async () => {
		// Arrange a deferred send so we can emit tool events before request finishes
		let resolveSend: () => void;
		sdkSession.send = async () => new Promise<void>(r => { resolveSend = r; });
		const session = await createSession();
		session.attachPermissionHandler(async () => true);
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		// Spy on trackEdit to capture ordering (we don't want to depend on externalEdit mechanics here)
		const trackedOrder: string[] = [];
		const trackSpy = vi.spyOn(ExternalEditTracker.prototype, 'trackEdit').mockImplementation(async function (this: any, editKey: string) {
			trackedOrder.push(editKey);
			// Immediately resolve to avoid hanging on externalEdit lifecycle
			return Promise.resolve();
		});

		// Act: start handling request (do not await yet)
		const requestPromise = session.handleRequest('Edits', [], undefined, CancellationToken.None);

		// Wait a tick to ensure event listeners are registered inside handleRequest
		await new Promise(r => setTimeout(r, 0));

		// Emit 10 edit tool start events in rapid succession for the same file
		const filePath = '/workspace/abc.py';
		for (let i = 1; i <= 10; i++) {
			sdkSession.emit('tool.execution_start', {
				toolCallId: String(i),
				toolName: 'str_replace_editor',
				arguments: { command: 'str_replace', path: filePath }
			});
		}

		// Now request permissions sequentially AFTER all tool calls have been emitted
		const permissionResults: any[] = [];
		for (let i = 1; i <= 10; i++) {
			// Each permission request should dequeue the next toolCallId for the file
			const result = await sessionOptions.toSessionOptions().requestPermission!({
				kind: 'write',
				fileName: filePath,
				intention: 'Apply edit',
				diff: ''
			});
			permissionResults.push(result);
			// Complete the edit so the tracker (if it were real) would finish; emit completion event
			sdkSession.emit('tool.execution_complete', {
				toolCallId: String(i),
				toolName: 'str_replace_editor',
				arguments: { command: 'str_replace', path: filePath },
				success: true,
				result: { content: '' }
			});
		}

		// Allow the request to finish
		resolveSend!();
		await requestPromise;

		// Assert ordering of trackEdit invocations exactly matches toolCallIds 1..10
		expect(trackedOrder).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
		expect(permissionResults.every(r => r.kind === 'approved')).toBe(true);
		expect(trackSpy).toHaveBeenCalledTimes(10);

		trackSpy.mockRestore();
	});
});
