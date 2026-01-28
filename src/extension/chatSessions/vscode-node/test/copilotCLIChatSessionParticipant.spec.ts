/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Attachment } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { NullNativeEnvService } from '../../../../platform/env/common/nullEnvService';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { IGitService, RepoContext } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { PromptsServiceImpl } from '../../../../platform/promptFiles/common/promptsServiceImpl';
import { NullRequestLogger } from '../../../../platform/requestLogger/node/nullRequestLogger';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import type { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IWorkspaceService, NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { sep } from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService, ServicesAccessor } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatResponseConfirmationPart } from '../../../../vscodeTypes';
import { IChatDelegationSummaryService } from '../../../agents/copilotcli/common/delegationSummaryService';
import { type ICopilotCLIModels, type ICopilotCLISDK } from '../../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../../agents/copilotcli/node/copilotcliPromptResolver';
import { CopilotCLISession } from '../../../agents/copilotcli/node/copilotcliSession';
import { CopilotCLISessionService, CopilotCLISessionWorkspaceTracker } from '../../../agents/copilotcli/node/copilotcliSessionService';
import { ICopilotCLIMCPHandler } from '../../../agents/copilotcli/node/mcpHandler';
import { MockCliSdkSession, MockCliSdkSessionManager, NullCopilotCLIAgents } from '../../../agents/copilotcli/node/test/copilotCliSessionService.spec';
import { ChatSummarizerProvider } from '../../../prompt/node/summarizer';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { MockChatResponseStream, TestChatRequest } from '../../../test/node/testHelpers';
import type { IToolsService } from '../../../tools/common/toolsService';
import { mockLanguageModelChat } from '../../../tools/node/test/searchToolTestUtils';
import { IChatSessionWorkspaceFolderService } from '../../common/chatSessionWorkspaceFolderService';
import { IChatSessionWorktreeService, type ChatSessionWorktreeProperties } from '../../common/chatSessionWorktreeService';
import { CopilotCLIChatSessionContentProvider, CopilotCLIChatSessionItemProvider, CopilotCLIChatSessionParticipant } from '../copilotCLIChatSessionsContribution';
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

class FakeChatSessionWorkspaceFolderService extends mock<IChatSessionWorkspaceFolderService>() {
	private _sessionWorkspaceFolders = new Map<string, vscode.Uri>();
	override trackSessionWorkspaceFolder = vi.fn(async (sessionId: string, workspaceFolderUri: string) => {
		this._sessionWorkspaceFolders.set(sessionId, vscode.Uri.file(workspaceFolderUri));
	});
	override deleteTrackedWorkspaceFolder = vi.fn(async (sessionId: string) => {
		this._sessionWorkspaceFolders.delete(sessionId);
	});
	override getSessionWorkspaceFolder = vi.fn((sessionId: string) => {
		return this._sessionWorkspaceFolders.get(sessionId);
	});
}

class FakeChatSessionWorktreeService extends mock<IChatSessionWorktreeService>() {
	constructor() {
		super();
	}
	override createWorktree = vi.fn(async () => undefined) as unknown as IChatSessionWorktreeService['createWorktree'];
	override getWorktreeProperties = vi.fn((_id: string) => undefined);
	override setWorktreeProperties = vi.fn(async () => { });
	override getWorktreePath = vi.fn((_id: string) => undefined);
	override handleRequestCompleted = vi.fn(async () => { });
	override getWorktreeRepository(sessionId: string): Promise<RepoContext | undefined> {
		return Promise.resolve(undefined);
	}
}

class FakeModels implements ICopilotCLIModels {
	_serviceBrand: undefined;
	resolveModel = vi.fn(async (modelId: string) => modelId);
	getDefaultModel = vi.fn(async () => 'base');
	getModels = vi.fn(async () => [{ id: 'base', name: 'Base' }]);
	setDefaultModel = vi.fn(async () => { });
	toModelProvider = vi.fn((id: string) => id); // passthrough
}

class FakeGitService extends mock<IGitService>() {
	override activeRepository = { get: () => undefined } as unknown as IGitService['activeRepository'];
	override repositories: RepoContext[] = [];
	setRepo(repos: RepoContext) {
		this.repositories = [repos];
	}
	override async getRepository(uri: URI, forceOpen?: boolean): Promise<RepoContext | undefined> {
		if (this.repositories.length === 1) {
			return Promise.resolve(this.repositories[0]);
		}
		return undefined;
	}
}

// Cloud provider fake for delegate scenario
class FakeCloudProvider extends mock<CopilotCloudSessionsProvider>() {
	override delegate = vi.fn(async () => ({
		uri: vscode.Uri.parse('pr://1'),
		title: 'PR Title',
		description: 'PR Description',
		author: 'Test Author',
		linkTag: '#1'
	})) as unknown as CopilotCloudSessionsProvider['delegate'];
}


function createChatContext(sessionId: string, isUntitled: boolean): vscode.ChatContext {
	return {
		chatSessionContext: {
			chatSessionItem: { resource: vscode.Uri.from({ scheme: 'copilotcli', path: `/${sessionId}` }), label: 'temp' } as vscode.ChatSessionItem,
			isUntitled
		} as vscode.ChatSessionContext,
	} as vscode.ChatContext;
}

class TestCopilotCLISession extends CopilotCLISession {
	public requests: Array<{ prompt: string; attachments: Attachment[]; modelId: string | undefined; token: vscode.CancellationToken }> = [];
	override handleRequest(requestId: string, prompt: string, attachments: Attachment[], modelId: string | undefined, token: vscode.CancellationToken): Promise<void> {
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
	let worktree: FakeChatSessionWorktreeService;
	let workspaceFolderService: FakeChatSessionWorkspaceFolderService;
	let git: FakeGitService;
	let models: FakeModels;
	let sessionService: CopilotCLISessionService;
	let telemetry: ITelemetryService;
	let tools: IToolsService;
	let participant: CopilotCLIChatSessionParticipant;
	let workspaceService: IWorkspaceService;
	let instantiationService: IInstantiationService;
	let manager: MockCliSdkSessionManager;
	let mcpHandler: ICopilotCLIMCPHandler;
	const cliSessions: TestCopilotCLISession[] = [];

	beforeEach(async () => {
		cliSessions.length = 0;
		const sdk = {
			getPackage: vi.fn(async () => ({ internal: { LocalSessionManager: MockCliSdkSessionManager } }))
		} as unknown as ICopilotCLISDK;
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		promptResolver = new class extends mock<CopilotCLIPromptResolver>() {
			override resolvePrompt = vi.fn(async (request: vscode.ChatRequest, prompt: string | undefined) => {
				return { prompt: prompt ?? request.prompt, attachments: [], references: [] };
			});
		}();
		itemProvider = new class extends mock<CopilotCLIChatSessionItemProvider>() {
			override swap = vi.fn();
			override notifySessionsChange = vi.fn();
		}();
		cloudProvider = new FakeCloudProvider();
		summarizer = new class extends mock<ChatSummarizerProvider>() {
			override provideChatSummary(_context: vscode.ChatContext) { return Promise.resolve('summary text'); }
		}();
		worktree = new FakeChatSessionWorktreeService();
		workspaceFolderService = new FakeChatSessionWorkspaceFolderService();
		git = new FakeGitService();
		models = new FakeModels();
		telemetry = new NullTelemetryService();
		tools = new class FakeToolsService extends mock<IToolsService>() { }();
		workspaceService = new NullWorkspaceService([URI.file('/workspace')]);
		const logger = accessor.get(ILogService);
		const logService = accessor.get(ILogService);
		mcpHandler = new class extends mock<ICopilotCLIMCPHandler>() {
			override loadMcpConfig = vi.fn(async () => {
				return undefined;
			});
		}();
		const delegationService = new class extends mock<IChatDelegationSummaryService>() {
			override async summarize(context: vscode.ChatContext, token: vscode.CancellationToken): Promise<string | undefined> {
				return undefined;
			}
		}();
		instantiationService = {
			invokeFunction<R, TS extends any[] = []>(fn: (accessor: ServicesAccessor, ...args: TS) => R, ...args: TS): R {
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
				const session = new TestCopilotCLISession(options, sdkSession, logService, workspaceService, sdk, instantiationService, delegationService, new NullRequestLogger());
				cliSessions.push(session);
				return disposables.add(session);
			}
		} as unknown as IInstantiationService;
		sessionService = disposables.add(new CopilotCLISessionService(logService, sdk, instantiationService, new NullNativeEnvService(), new MockFileSystemService(), mcpHandler, new NullCopilotCLIAgents(), workspaceService));

		manager = await sessionService.getSessionManager() as unknown as MockCliSdkSessionManager;
		const contentProvider = new class extends mock<CopilotCLIChatSessionContentProvider>() {
			override notifySessionOptionsChange(_resource: vscode.Uri, _updates: ReadonlyArray<{ optionId: string; value: string }>): void {
				// no-op
			}
		}();
		participant = new CopilotCLIChatSessionParticipant(
			contentProvider,
			promptResolver,
			itemProvider,
			cloudProvider,
			git,
			models,
			new NullCopilotCLIAgents(),
			sessionService,
			worktree,
			workspaceFolderService,
			telemetry,
			tools,
			instantiationService,
			logger,
			new PromptsServiceImpl(new NullWorkspaceService()),
			delegationService,
			workspaceService,
			new MockFileSystemService()
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

	it('uses worktree workingDirectory when isolation is enabled for a new untitled session', async () => {
		workspaceFolderService.trackSessionWorkspaceFolder('temp-new', Uri.file(`${sep}repo`).fsPath);
		git.setRepo(({ rootUri: Uri.file(`${sep}repo`) } as RepoContext));
		(worktree.createWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
			autoCommit: true,
			baseCommit: 'deadbeef',
			branchName: 'test',
			repositoryPath: `${sep}repo`,
			worktreePath: `${sep}worktree`
		} satisfies ChatSessionWorktreeProperties);

		const request = new TestChatRequest('Say hi');
		const context = createChatContext('temp-new', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].options.isolationEnabled).toBe(true);
		expect(cliSessions[0].options.workingDirectory?.fsPath).toBe(`${sep}worktree`);
		expect(mcpHandler.loadMcpConfig).toHaveBeenCalled();
		// Prompt resolver should receive the effective workingDirectory.
		expect(promptResolver.resolvePrompt).toHaveBeenCalled();
		expect((promptResolver.resolvePrompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0][4]?.fsPath).toBe(`${sep}worktree`);
	});

	it('falls back to workspace workingDirectory when isolation is enabled but worktree creation fails', async () => {
		(worktree.createWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
		workspaceFolderService.trackSessionWorkspaceFolder('temp-new', Uri.file(`${sep}workspace`).fsPath);
		const request = new TestChatRequest('Say hi');
		const context = createChatContext('temp-new', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].options.isolationEnabled).toBe(false);
		expect(cliSessions[0].options.workingDirectory?.fsPath).toBe(`${sep}workspace`);
		expect(mcpHandler.loadMcpConfig).toHaveBeenCalled();
		// Prompt resolver should receive the effective workingDirectory.
		expect(promptResolver.resolvePrompt).toHaveBeenCalled();
		expect((promptResolver.resolvePrompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0][4]?.fsPath).toBe(`${sep}workspace`);
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
		expect(cloudProvider.delegate).toHaveBeenCalled();
	});

	it('handles /delegate command from another chat (has worktree support)', async () => {
		expect(manager.sessions.size).toBe(0);
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }] } }) } as unknown as IGitService['activeRepository'];
		const request = new TestChatRequest('/delegate Build feature');
		const context = { chatSessionContext: undefined } as vscode.ChatContext;
		const parts: vscode.ExtendedChatResponsePart[] = [];
		const stream = new MockChatResponseStream((part) => parts.push(part));
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		expect(manager.sessions.size).toBe(0);
		expect(parts.some(p => p instanceof ChatResponseConfirmationPart)).toBe(true);
	});

	it('handles /delegate command from another chat without active repositor', async () => {
		expect(manager.sessions.size).toBe(0);
		const request = new TestChatRequest('/delegate Build feature');
		const context = { chatSessionContext: undefined } as vscode.ChatContext;
		const parts: vscode.ExtendedChatResponsePart[] = [];
		const stream = new MockChatResponseStream((part) => parts.push(part));
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		expect(manager.sessions.size).toBe(1);
		expect(parts.some(p => p instanceof ChatResponseConfirmationPart)).toBe(false);
	});

	it('handles /delegate command for new session without uncommitted changes', async () => {
		expect(manager.sessions.size).toBe(0);
		git.activeRepository = { get: () => ({ changes: { indexChanges: [], workingTree: [] } }) } as unknown as IGitService['activeRepository'];
		const request = new TestChatRequest('/delegate Build feature');
		const context = createChatContext('existing-delegate', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		expect(manager.sessions.size).toBe(1);
		const sdkSession = Array.from(manager.sessions.values())[0];
		expect(cloudProvider.delegate).toHaveBeenCalled();
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

	it('starts a new chat session and submits the request', async () => {
		const request = new TestChatRequest('Push this');
		(request as Record<string, any>).model = mockLanguageModelChat;
		const context = { chatSessionContext: undefined, chatSummary: undefined } as unknown as vscode.ChatContext;
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		const summarySpy = vi.spyOn(summarizer, 'provideChatSummary');

		await participant.createHandler()(request, context, stream, token);

		expect(manager.sessions.size).toBe(1);
		expect(summarySpy).toHaveBeenCalledTimes(0);
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toContain('Push this');
	});

	it('handleConfirmationData accepts uncommitted-changes and records push', async () => {
		// Existing session (non-untitled) so confirmation path is hit
		const sessionId = 'existing-confirm';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);
		const request = new TestChatRequest('my prompt');
		const context = createChatContext(sessionId, false);
		(request as any).acceptedConfirmationData = [{ step: 'uncommitted-changes', metadata: { chatContext: context } }];
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		// Cloud provider will create delegated chat session returning prInfo
		(cloudProvider.delegate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ uri: 'pr://2', title: 'T', description: 'D', author: 'A', linkTag: 'L' });

		await participant.createHandler()(request, context, stream, token);

		// Should NOT call session.handleRequest, instead record push messages
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(0);
		expect(sdkSession.emittedEvents.length).toBe(2);
		expect(sdkSession.emittedEvents[0].event).toBe('user.message');
		expect(sdkSession.emittedEvents[1].event).toBe('assistant.message');
		expect(sdkSession.emittedEvents[1].content).toContain('pr://2');
		// Cloud provider used with provided metadata
		expect(cloudProvider.delegate).toHaveBeenCalledWith(
			request,
			stream,
			context,
			token,
			{ chatContext: context }
		);
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
		expect(cloudProvider.delegate).not.toHaveBeenCalled();
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

	it('shows confirmation prompt for untitled session with uncommitted changes', async () => {
		git.activeRepository = { get: () => ({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];
		git.setRepo({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } } as unknown as RepoContext);
		workspaceFolderService.trackSessionWorkspaceFolder('temp-new', git.activeRepository.get()?.rootUri.fsPath || '');
		const request = new TestChatRequest('Fix the bug');
		const context = createChatContext('temp-new', true);
		const parts: vscode.ExtendedChatResponsePart[] = [];
		const stream = new MockChatResponseStream((part) => parts.push(part));
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should show confirmation prompt instead of creating session
		expect(parts.some(p => p instanceof ChatResponseConfirmationPart)).toBe(true);
		const confirmationPart = parts.find(p => p instanceof ChatResponseConfirmationPart) as ChatResponseConfirmationPart;
		expect(confirmationPart.title).toBe('Uncommitted Changes');
		expect(confirmationPart.data.step).toBe('uncommitted-changes');
		expect(confirmationPart.data.metadata.prompt).toBe('Fix the bug');
		expect(cliSessions.length).toBe(0);
	});

	it('uses original prompt from confirmation metadata when user accepts', async () => {
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];

		const request = new TestChatRequest('Copy Changes');
		const context = createChatContext('temp-new', true);
		(request as any).acceptedConfirmationData = [{
			step: 'uncommitted-changes',
			metadata: {
				prompt: 'Fix the bug',
				references: [],
				chatContext: context
			}
		}];
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should create session and use original prompt
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('Fix the bug');
		// Verify promptResolver was called with original prompt
		expect(promptResolver.resolvePrompt).toHaveBeenCalled();
		expect((promptResolver.resolvePrompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('Fix the bug');
	});

	it('uses original prompt for session label when swapping untitled session', async () => {
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];

		const request = new TestChatRequest('Move Changes');
		const context = createChatContext('temp-new', true);
		(request as any).acceptedConfirmationData = [{
			step: 'uncommitted-changes',
			metadata: {
				prompt: 'Implement new feature',
				references: [],
				chatContext: context
			}
		}];
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should swap with original prompt as label
		expect(itemProvider.swap).toHaveBeenCalled();
		const swapCall = (itemProvider.swap as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(swapCall[1].label).toBe('Implement new feature');
	});

	it('returns empty when user cancels untitled session confirmation', async () => {
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];

		const request = new TestChatRequest('Cancel');
		const context = createChatContext('temp-new', true);
		(request as any).acceptedConfirmationData = [{
			step: 'uncommitted-changes',
			metadata: {
				prompt: 'Fix the bug',
				references: [],
				chatContext: context
			}
		}];
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		workspaceFolderService.trackSessionWorkspaceFolder('temp-new', git.activeRepository.get()?.rootUri?.fsPath || '');

		await participant.createHandler()(request, context, stream, token);

		// Should not create session
		expect(cliSessions.length).toBe(0);
		expect(itemProvider.swap).not.toHaveBeenCalled();
	});

	it('does not show confirmation for untitled session without uncommitted changes', async () => {
		git.activeRepository = { get: () => ({ changes: { indexChanges: [], workingTree: [] } }) } as unknown as IGitService['activeRepository'];

		const request = new TestChatRequest('Fix the bug');
		const context = createChatContext('temp-new', true);
		const parts: vscode.ExtendedChatResponsePart[] = [];
		const stream = new MockChatResponseStream((part) => parts.push(part));
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should create session directly without confirmation
		expect(parts.some(p => p instanceof ChatResponseConfirmationPart)).toBe(false);
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('Fix the bug');
	});

	it('does not show confirmation for existing (non-untitled) session with uncommitted changes', async () => {
		const sessionId = 'existing-123';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];

		const request = new TestChatRequest('Continue work');
		const context = createChatContext(sessionId, false);
		const parts: vscode.ExtendedChatResponsePart[] = [];
		const stream = new MockChatResponseStream((part) => parts.push(part));
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should not show confirmation for existing sessions
		expect(parts.some(p => p instanceof ChatResponseConfirmationPart)).toBe(false);
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('Continue work');
	});

	it('reuses untitled session without uncommitted changes instead of creating new session', async () => {
		git.activeRepository = { get: () => ({ changes: { indexChanges: [], workingTree: [] } }) } as unknown as IGitService['activeRepository'];

		// First request creates the session
		const request1 = new TestChatRequest('First request');
		const context1 = createChatContext('temp-new', true);
		const stream1 = new MockChatResponseStream();
		const token1 = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request1, context1, stream1, token1);
		expect(cliSessions.length).toBe(1);
		const firstSessionId = cliSessions[0].sessionId;

		// Second request should reuse the same session (now it's not untitled anymore after first request)
		const request2 = new TestChatRequest('Second request');
		const context2 = createChatContext(firstSessionId, false);
		const stream2 = new MockChatResponseStream();
		const token2 = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request2, context2, stream2, token2);

		// Should not create a new session
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].sessionId).toBe(firstSessionId);
		expect(cliSessions[0].requests.length).toBe(2);
		expect(cliSessions[0].requests[0].prompt).toBe('First request');
		expect(cliSessions[0].requests[1].prompt).toBe('Second request');
	});

	it('reuses untitled session after confirmation without creating new session', async () => {
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];
		git.setRepo({ rootUri: Uri.file(`${sep}workspace`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } } as unknown as RepoContext);
		// First request shows confirmation
		const request1 = new TestChatRequest('First request');
		const context1 = createChatContext('temp-new', true);
		const parts1: vscode.ExtendedChatResponsePart[] = [];
		const stream1 = new MockChatResponseStream((part) => parts1.push(part));
		const token1 = disposables.add(new CancellationTokenSource()).token;
		workspaceFolderService.trackSessionWorkspaceFolder('temp-new', Uri.file(`${sep}workspace`).fsPath);

		await participant.createHandler()(request1, context1, stream1, token1);

		// Confirmation should be shown
		expect(parts1.some(p => p instanceof ChatResponseConfirmationPart)).toBe(true);
		expect(cliSessions.length).toBe(0);

		// User responds to confirmation
		const request2 = new TestChatRequest('Copy Changes');
		(request2 as any).acceptedConfirmationData = [{
			step: 'uncommitted-changes',
			metadata: {
				prompt: 'First request',
				references: [],
				chatContext: context1
			}
		}];
		const stream2 = new MockChatResponseStream();
		const token2 = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request2, context1, stream2, token2);

		// Session should be created
		expect(cliSessions.length).toBe(1);
		const firstSessionId = cliSessions[0].sessionId;
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('First request');

		// Third request should reuse the same session
		const request3 = new TestChatRequest('Third request');
		const context3 = createChatContext(firstSessionId, false);
		const stream3 = new MockChatResponseStream();
		const token3 = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request3, context3, stream3, token3);

		// Should not create a new session
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].sessionId).toBe(firstSessionId);
		expect(cliSessions[0].requests.length).toBe(2);
		expect(cliSessions[0].requests[1].prompt).toBe('Third request');
	});
});
