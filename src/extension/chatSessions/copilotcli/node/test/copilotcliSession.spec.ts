/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Session, SessionOptions } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatContext, ChatParticipantToolToken } from 'vscode';
import { ILogService } from '../../../../../platform/log/common/logService';
import { NullRequestLogger } from '../../../../../platform/requestLogger/node/nullRequestLogger';
import { IRequestLogger } from '../../../../../platform/requestLogger/node/requestLogger';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../../util/common/test/simpleMock';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import * as path from '../../../../../util/vs/base/common/path';
import { URI } from '../../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatSessionStatus, ChatToolInvocationPart, Uri } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { MockChatResponseStream } from '../../../../test/node/testHelpers';
import { ExternalEditTracker } from '../../../common/externalEditTracker';
import { IWorkspaceInfo } from '../../../common/workspaceInfo';
import { FakeToolsService, ToolCall } from '../../common/copilotCLITools';
import { IChatDelegationSummaryService } from '../../common/delegationSummaryService';
import { CopilotCLISessionOptions, ICopilotCLISDK } from '../copilotCli';
import { CopilotCLISession } from '../copilotcliSession';
import { PermissionRequest } from '../permissionHelpers';
import { IUserQuestionHandler, UserInputRequest, UserInputResponse } from '../userInputHelpers';
import { NullICopilotCLIImageSupport } from './copilotCliSessionService.spec';

vi.mock('../cliHelpers', () => ({
	getCopilotCLISessionStateDir: () => '/mock-session-state',
}));

// Minimal shapes for types coming from the Copilot SDK we interact with
interface MockSdkEventHandler { (payload: unknown): void }
type MockSdkEventMap = Map<string, Set<MockSdkEventHandler>>;

class MockSdkSession {
	onHandlers: MockSdkEventMap = new Map();
	public sessionId = 'mock-session-id';
	public _selectedModel: string | undefined = 'modelA';
	public authInfo: unknown;
	private _pendingPermissions = new Map<string, { resolve: (result: unknown) => void }>();
	private _permissionCounter = 0;

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

	/**
	 * Simulate the SDK emitting a permission.requested event and await the response.
	 * The session's event handler will call respondToPermission() which resolves the returned promise.
	 */
	async emitPermissionRequest(permissionRequest: PermissionRequest): Promise<unknown> {
		const requestId = `perm-${++this._permissionCounter}`;
		return new Promise(resolve => {
			this._pendingPermissions.set(requestId, { resolve });
			this.emit('permission.requested', { requestId, permissionRequest });
		});
	}

	respondToPermission(requestId: string, result: unknown) {
		const pending = this._pendingPermissions.get(requestId);
		if (pending) {
			pending.resolve(result);
			this._pendingPermissions.delete(requestId);
		}
	}

	respondToUserInput(_requestId: string, _response: unknown) {
		// placeholder for user input responses
	}

	public lastSendOptions: { prompt: string; mode?: string } | undefined;
	public currentMode: string | undefined;

	async send(options: { prompt: string; mode?: string }) {
		this.lastSendOptions = options;
		// Simulate a normal successful turn with a message
		this.emit('assistant.turn_start', {});
		this.emit('assistant.message', { content: `Echo: ${options.prompt}` });
		this.emit('assistant.turn_end', {});
	}

	async compactHistory() { return { success: true }; }

	async initializeAndValidateTools() { }
	getCurrentToolMetadata(): unknown[] | undefined { return this._toolMetadata; }
	private _toolMetadata: unknown[] | undefined;
	set toolMetadata(value: unknown[] | undefined) { this._toolMetadata = value; }

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

function workspaceInfoFor(workingDirectory: Uri | undefined): IWorkspaceInfo {
	return {
		folder: workingDirectory,
		repository: undefined,
		worktree: undefined,
		worktreeProperties: undefined,
	};
}


describe('CopilotCLISession', () => {
	const disposables = new DisposableStore();
	let sdkSession: MockSdkSession;
	let workspaceService: IWorkspaceService;
	let logger: ILogService;
	let sessionOptions: CopilotCLISessionOptions;
	let instaService: IInstantiationService;
	let sdk: ICopilotCLISDK;
	let requestLogger: IRequestLogger;
	const delegationService = new class extends mock<IChatDelegationSummaryService>() {
		override async summarize(context: ChatContext, token: CancellationToken): Promise<string | undefined> {
			return undefined;
		}
	}();
	let authInfo: NonNullable<SessionOptions['authInfo']>;
	beforeEach(async () => {
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		logger = accessor.get(ILogService);
		requestLogger = new NullRequestLogger();
		authInfo = {
			type: 'token',
			token: '',
			host: 'https://github.com'
		};
		sdk = new class extends mock<ICopilotCLISDK>() {
			override async getAuthInfo(): Promise<NonNullable<SessionOptions['authInfo']>> {
				return authInfo;
			}
		};
		sdkSession = new MockSdkSession();
		workspaceService = createWorkspaceService('/workspace');
		sessionOptions = new CopilotCLISessionOptions({ workspaceInfo: workspaceInfoFor(workspaceService.getWorkspaceFolders()![0]) }, logger);
		instaService = services.seal();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		disposables.clear();
	});


	async function createSession(): Promise<CopilotCLISession> {
		class FakeUserQuestionHandler implements IUserQuestionHandler {
			_serviceBrand: undefined;
			async askUserQuestion(question: UserInputRequest, toolInvocationToken: ChatParticipantToolToken, token: CancellationToken): Promise<UserInputResponse | undefined> {
				return undefined;
			}
		}
		return disposables.add(new CopilotCLISession(
			sessionOptions,
			sdkSession as unknown as Session,
			logger,
			workspaceService,
			sdk,
			instaService,
			delegationService,
			requestLogger,
			new NullICopilotCLIImageSupport(),
			new FakeToolsService(),
			new FakeUserQuestionHandler()
		));
	}

	it('handles a successful request and streams assistant output', async () => {
		const session = await createSession();
		const stream = new MockChatResponseStream();

		// Attach stream first, then invoke with new signature (no stream param)
		session.attachStream(stream);
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Hello' }, [], undefined, authInfo, CancellationToken.None);

		expect(session.status).toBe(ChatSessionStatus.Completed);
		expect(stream.output.join('\n')).toContain('Echo: Hello');
		// Listeners are disposed after completion, so we only assert original streamed content.
	});

	it('switches model when different modelId provided', async () => {
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Hi' }, [], 'modelB', authInfo, CancellationToken.None);

		expect(sdkSession._selectedModel).toBe('modelB');
	});

	it('fails request when underlying send throws', async () => {
		// Force send to throw
		sdkSession.send = async () => { throw new Error('network'); };
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Boom' }, [], undefined, authInfo, CancellationToken.None);

		expect(session.status).toBe(ChatSessionStatus.Failed);
		expect(stream.output.join('\n')).toContain('Error: network');
	});

	it('emits status events on successful request', async () => {
		const session = await createSession();
		const statuses: (ChatSessionStatus | undefined)[] = [];
		const listener = disposables.add(session.onDidChangeStatus(s => statuses.push(s)));
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Status OK' }, [], 'modelA', authInfo, CancellationToken.None);
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
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Will Fail' }, [], undefined, authInfo, CancellationToken.None);
		listener.dispose?.();
		expect(stream.output.join('\n')).toContain('Error: boom');
	});

	it('auto-approves read permission inside workspace without external handler', async () => {
		let result: unknown;
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			// Mid way through, make it look like the sdk requested permission while emitting other messages.
			result = await sdkSession.emitPermissionRequest({ kind: 'read', path: path.join('/workspace', 'file.ts'), intention: 'Read file' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);

		// Path must be absolute within workspace, should auto-approve
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test' }, [], undefined, authInfo, CancellationToken.None);
		expect(result).toEqual({ kind: 'approved' });
	});

	it('auto-approves read permission for files in session state directory', async () => {
		let result: unknown;
		const sessionFilePath = path.join('/mock-session-state', 'mock-session-id', 'plan.md');
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			result = await sdkSession.emitPermissionRequest({ kind: 'read', path: sessionFilePath, intention: 'Read plan' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test' }, [], undefined, authInfo, CancellationToken.None);
		expect(result).toEqual({ kind: 'approved' });
	});

	it('auto-approves write permission for files in session state directory', async () => {
		let result: unknown;
		const sessionFilePath = path.join('/mock-session-state', 'mock-session-id', 'plan.md');
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			result = await sdkSession.emitPermissionRequest({ kind: 'write', fileName: sessionFilePath, intention: 'Write plan', diff: '' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test' }, [], undefined, authInfo, CancellationToken.None);
		expect(result).toEqual({ kind: 'approved' });
	});

	it('auto-approves read permission for attached files outside workspace', async () => {
		let result: unknown;
		const attachedFilePath = '/outside-workspace/attached-file.ts';
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			result = await sdkSession.emitPermissionRequest({ kind: 'read', path: attachedFilePath, intention: 'Read file' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);

		const attachments = [{ type: 'file' as const, path: attachedFilePath, displayName: 'attached-file.ts' }];
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test' }, attachments as any, undefined, authInfo, CancellationToken.None);
		expect(result).toEqual({ kind: 'approved' });
	});

	it('does not auto-approve read permission for non-attached files outside workspace', async () => {
		let result: unknown;
		const nonAttachedFilePath = '/outside-workspace/other-file.ts';
		const attachedFilePath = '/outside-workspace/attached-file.ts';
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			result = await sdkSession.emitPermissionRequest({ kind: 'read', path: nonAttachedFilePath, intention: 'Read file' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		disposables.add(session.attachPermissionHandler(async () => false));

		const attachments = [{ type: 'file' as const, path: attachedFilePath, displayName: 'attached-file.ts' }];
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test' }, attachments as any, undefined, authInfo, CancellationToken.None);
		expect(result).toEqual({ kind: 'denied-interactively-by-user' });
	});

	it('auto-approves read permission inside working directory without external handler', async () => {
		let result: unknown;
		sessionOptions = new CopilotCLISessionOptions({ workspaceInfo: workspaceInfoFor(URI.file('/workingDirectory')) }, logger);
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			// Mid way through, make it look like the sdk requested permission while emitting other messages.
			result = await sdkSession.emitPermissionRequest({ kind: 'read', path: path.join('/workingDirectory', 'file.ts'), intention: 'Read file' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);

		// Path must be absolute within workspace, should auto-approve
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test' }, [], undefined, authInfo, CancellationToken.None);
		expect(result).toEqual({ kind: 'approved' });
	});

	it('auto-approves read permission for files in workspace folder when worktree is the working directory', async () => {
		let result: unknown;
		const worktreeUri = URI.file('/worktrees/session1');
		const folderUri = URI.file('/original-repo');
		sessionOptions = new CopilotCLISessionOptions({
			workspaceInfo: {
				folder: folderUri,
				repository: folderUri,
				worktree: worktreeUri,
				worktreeProperties: { version: 1, autoCommit: false, baseCommit: 'abc', branchName: 'main', repositoryPath: '/original-repo', worktreePath: '/worktrees/session1' },
			}
		}, logger);
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			// File is in workspace.folder (/original-repo), not in the worktree which is the working directory
			result = await sdkSession.emitPermissionRequest({ kind: 'read', path: path.join('/original-repo', 'src/main.ts'), intention: 'Read file' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);

		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test' }, [], undefined, authInfo, CancellationToken.None);
		expect(result).toEqual({ kind: 'approved' });
	});

	it('auto-approves read permission for files in the worktree when workspace has both worktree and repository', async () => {
		let result: unknown;
		const worktreeUri = URI.file('/worktrees/session1');
		const folderUri = URI.file('/original-repo');
		sessionOptions = new CopilotCLISessionOptions({
			workspaceInfo: {
				folder: folderUri,
				repository: folderUri,
				worktree: worktreeUri,
				worktreeProperties: { version: 1, autoCommit: false, baseCommit: 'abc', branchName: 'main', repositoryPath: '/original-repo', worktreePath: '/worktrees/session1' },
			}
		}, logger);
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			// File is in the worktree which is also the working directory
			result = await sdkSession.emitPermissionRequest({ kind: 'read', path: path.join('/worktrees/session1', 'src/main.ts'), intention: 'Read file' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);

		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test' }, [], undefined, authInfo, CancellationToken.None);
		expect(result).toEqual({ kind: 'approved' });
	});

	it('requires read permission outside workspace and working directory', async () => {
		let result: unknown;
		let askedForPermission: PermissionRequest | undefined = undefined;
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			// Mid way through, make it look like the sdk requested permission while emitting other messages.
			result = await sdkSession.emitPermissionRequest({ kind: 'read', path: path.join('/workingDirectory', 'file.ts'), intention: 'Read file' });

			sdkSession.emit('assistant.turn_end', {});
		};
		const session = await createSession();
		const stream = new MockChatResponseStream();
		session.attachStream(stream);

		disposables.add(session.attachPermissionHandler((permission) => {
			askedForPermission = permission;
			return Promise.resolve(false);
		}));

		// Path must be absolute within workspace, should auto-approve
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test' }, [], undefined, authInfo, CancellationToken.None);
		const file = path.join('/workingDirectory', 'file.ts');
		expect(result).toEqual({ kind: 'denied-interactively-by-user' });
		expect(askedForPermission).not.toBeUndefined();
		expect(askedForPermission!.kind).toBe('read');
		expect((askedForPermission as unknown as { path: string })!.path).toBe(file);
	});

	it('approves write permission when handler returns true', async () => {
		let result: unknown;
		const session = await createSession();
		// Register approval handler
		disposables.add(session.attachPermissionHandler(async () => true));
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			// Mid way through, make it look like the sdk requested permission while emitting other messages.
			result = await sdkSession.emitPermissionRequest({ kind: 'write', fileName: 'a.ts', intention: 'Update file', diff: '' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const stream = new MockChatResponseStream();
		session.attachStream(stream);

		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Write' }, [], undefined, authInfo, CancellationToken.None);

		expect(result).toEqual({ kind: 'approved' });
	});

	it('denies write permission when handler returns false', async () => {
		let result: unknown;
		const session = await createSession();
		session.attachPermissionHandler(async () => false);
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			// Mid way through, make it look like the sdk requested permission while emitting other messages.
			result = await sdkSession.emitPermissionRequest({ kind: 'write', fileName: 'b.ts', intention: 'Update file', diff: '' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Write' }, [], undefined, authInfo, CancellationToken.None);

		expect(result).toEqual({ kind: 'denied-interactively-by-user' });
	});

	it('denies write permission when handler throws', async () => {
		let result: unknown;
		const session = await createSession();
		session.attachPermissionHandler(async () => { throw new Error('oops'); });
		sdkSession.send = async ({ prompt }: any) => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			// Mid way through, make it look like the sdk requested permission while emitting other messages.
			result = await sdkSession.emitPermissionRequest({ kind: 'write', fileName: 'err.ts', intention: 'Update file', diff: '' });
			sdkSession.emit('assistant.turn_end', {});
		};
		const stream = new MockChatResponseStream();
		session.attachStream(stream);
		await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Write' }, [], undefined, authInfo, CancellationToken.None);

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
		const requestPromise = session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Edits' }, [], undefined, authInfo, CancellationToken.None);

		// Wait a tick to ensure event listeners are registered inside handleRequest
		await new Promise(r => setTimeout(r, 0));

		// Emit 10 edit tool start events in rapid succession for the same file
		const filePath = '/workspace/abc.py';
		for (let i = 1; i <= 10; i++) {
			const editToolCall: ToolCall = {
				toolName: 'edit',
				toolCallId: String(i),
				arguments: { path: filePath, new_str: 'new content' },
			};
			sdkSession.emit('tool.execution_start', editToolCall);
		}

		// Now request permissions sequentially AFTER all tool calls have been emitted
		const permissionResults: any[] = [];
		for (let i = 1; i <= 10; i++) {
			// Each permission request should dequeue the next toolCallId for the file
			const result = await sdkSession.emitPermissionRequest({
				kind: 'write',
				fileName: filePath,
				intention: 'Apply edit',
				diff: '',
				toolCallId: String(i)
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

	it('delays tool invocation messages for permission-requiring tools until permission is resolved', async () => {
		let resolveSend: () => void;
		sdkSession.send = async () => new Promise<void>(r => { resolveSend = r; });
		const session = await createSession();
		const pushedParts: unknown[] = [];
		const stream = new MockChatResponseStream(part => pushedParts.push(part));
		session.attachStream(stream);
		disposables.add(session.attachPermissionHandler(async () => true));

		const requestPromise = session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Run bash' }, [], undefined, authInfo, CancellationToken.None);
		await new Promise(r => setTimeout(r, 0));

		// Emit a bash tool start - this should be delayed
		const bashToolCall: ToolCall = { toolName: 'bash', toolCallId: 'bash-delay-1', arguments: { command: 'echo hi', description: 'Echo test' } };
		sdkSession.emit('tool.execution_start', bashToolCall);
		await new Promise(r => setTimeout(r, 0));

		// No ChatToolInvocationPart should be pushed yet for the bash tool
		const toolPartsBeforePermission = pushedParts.filter(p => p instanceof ChatToolInvocationPart);
		expect(toolPartsBeforePermission).toHaveLength(0);

		// When permission is requested, the pending messages should be flushed
		await sdkSession.emitPermissionRequest({
			kind: 'shell',
			commands: [{ identifier: 'echo hi', readOnly: false }],
			intention: 'Run command',
			fullCommandText: 'echo hi',
			possiblePaths: [],
			possibleUrls: [],
			hasWriteFileRedirection: false,
			canOfferSessionApproval: false
		});
		await new Promise(r => setTimeout(r, 0));

		const toolPartsAfterPermission = pushedParts.filter(p => p instanceof ChatToolInvocationPart);
		expect(toolPartsAfterPermission.length).toBeGreaterThanOrEqual(1);

		sdkSession.emit('tool.execution_complete', { toolCallId: 'bash-delay-1', toolName: 'bash', success: true, result: { content: 'hi' } });
		resolveSend!();
		await requestPromise;
	});

	it('immediately pushes invocation messages for non-permission-requiring tools like MCP', async () => {
		let resolveSend: () => void;
		sdkSession.send = async () => new Promise<void>(r => { resolveSend = r; });
		const session = await createSession();
		const pushedParts: unknown[] = [];
		const stream = new MockChatResponseStream(part => pushedParts.push(part));
		session.attachStream(stream);

		const requestPromise = session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Run MCP tool' }, [], undefined, authInfo, CancellationToken.None);
		await new Promise(r => setTimeout(r, 0));

		// Emit an MCP tool start - this should NOT be delayed
		sdkSession.emit('tool.execution_start', { toolName: 'my_mcp_tool', toolCallId: 'mcp-nodelay-1', mcpServerName: 'test-server', mcpToolName: 'my-tool', arguments: { foo: 'bar' } });
		await new Promise(r => setTimeout(r, 0));

		const toolParts = pushedParts.filter(p => p instanceof ChatToolInvocationPart);
		expect(toolParts.length).toBeGreaterThanOrEqual(1);

		sdkSession.emit('tool.execution_complete', { toolCallId: 'mcp-nodelay-1', toolName: 'my_mcp_tool', mcpServerName: 'test-server', mcpToolName: 'my-tool', success: true, result: { contents: [] } });
		resolveSend!();
		await requestPromise;
	});

	it('flushes delayed invocation messages when assistant message arrives', async () => {
		let resolveSend: () => void;
		sdkSession.send = async () => new Promise<void>(r => { resolveSend = r; });
		const session = await createSession();
		const pushedParts: unknown[] = [];
		const stream = new MockChatResponseStream(part => pushedParts.push(part));
		session.attachStream(stream);

		const requestPromise = session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { prompt: 'Test flush' }, [], undefined, authInfo, CancellationToken.None);
		await new Promise(r => setTimeout(r, 0));

		// Emit a bash tool start (delayed)
		sdkSession.emit('tool.execution_start', { toolName: 'bash', toolCallId: 'bash-flush-1', arguments: { command: 'ls', description: 'List' } });
		await new Promise(r => setTimeout(r, 0));

		expect(pushedParts.filter(p => p instanceof ChatToolInvocationPart)).toHaveLength(0);

		// Emit an assistant message delta - should flush
		sdkSession.emit('assistant.message_delta', { deltaContent: 'Hello', messageId: 'msg-1' });
		await new Promise(r => setTimeout(r, 0));

		expect(pushedParts.filter(p => p instanceof ChatToolInvocationPart).length).toBeGreaterThanOrEqual(1);

		sdkSession.emit('tool.execution_complete', { toolCallId: 'bash-flush-1', toolName: 'bash', success: true, result: { content: '' } });
		resolveSend!();
		await requestPromise;
	});

	describe('/mcp command', () => {
		it('shows no servers message when no MCP tools are loaded', async () => {
			sdkSession.toolMetadata = [];
			const session = await createSession();
			const stream = new MockChatResponseStream();
			session.attachStream(stream);
			await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { command: 'mcp' }, [], undefined, authInfo, CancellationToken.None);

			expect(stream.output.join('\n')).toContain('No MCP servers connected.');
		});

		it('lists MCP servers grouped by namespace with tool details', async () => {
			sdkSession.toolMetadata = [
				{ name: 'github-get_file', namespacedName: 'github/get_file', mcpServerName: 'VS Code MCP Gateway', mcpToolName: 'get_file', title: 'Get file contents', description: 'Get the contents of a file' },
				{ name: 'github-search_code', namespacedName: 'github/search_code', mcpServerName: 'VS Code MCP Gateway', mcpToolName: 'search_code', title: 'Search code', description: 'Search for code across repos' },
				{ name: 'playwright-navigate', namespacedName: 'playwright/navigate', mcpServerName: 'VS Code MCP Gateway', mcpToolName: 'navigate', title: 'Navigate', description: 'Navigate to a URL' },
				{ name: 'non_mcp_tool', description: 'A built-in tool without MCP' },
			];
			const session = await createSession();
			const stream = new MockChatResponseStream();
			session.attachStream(stream);
			await session.handleRequest({ id: '', toolInvocationToken: undefined as never }, { command: 'mcp' }, [], undefined, authInfo, CancellationToken.None);

			const output = stream.output.join('\n');
			expect(output).toContain('github (2 tools)');
			expect(output).toContain('playwright (1 tool)');
			expect(output).toContain('**Get file contents** (`get_file`)');
			expect(output).toContain('**Search code** (`search_code`)');
			expect(output).toContain('**Navigate** (`navigate`)');
			// Non-MCP tool should not appear
			expect(output).not.toContain('non_mcp_tool');
		});
	});

	describe('steering (sending messages to a busy session)', () => {
		it('routes through steering when session is already InProgress', async () => {
			// Arrange: make `send` block so the first request stays in progress
			let resolveFirstSend: () => void = () => { };
			let sendCallCount = 0;
			sdkSession.send = async (options: any) => {
				sendCallCount++;
				sdkSession.lastSendOptions = options;
				if (sendCallCount === 1) {
					// First request blocks until we resolve
					await new Promise<void>(r => { resolveFirstSend = r; });
				}
				sdkSession.emit('assistant.turn_start', {});
				sdkSession.emit('assistant.message', { content: `Echo: ${options.prompt}` });
				sdkSession.emit('assistant.turn_end', {});
			};

			const session = await createSession();
			const stream = new MockChatResponseStream();
			session.attachStream(stream);

			// Act: start first request (will block in send)
			const firstRequest = session.handleRequest(
				{ id: 'req-1', toolInvocationToken: undefined as never },
				{ prompt: 'First prompt' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));

			// Session should be InProgress
			expect(session.status).toBe(ChatSessionStatus.InProgress);

			// Send a steering request while first is still running
			const steeringRequest = session.handleRequest(
				{ id: 'req-2', toolInvocationToken: undefined as never },
				{ prompt: 'Steer this' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));

			// The steering send should have been called with mode: 'immediate'
			expect(sdkSession.lastSendOptions?.mode).toBe('immediate');
			expect(sdkSession.lastSendOptions?.prompt).toBe('Steer this');

			// Unblock the first request
			resolveFirstSend();
			await Promise.all([firstRequest, steeringRequest]);

			expect(session.status).toBe(ChatSessionStatus.Completed);
		});

		it('does not set mode to immediate for the first (non-steering) request', async () => {
			const session = await createSession();
			const stream = new MockChatResponseStream();
			session.attachStream(stream);

			await session.handleRequest(
				{ id: 'req-1', toolInvocationToken: undefined as never },
				{ prompt: 'Normal prompt' }, [], undefined, authInfo, CancellationToken.None
			);

			expect(sdkSession.lastSendOptions?.mode).toBeUndefined();
			expect(sdkSession.lastSendOptions?.prompt).toBe('Normal prompt');
		});

		it('accumulates attachments across steering requests for permission auto-approval', async () => {
			let resolveFirstSend!: () => void;
			let sendCallCount = 0;
			let permissionResult: unknown;

			// The attached file path is outside workspace
			const attachedFilePath = '/outside-workspace/steering-file.ts';

			sdkSession.send = async (options: any) => {
				sendCallCount++;
				const thisCallNumber = sendCallCount;
				sdkSession.lastSendOptions = options;
				if (thisCallNumber === 1) {
					await new Promise<void>(r => { resolveFirstSend = r; });
				}
				sdkSession.emit('assistant.turn_start', {});
				// On the first (original) request, try to read the file that was
				// attached in the second (steering) request.
				if (thisCallNumber === 1) {
					permissionResult = await sdkSession.emitPermissionRequest({
						kind: 'read', path: attachedFilePath, intention: 'Read file'
					});
				}
				sdkSession.emit('assistant.message', { content: `Echo: ${options.prompt}` });
				sdkSession.emit('assistant.turn_end', {});
			};

			const session = await createSession();
			const stream = new MockChatResponseStream();
			session.attachStream(stream);

			// Start first request with no attachments
			const firstRequest = session.handleRequest(
				{ id: 'req-1', toolInvocationToken: undefined as never },
				{ prompt: 'First' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));

			// Send steering request WITH the file attachment
			const steeringAttachments = [{ type: 'file' as const, path: attachedFilePath, displayName: 'steering-file.ts' }];
			const steeringRequest = session.handleRequest(
				{ id: 'req-2', toolInvocationToken: undefined as never },
				{ prompt: 'Use that file' }, steeringAttachments as any, undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));

			// Now unblock the first send - it will try to read the steering-attached file
			resolveFirstSend();
			await Promise.all([firstRequest, steeringRequest]);

			// The file was attached in the steering request, so it should be auto-approved
			expect(permissionResult).toEqual({ kind: 'approved' });
		});

		it('updates the pending prompt to the latest steering message', async () => {
			let resolveFirstSend!: () => void;
			let sendCallCount = 0;
			sdkSession.send = async (options: any) => {
				sendCallCount++;
				sdkSession.lastSendOptions = options;
				if (sendCallCount === 1) {
					await new Promise<void>(r => { resolveFirstSend = r; });
				}
				sdkSession.emit('assistant.turn_start', {});
				sdkSession.emit('assistant.message', { content: `Echo: ${options.prompt}` });
				sdkSession.emit('assistant.turn_end', {});
			};

			const session = await createSession();
			const stream = new MockChatResponseStream();
			session.attachStream(stream);

			// Start first request
			const firstRequest = session.handleRequest(
				{ id: 'req-1', toolInvocationToken: undefined as never },
				{ prompt: 'Original prompt' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));
			expect(session.pendingPrompt).toBe('Original prompt');

			// Steer
			const steeringRequest = session.handleRequest(
				{ id: 'req-2', toolInvocationToken: undefined as never },
				{ prompt: 'New direction' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));
			expect(session.pendingPrompt).toBe('New direction');

			resolveFirstSend();
			await Promise.all([firstRequest, steeringRequest]);
		});

		it('steering request does not change session status to InProgress again', async () => {
			let resolveFirstSend!: () => void;
			let sendCallCount = 0;
			sdkSession.send = async (options: any) => {
				sendCallCount++;
				sdkSession.lastSendOptions = options;
				if (sendCallCount === 1) {
					await new Promise<void>(r => { resolveFirstSend = r; });
				}
				sdkSession.emit('assistant.turn_start', {});
				sdkSession.emit('assistant.message', { content: `Echo: ${options.prompt}` });
				sdkSession.emit('assistant.turn_end', {});
			};

			const session = await createSession();
			const statuses: (ChatSessionStatus | undefined)[] = [];
			disposables.add(session.onDidChangeStatus(s => statuses.push(s)));
			const stream = new MockChatResponseStream();
			session.attachStream(stream);

			// Start first request
			const firstRequest = session.handleRequest(
				{ id: 'req-1', toolInvocationToken: undefined as never },
				{ prompt: 'First' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));
			// Should have fired InProgress once
			expect(statuses).toEqual([ChatSessionStatus.InProgress]);

			// Send steering request
			const steeringRequest = session.handleRequest(
				{ id: 'req-2', toolInvocationToken: undefined as never },
				{ prompt: 'Steer' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));

			// InProgress should NOT fire again from the steering path
			expect(statuses).toEqual([ChatSessionStatus.InProgress]);

			resolveFirstSend();
			await Promise.all([firstRequest, steeringRequest]);

			// Final status should be Completed
			expect(statuses).toEqual([ChatSessionStatus.InProgress, ChatSessionStatus.Completed]);
		});

		it('throws on disposed session', async () => {
			const session = await createSession();
			session.dispose();

			await expect(
				session.handleRequest(
					{ id: 'req-1', toolInvocationToken: undefined as never },
					{ prompt: 'Hello' }, [], undefined, authInfo, CancellationToken.None
				)
			).rejects.toThrow('Session disposed');
		});

		it('updates the toolInvocationToken on each request including steering', async () => {
			let resolveFirstSend!: () => void;
			let sendCallCount = 0;
			sdkSession.send = async (options: any) => {
				sendCallCount++;
				sdkSession.lastSendOptions = options;
				if (sendCallCount === 1) {
					await new Promise<void>(r => { resolveFirstSend = r; });
				}
				sdkSession.emit('assistant.turn_start', {});
				sdkSession.emit('assistant.message', { content: `Echo: ${options.prompt}` });
				sdkSession.emit('assistant.turn_end', {});
			};

			const session = await createSession();
			const stream = new MockChatResponseStream();
			session.attachStream(stream);

			const token1 = { toString: () => 'token-1' } as unknown as ChatParticipantToolToken;
			const token2 = { toString: () => 'token-2' } as unknown as ChatParticipantToolToken;

			const firstRequest = session.handleRequest(
				{ id: 'req-1', toolInvocationToken: token1 },
				{ prompt: 'First' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));

			// Steering replaces the token
			const steeringRequest = session.handleRequest(
				{ id: 'req-2', toolInvocationToken: token2 },
				{ prompt: 'Steer' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));

			// Can't directly access private _toolInvocationToken, but we verify
			// indirectly that the session accepted both tokens without error.
			// The key assertion is that handleRequest didn't throw.
			resolveFirstSend();
			await Promise.all([firstRequest, steeringRequest]);
			expect(session.status).toBe(ChatSessionStatus.Completed);
		});

		it('steering request resolves only after the original request completes', async () => {
			let resolveFirstSend!: () => void;
			let sendCallCount = 0;
			let firstRequestDone = false;
			sdkSession.send = async (options: any) => {
				sendCallCount++;
				sdkSession.lastSendOptions = options;
				if (sendCallCount === 1) {
					await new Promise<void>(r => { resolveFirstSend = r; });
					firstRequestDone = true;
				}
				sdkSession.emit('assistant.turn_start', {});
				sdkSession.emit('assistant.message', { content: `Echo: ${options.prompt}` });
				sdkSession.emit('assistant.turn_end', {});
			};

			const session = await createSession();
			const stream = new MockChatResponseStream();
			session.attachStream(stream);

			const firstRequest = session.handleRequest(
				{ id: 'req-1', toolInvocationToken: undefined as never },
				{ prompt: 'First' }, [], undefined, authInfo, CancellationToken.None
			);
			await new Promise(r => setTimeout(r, 10));

			let steeringDone = false;
			const steeringRequest = session.handleRequest(
				{ id: 'req-2', toolInvocationToken: undefined as never },
				{ prompt: 'Steer' }, [], undefined, authInfo, CancellationToken.None
			).then(() => { steeringDone = true; });
			await new Promise(r => setTimeout(r, 10));

			// Steering should not have resolved yet because first request is blocked
			expect(steeringDone).toBe(false);
			expect(firstRequestDone).toBe(false);

			// Unblock first request
			resolveFirstSend();
			await Promise.all([firstRequest, steeringRequest]);

			// Both should be done now
			expect(steeringDone).toBe(true);
			expect(firstRequestDone).toBe(true);
		});
	});
});
