/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Session, SessionOptions } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatParticipantToolToken, LanguageModelToolInvocationOptions, LanguageModelToolResult2 } from 'vscode';
import { ILogService } from '../../../../../platform/log/common/logService';
import { TestWorkspaceService } from '../../../../../platform/test/node/testWorkspaceService';
import { IWorkspaceService } from '../../../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../../util/vs/base/common/lifecycle';
import * as path from '../../../../../util/vs/base/common/path';
import { ChatSessionStatus, LanguageModelTextPart, Uri } from '../../../../../vscodeTypes';
import { createExtensionUnitTestingServices } from '../../../../test/node/services';
import { MockChatResponseStream } from '../../../../test/node/testHelpers';
import { IToolsService, NullToolsService } from '../../../../tools/common/toolsService';
import { ExternalEditTracker } from '../../../common/externalEditTracker';
import { CopilotCLIPermissionsHandler, ICopilotCLISessionOptionsService } from '../copilotCli';
import { CopilotCLISession } from '../copilotcliSession';
import { CopilotCLIToolNames } from '../copilotcliToolInvocationFormatter';

// Minimal shapes for types coming from the Copilot SDK we interact with
interface MockSdkEventHandler { (payload: unknown): void }
type MockSdkEventMap = Map<string, Set<MockSdkEventHandler>>;

class MockSdkSession {
	onHandlers: MockSdkEventMap = new Map();
	public sessionId = 'mock-session-id';
	public _selectedModel: string | undefined = 'modelA';
	public authInfo: any;

	on(event: string, handler: MockSdkEventHandler) {
		if (!this.onHandlers.has(event)) {
			this.onHandlers.set(event, new Set());
		}
		this.onHandlers.get(event)!.add(handler);
		return () => this.onHandlers.get(event)!.delete(handler);
	}

	emit(event: string, data: any) {
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

// Mocks for services
function createSessionOptionsService() {
	const auth: Partial<ICopilotCLISessionOptionsService> = {
		createOptions: async () => {
			return {
				authInfo: {
					token: 'copilot-token',
					tokenType: 'test',
					expiresAt: Date.now() + 60_000,
					copilotPlan: 'pro'
				}
			} as unknown as SessionOptions;
		}
	};
	return auth as ICopilotCLISessionOptionsService;
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
function createToolsService(invocationBehavior: { approve: boolean; throws?: boolean } | undefined, logger: ILogService,): IToolsService {
	return new class extends NullToolsService {
		override invokeTool = vi.fn(async (_tool: string, _options: LanguageModelToolInvocationOptions<Object>, _token: CancellationToken): Promise<LanguageModelToolResult2> => {
			if (invocationBehavior?.throws) {
				throw new Error('tool failed');
			}
			return {
				content: [new LanguageModelTextPart(invocationBehavior?.approve ? 'yes' : 'no')]
			};
		});
	}(logger);
}


describe('CopilotCLISession', () => {
	const invocationToken: ChatParticipantToolToken = {} as never;
	const disposables = new DisposableStore();
	let sdkSession: MockSdkSession;
	let permissionHandler: CopilotCLIPermissionsHandler;
	let workspaceService: IWorkspaceService;
	let toolsService: IToolsService;
	let logger: ILogService;
	let sessionOptionsService: ICopilotCLISessionOptionsService;

	beforeEach(() => {
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		logger = accessor.get(ILogService);

		sdkSession = new MockSdkSession();
		permissionHandler = new CopilotCLIPermissionsHandler();
		sessionOptionsService = createSessionOptionsService();
		workspaceService = createWorkspaceService('/workspace');
		toolsService = createToolsService({ approve: true }, logger);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		disposables.clear();
	});


	function createSession() {
		return disposables.add(new CopilotCLISession(
			sdkSession as unknown as Session,
			{} as unknown as SessionOptions,
			permissionHandler,
			logger,
			workspaceService,
			toolsService,
			sessionOptionsService,
		));
	}

	it('handles a successful request and streams assistant output', async () => {
		const session = createSession();
		const stream = new MockChatResponseStream();

		await session.handleRequest('Hello', [], undefined, stream, invocationToken, CancellationToken.None);

		expect(session.status).toBe(ChatSessionStatus.Completed);
		expect(stream.output.join('\n')).toContain('Echo: Hello');
		// Listeners are disposed after completion, so we only assert original streamed content.
	});

	it('switches model when different modelId provided', async () => {
		const session = createSession();
		const stream = new MockChatResponseStream();

		await session.handleRequest('Hi', [], 'modelB', stream, invocationToken, CancellationToken.None);

		expect(sdkSession._selectedModel).toBe('modelB');
	});

	it('fails request when underlying send throws', async () => {
		// Force send to throw
		sdkSession.send = async () => { throw new Error('network'); };
		const session = createSession();
		const stream = new MockChatResponseStream();

		await session.handleRequest('Boom', [], undefined, stream, invocationToken, CancellationToken.None);

		expect(session.status).toBe(ChatSessionStatus.Failed);
		expect(stream.output.join('\n')).toContain('Error: network');
	});

	it('emits status events on successful request', async () => {
		const session = createSession();
		const statuses: (ChatSessionStatus | undefined)[] = [];
		const listener = disposables.add(session.onDidChangeStatus(s => statuses.push(s)));
		const stream = new MockChatResponseStream();

		await session.handleRequest('Status OK', [], 'modelA', stream, invocationToken, CancellationToken.None);
		listener.dispose?.();

		expect(statuses).toEqual([ChatSessionStatus.InProgress, ChatSessionStatus.Completed]);
		expect(session.status).toBe(ChatSessionStatus.Completed);
	});

	it('emits status events on failed request', async () => {
		// Force failure
		sdkSession.send = async () => { throw new Error('boom'); };
		const session = createSession();
		const statuses: (ChatSessionStatus | undefined)[] = [];
		const listener = disposables.add(session.onDidChangeStatus(s => statuses.push(s)));
		const stream = new MockChatResponseStream();

		await session.handleRequest('Will Fail', [], undefined, stream, invocationToken, CancellationToken.None);
		listener.dispose?.();

		expect(statuses).toEqual([ChatSessionStatus.InProgress, ChatSessionStatus.Failed]);
		expect(session.status).toBe(ChatSessionStatus.Failed);
		expect(stream.output.join('\n')).toContain('Error: boom');
	});

	it('auto-approves read permission inside workspace without invoking tool', async () => {
		// Keep session active while requesting permission
		let resolveSend: () => void;
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const session = createSession();
		const stream = new MockChatResponseStream();
		const handlePromise = session.handleRequest('Test', [], undefined, stream, invocationToken, CancellationToken.None);

		// Path must be absolute within workspace
		const result = await permissionHandler.getPermissions({ kind: 'read', path: path.join('/workspace', 'file.ts'), intention: 'Read file' });
		resolveSend!();
		await handlePromise;
		expect(result).toEqual({ kind: 'approved' });
		expect(toolsService.invokeTool).not.toHaveBeenCalled();
	});

	it('prompts for write permission and approves when tool returns yes', async () => {
		toolsService = createToolsService({ approve: true }, logger);
		const session = createSession();
		let resolveSend: () => void;
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const stream = new MockChatResponseStream();
		const handlePromise = session.handleRequest('Write', [], undefined, stream, invocationToken, CancellationToken.None);

		const result = await permissionHandler.getPermissions({ kind: 'write', fileName: 'a.ts', intention: 'Update file', diff: '' });
		resolveSend!();
		await handlePromise;
		expect(toolsService.invokeTool).toHaveBeenCalled();
		expect(result).toEqual({ kind: 'approved' });
	});

	it('denies write permission when tool returns no', async () => {
		toolsService = createToolsService({ approve: false }, logger);
		const session = createSession();
		let resolveSend: () => void;
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const stream = new MockChatResponseStream();
		const handlePromise = session.handleRequest('Write', [], undefined, stream, invocationToken, CancellationToken.None);

		const result = await permissionHandler.getPermissions({ kind: 'write', fileName: 'b.ts', intention: 'Update file', diff: '' });
		resolveSend!();
		await handlePromise;
		expect(toolsService.invokeTool).toHaveBeenCalled();
		expect(result).toEqual({ kind: 'denied-interactively-by-user' });
	});

	it('denies permission when tool invocation throws', async () => {
		toolsService = createToolsService({ approve: true, throws: true }, logger);
		const session = createSession();
		let resolveSend: () => void;
		sdkSession.send = async ({ prompt }: any) => new Promise<void>(r => { resolveSend = r; }).then(() => {
			sdkSession.emit('assistant.turn_start', {});
			sdkSession.emit('assistant.message', { content: `Echo: ${prompt}` });
			sdkSession.emit('assistant.turn_end', {});
		});
		const stream = new MockChatResponseStream();
		const handlePromise = session.handleRequest('Write', [], undefined, stream, invocationToken, CancellationToken.None);

		const result = await permissionHandler.getPermissions({ kind: 'write', fileName: 'err.ts', intention: 'Update file', diff: '' });
		resolveSend!();
		await handlePromise;
		expect(toolsService.invokeTool).toHaveBeenCalled();
		expect(result).toEqual({ kind: 'denied-interactively-by-user' });
	});

	it('preserves order of edit toolCallIds and permissions for multiple pending edits', async () => {
		// Arrange a deferred send so we can emit tool events before request finishes
		let resolveSend: () => void;
		sdkSession.send = async () => new Promise<void>(r => { resolveSend = r; });
		// Use approval for write permissions
		toolsService = createToolsService({ approve: true }, logger);
		const session = createSession();
		const stream = new MockChatResponseStream();

		// Spy on trackEdit to capture ordering (we don't want to depend on externalEdit mechanics here)
		const trackedOrder: string[] = [];
		const trackSpy = vi.spyOn(ExternalEditTracker.prototype, 'trackEdit').mockImplementation(async function (this: any, editKey: string) {
			trackedOrder.push(editKey);
			// Immediately resolve to avoid hanging on externalEdit lifecycle
			return Promise.resolve();
		});

		// Act: start handling request (do not await yet)
		const requestPromise = session.handleRequest('Edits', [], undefined, stream, invocationToken, CancellationToken.None);

		// Wait a tick to ensure event listeners are registered inside handleRequest
		await new Promise(r => setTimeout(r, 0));

		// Emit 10 edit tool start events in rapid succession for the same file
		const filePath = '/workspace/abc.py';
		for (let i = 1; i <= 10; i++) {
			sdkSession.emit('tool.execution_start', {
				toolCallId: String(i),
				toolName: CopilotCLIToolNames.StrReplaceEditor,
				arguments: { command: 'str_replace', path: filePath }
			});
		}

		// Now request permissions sequentially AFTER all tool calls have been emitted
		const permissionResults: any[] = [];
		for (let i = 1; i <= 10; i++) {
			// Each permission request should dequeue the next toolCallId for the file
			const result = await permissionHandler.getPermissions({
				kind: 'write',
				fileName: filePath,
				intention: 'Apply edit',
				diff: ''
			});
			permissionResults.push(result);
			// Complete the edit so the tracker (if it were real) would finish; emit completion event
			sdkSession.emit('tool.execution_complete', {
				toolCallId: String(i),
				toolName: CopilotCLIToolNames.StrReplaceEditor,
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
