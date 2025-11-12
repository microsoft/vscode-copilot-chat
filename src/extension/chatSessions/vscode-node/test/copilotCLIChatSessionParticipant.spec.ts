/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Attachment } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { MockRunCommandExecutionService } from '../../../../platform/commands/common/mockRunCommandExecutionService';
import { IRunCommandExecutionService } from '../../../../platform/commands/common/runCommandExecutionService';
import { NullNativeEnvService } from '../../../../platform/env/common/nullEnvService';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { IGitService } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import type { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IWorkspaceService, NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IInstantiationService, ServicesAccessor } from '../../../../util/vs/platform/instantiation/common/instantiation';
import type { ICopilotCLIModels, ICopilotCLISDK } from '../../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../../agents/copilotcli/node/copilotcliPromptResolver';
import { CopilotCLISession } from '../../../agents/copilotcli/node/copilotcliSession';
import { CopilotCLISessionService } from '../../../agents/copilotcli/node/copilotcliSessionService';
import { ICopilotCLIMCPHandler } from '../../../agents/copilotcli/node/mcpHandler';
import { MockCliSdkSession, MockCliSdkSessionManager } from '../../../agents/copilotcli/node/test/copilotCliSessionService.spec';
import { ChatSummarizerProvider } from '../../../prompt/node/summarizer';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { MockChatResponseStream, TestChatRequest } from '../../../test/node/testHelpers';
import type { IToolsService } from '../../../tools/common/toolsService';
import { CopilotCLIChatSessionItemProvider, CopilotCLIChatSessionParticipant, CopilotCLIWorktreeManager } from '../copilotCLIChatSessionsContribution';
import { CopilotCloudSessionsProvider } from '../copilotCloudSessionsProvider';
// Mock terminal integration to avoid importing PowerShell asset (.ps1) which Vite cannot parse during tests
vi.mock('../copilotCLITerminalIntegration', () => {
	// Minimal stand-in for createServiceIdentifier
	const createServiceIdentifier = (name: string) => {
		const fn: any = () => { /* decorator no-op */ };
		fn.toString = () => name;
		return fn;
	};
	class CopilotCLITerminalIntegration {
		dispose() { }
		openTerminal = vi.fn(async () => { });
	}
	return {
		ICopilotCLITerminalIntegration: createServiceIdentifier('ICopilotCLITerminalIntegration'),
		CopilotCLITerminalIntegration
	};
});

class FakeWorktreeManager extends mock<CopilotCLIWorktreeManager>() {
	override createWorktree = vi.fn(async () => undefined);
	override storeWorktreePath = vi.fn(async () => { });
	override getWorktreePath = vi.fn((_id: string) => undefined);
	override getIsolationPreference = vi.fn(() => false);
}

class FakeModels implements ICopilotCLIModels {
	_serviceBrand: undefined;
	getDefaultModel = vi.fn(async () => ({ id: 'base', name: 'Base' }));
	getAvailableModels = vi.fn(async () => [{ id: 'base', name: 'Base' }]);
	setDefaultModel = vi.fn(async () => { });
	toModelProvider = vi.fn((id: string) => id); // passthrough
}

class FakeGitService extends mock<IGitService>() {
	override activeRepository = { get: () => undefined } as unknown as IGitService['activeRepository'];
}

// Cloud provider fake for delegate scenario
class FakeCloudProvider extends mock<CopilotCloudSessionsProvider>() {
	override tryHandleUncommittedChanges = vi.fn(async () => false);
	override createDelegatedChatSession = vi.fn(async () => ({ uri: 'pr://1', title: 'PR Title', description: 'Desc', author: 'Me', linkTag: 'tag' })) as unknown as CopilotCloudSessionsProvider['createDelegatedChatSession'];
}


function createChatContext(sessionId: string, isUntitled: boolean): vscode.ChatContext {
	return {
		chatSessionContext: {
			chatSessionItem: { resource: vscode.Uri.from({ scheme: 'copilotcli', path: `/${sessionId}` }), label: 'temp' } as vscode.ChatSessionItem,
			isUntitled
		} as vscode.ChatSessionContext,
		chatSummary: undefined
	} as vscode.ChatContext;
}

class TestCopilotCLISession extends CopilotCLISession {
	public requests: Array<{ prompt: string; attachments: Attachment[]; modelId: string | undefined; token: vscode.CancellationToken }> = [];
	override handleRequest(prompt: string, attachments: Attachment[], modelId: string | undefined, token: vscode.CancellationToken): Promise<void> {
		this.requests.push({ prompt, attachments, modelId, token });
		return Promise.resolve();
	}
}


describe('CopilotCLIChatSessionParticipant.handleRequest', () => {
	const disposables = new DisposableStore();
	let promptResolver: CopilotCLIPromptResolver;
	let itemProvider: CopilotCLIChatSessionItemProvider;
	let cloudProvider: FakeCloudProvider;
	let summarizer: ChatSummarizerProvider;
	let worktree: FakeWorktreeManager;
	let git: FakeGitService;
	let models: FakeModels;
	let sessionService: CopilotCLISessionService;
	let telemetry: ITelemetryService;
	let tools: IToolsService;
	let participant: CopilotCLIChatSessionParticipant;
	let commandExecutionService: IRunCommandExecutionService;
	let workspaceService: IWorkspaceService;
	let instantiationService: IInstantiationService;
	let manager: MockCliSdkSessionManager;
	let mcpHandler: ICopilotCLIMCPHandler;
	const cliSessions: TestCopilotCLISession[] = [];

	beforeEach(async () => {
		cliSessions.length = 0;
		const sdk = {
			getPackage: vi.fn(async () => ({ internal: { CLISessionManager: MockCliSdkSessionManager } }))
		} as unknown as ICopilotCLISDK;
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		promptResolver = new class extends mock<CopilotCLIPromptResolver>() {
			override resolvePrompt(request: vscode.ChatRequest) {
				return Promise.resolve({ prompt: request.prompt, attachments: [] });
			}
		}();
		itemProvider = new class extends mock<CopilotCLIChatSessionItemProvider>() {
			override swap = vi.fn();
		}();
		cloudProvider = new FakeCloudProvider();
		summarizer = new class extends mock<ChatSummarizerProvider>() {
			override provideChatSummary(_context: vscode.ChatContext) { return Promise.resolve('summary text'); }
		}();
		worktree = new FakeWorktreeManager();
		git = new FakeGitService();
		models = new FakeModels();
		telemetry = new NullTelemetryService();
		tools = new class FakeToolsService extends mock<IToolsService>() { }();
		workspaceService = new NullWorkspaceService();
		commandExecutionService = new MockRunCommandExecutionService();
		const authService = new class extends mock<IAuthenticationService>() { }();
		const logService = accessor.get(ILogService);
		const gitService = accessor.get(IGitService);
		mcpHandler = new class extends mock<ICopilotCLIMCPHandler>() {
			override async loadMcpConfig(_workingDirectory: string | undefined) {
				return undefined;
			}
		}();
		instantiationService = {
			invokeFunction<R, TS extends any[] = []>(fn: (accessor: ServicesAccessor, ...args: TS) => R, ...args: TS): R {
				return fn(accessor, ...args);
			},
			createInstance: (_ctor: unknown, options: any, sdkSession: any) => {
				const session = new TestCopilotCLISession(options, sdkSession, gitService, logService, workspaceService, authService, instantiationService);
				cliSessions.push(session);
				return disposables.add(session);
			}
		} as unknown as IInstantiationService;
		sessionService = disposables.add(new CopilotCLISessionService(logService, sdk, instantiationService, new NullNativeEnvService(), new MockFileSystemService(), mcpHandler));

		manager = await sessionService.getSessionManager() as unknown as MockCliSdkSessionManager;

		participant = new CopilotCLIChatSessionParticipant(
			promptResolver,
			itemProvider,
			cloudProvider,
			summarizer,
			worktree,
			git,
			models,
			sessionService,
			telemetry,
			tools,
			commandExecutionService,
			workspaceService,
			instantiationService
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		disposables.clear();
	});

	it('creates new session for untitled context and invokes request', async () => {
		const request = new TestChatRequest('Say hi');
		const context = createChatContext('temp-new', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		expect(cliSessions.length).toBe(0);

		await participant.createHandler()(request, context, stream, token);

		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0]).toEqual({ prompt: 'Say hi', attachments: [], modelId: 'base', token });
	});

	it('reuses existing session (non-untitled) and does not create new one', async () => {
		const sessionId = 'existing-123';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);

		const request = new TestChatRequest('Continue');
		const context = createChatContext(sessionId, false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		expect(cliSessions.length).toBe(0);

		await participant.createHandler()(request, context, stream, token);

		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].sessionId).toBe(sessionId);
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0]).toEqual({ prompt: 'Continue', attachments: [], modelId: 'base', token });

		expect(itemProvider.swap).not.toHaveBeenCalled();
	});

	it('handles /delegate command for existing session (no session.handleRequest)', async () => {
		const sessionId = 'existing-123';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);

		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }] } }) } as unknown as IGitService['activeRepository'];
		const request = new TestChatRequest('/delegate Build feature');
		const context = createChatContext(sessionId, false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		expect(cliSessions.length).toBe(0);

		await participant.createHandler()(request, context, stream, token);

		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].sessionId).toBe(sessionId);
		expect(cliSessions[0].requests.length).toBe(0);
		expect(sdkSession.emittedEvents.length).toBe(2);
		expect(sdkSession.emittedEvents[0].event).toBe('user.message');
		expect(sdkSession.emittedEvents[0].content).toBe('/delegate Build feature');
		expect(sdkSession.emittedEvents[1].event).toBe('assistant.message');
		expect(sdkSession.emittedEvents[1].content).toContain('pr://1');
		// Uncommitted changes warning surfaced
		// Warning should appear (we emitted stream.warning). The mock stream only records markdown.
		// Delegate path adds assistant PR metadata; ensure output contains PR metadata tag instead of relying on warning capture.
		expect(sdkSession.emittedEvents[1].content).toMatch(/<pr_metadata uri="pr:\/\/1"/);
		expect(cloudProvider.tryHandleUncommittedChanges).toHaveBeenCalled();
		expect(cloudProvider.createDelegatedChatSession).toHaveBeenCalled();
	});

	it('handles /delegate command for new session', async () => {
		expect(manager.sessions.size).toBe(0);
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }] } }) } as unknown as IGitService['activeRepository'];
		const request = new TestChatRequest('/delegate Build feature');
		const context = createChatContext('existing-delegate', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		expect(manager.sessions.size).toBe(1);
		const sdkSession = Array.from(manager.sessions.values())[0];
		expect(cloudProvider.tryHandleUncommittedChanges).toHaveBeenCalled();
		expect(cloudProvider.createDelegatedChatSession).toHaveBeenCalled();
		// PR metadata recorded
		expect(sdkSession.emittedEvents.length).toBe(2);
		expect(sdkSession.emittedEvents[0].event).toBe('user.message');
		expect(sdkSession.emittedEvents[0].content).toBe('/delegate Build feature');
		expect(sdkSession.emittedEvents[1].event).toBe('assistant.message');
		expect(sdkSession.emittedEvents[1].content).toContain('pr://1');
		// Warning should appear (we emitted stream.warning). The mock stream only records markdown.
		// Delegate path adds assistant PR metadata; ensure output contains PR metadata tag instead of relying on warning capture.
		expect(sdkSession.emittedEvents[1].content).toMatch(/<pr_metadata uri="pr:\/\/1"/);
	});

	it('invokes handlePushConfirmationData without existing chatSessionContext (summary via summarizer)', async () => {
		const request = new TestChatRequest('Push this');
		const context = { chatSessionContext: undefined, chatSummary: undefined } as unknown as vscode.ChatContext;
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		const summarySpy = vi.spyOn(summarizer, 'provideChatSummary');
		const execSpy = vi.spyOn(commandExecutionService, 'executeCommand');

		await participant.createHandler()(request, context, stream, token);

		expect(manager.sessions.size).toBe(1);
		const sessionId = Array.from(manager.sessions.keys())[0];
		const expectedPrompt = 'Push this\n**Summary**\nsummary text';
		expect(summarySpy).toHaveBeenCalledTimes(1);
		expect(execSpy).toHaveBeenCalledTimes(2);
		expect(execSpy.mock.calls[0]).toEqual(['vscode.open', expect.any(Object)]);
		expect(String(execSpy.mock.calls[0].at(1))).toContain(`copilotcli:/${sessionId}`);
		expect(execSpy.mock.calls[1]).toEqual(['workbench.action.chat.submit', { inputValue: expectedPrompt }]);
	});
	it('invokes handlePushConfirmationData using existing chatSummary and skips summarizer', async () => {
		const request = new TestChatRequest('Push that');
		const context = { chatSessionContext: undefined, chatSummary: { history: 'precomputed history' } } as unknown as vscode.ChatContext;
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		const summarySpy = vi.spyOn(summarizer, 'provideChatSummary');
		const execSpy = vi.spyOn(commandExecutionService, 'executeCommand');

		await participant.createHandler()(request, context, stream, token);

		expect(manager.sessions.size).toBe(1);
		const expectedPrompt = 'Push that\n**Summary**\nprecomputed history';
		expect(summarySpy).not.toHaveBeenCalled();
		expect(execSpy).toHaveBeenCalledTimes(2);
		expect(execSpy.mock.calls[0].at(0)).toBe('vscode.open');
		expect(execSpy.mock.calls[1]).toEqual(['workbench.action.chat.submit', { inputValue: expectedPrompt }]);
	});

	it('handleConfirmationData accepts uncommitted-changes and records push', async () => {
		// Existing session (non-untitled) so confirmation path is hit
		const sessionId = 'existing-confirm';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);
		const request = new TestChatRequest('Apply');
		(request as any).acceptedConfirmationData = [{ step: 'uncommitted-changes', metadata: { prompt: 'delegate work', history: 'hist' } }];
		const context = createChatContext(sessionId, false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		// Cloud provider will create delegated chat session returning prInfo
		(cloudProvider.createDelegatedChatSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ uri: 'pr://2', title: 'T', description: 'D', author: 'A', linkTag: 'L' });

		await participant.createHandler()(request, context, stream, token);

		// Should NOT call session.handleRequest, instead record push messages
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(0);
		expect(sdkSession.emittedEvents.length).toBe(2);
		expect(sdkSession.emittedEvents[0].event).toBe('user.message');
		expect(sdkSession.emittedEvents[1].event).toBe('assistant.message');
		expect(sdkSession.emittedEvents[1].content).toContain('pr://2');
		// Cloud provider used with provided metadata
		expect(cloudProvider.createDelegatedChatSession).toHaveBeenCalledWith({ prompt: 'delegate work', history: 'hist', chatContext: context }, expect.anything(), token);
	});

	it('handleConfirmationData cancels when uncommitted-changes rejected', async () => {
		const sessionId = 'existing-confirm-reject';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);
		const request = new TestChatRequest('Apply');
		(request as any).rejectedConfirmationData = [{ step: 'uncommitted-changes', metadata: { prompt: 'delegate work', history: 'hist' } }];
		const context = createChatContext(sessionId, false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should not record push or call delegate session
		expect(sdkSession.emittedEvents.length).toBe(0);
		expect(cloudProvider.createDelegatedChatSession).not.toHaveBeenCalled();
		// Cancellation message markdown captured
		expect(stream.output.some(o => /Cloud agent delegation request cancelled/i.test(o))).toBe(true);
	});

	it('handleConfirmationData unknown step warns and skips', async () => {
		const sessionId = 'existing-confirm-unknown';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);
		const request = new TestChatRequest('Apply');
		(request as any).acceptedConfirmationData = [{ step: 'mystery-step', metadata: {} }];
		const context = createChatContext(sessionId, false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// No events are emitted
		expect(sdkSession.emittedEvents.length).toBe(0);
	});
});
