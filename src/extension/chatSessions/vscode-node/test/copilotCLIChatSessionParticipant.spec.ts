/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Attachment } from '@github/copilot/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { NullNativeEnvService } from '../../../../platform/env/common/nullEnvService';
import { MockFileSystemService } from '../../../../platform/filesystem/node/test/mockFileSystemService';
import { IGitService, RepoContext } from '../../../../platform/git/common/gitService';
import { ILogService } from '../../../../platform/log/common/logService';
import { PromptsServiceImpl } from '../../../../platform/promptFiles/common/promptsServiceImpl';
import { NullRequestLogger } from '../../../../platform/requestLogger/node/nullRequestLogger';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import type { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { IWorkspaceService, NullWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { LanguageModelTextPart, LanguageModelToolResult2 } from '../../../../util/common/test/shims/chatTypes';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { sep } from '../../../../util/vs/base/common/path';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService, ServicesAccessor } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IChatDelegationSummaryService } from '../../../agents/copilotcli/common/delegationSummaryService';
import { type ICopilotCLIModels, type ICopilotCLISDK } from '../../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../../agents/copilotcli/node/copilotcliPromptResolver';
import { CopilotCLISession } from '../../../agents/copilotcli/node/copilotcliSession';
import { CopilotCLISessionService, CopilotCLISessionWorkspaceTracker, ICopilotCLISessionService } from '../../../agents/copilotcli/node/copilotcliSessionService';
import { ICopilotCLIMCPHandler } from '../../../agents/copilotcli/node/mcpHandler';
import { MockCliSdkSession, MockCliSdkSessionManager, NullCopilotCLIAgents, NullICopilotCLIImageSupport } from '../../../agents/copilotcli/node/test/copilotCliSessionService.spec';
import { ChatSummarizerProvider } from '../../../prompt/node/summarizer';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { MockChatResponseStream, TestChatRequest } from '../../../test/node/testHelpers';
import type { IToolsService } from '../../../tools/common/toolsService';
import { mockLanguageModelChat } from '../../../tools/node/test/searchToolTestUtils';
import { IChatSessionWorkspaceFolderService } from '../../common/chatSessionWorkspaceFolderService';
import { IChatSessionWorktreeService, type ChatSessionWorktreeProperties } from '../../common/chatSessionWorktreeService';
import { CopilotCLIChatSessionContentProvider, CopilotCLIChatSessionItemProvider, CopilotCLIChatSessionParticipant } from '../copilotCLIChatSessionsContribution';
import { CopilotCloudSessionsProvider } from '../copilotCloudSessionsProvider';
import { CopilotCLIFolderRepositoryManager } from '../folderRepositoryManagerImpl';

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

class FakeToolsService extends mock<IToolsService>() {
	nextConfirmationButton: string | undefined = undefined;
	override invokeTool = vi.fn(async (name: string, _options: unknown, _token: unknown) => {
		if (name === 'vscode_get_confirmation_with_options') {
			const button = this.nextConfirmationButton;
			if (button !== undefined) {
				return new LanguageModelToolResult2([new LanguageModelTextPart(button)]);
			}
			return new LanguageModelToolResult2([]);
		}
		return new LanguageModelToolResult2([]);
	});
}

class FakeChatSessionWorkspaceFolderService extends mock<IChatSessionWorkspaceFolderService>() {
	private _sessionWorkspaceFolders = new Map<string, vscode.Uri>();
	private _recentFolders: { folder: vscode.Uri; lastAccessTime: number }[] = [];
	override trackSessionWorkspaceFolder = vi.fn(async (sessionId: string, workspaceFolderUri: string) => {
		this._sessionWorkspaceFolders.set(sessionId, vscode.Uri.file(workspaceFolderUri));
	});
	override deleteTrackedWorkspaceFolder = vi.fn(async (sessionId: string) => {
		this._sessionWorkspaceFolders.delete(sessionId);
	});
	override getSessionWorkspaceFolder = vi.fn((sessionId: string) => {
		return this._sessionWorkspaceFolders.get(sessionId);
	});
	override getRecentFolders = vi.fn((): { folder: vscode.Uri; lastAccessTime: number }[] => {
		return this._recentFolders;
	});
	setTestRecentFolders(folders: { folder: vscode.Uri; lastAccessTime: number }[]): void {
		this._recentFolders = folders;
	}
	setTestSessionWorkspaceFolder(sessionId: string, folder: vscode.Uri): void {
		this._sessionWorkspaceFolders.set(sessionId, folder);
	}
}

class FakeChatSessionWorktreeService extends mock<IChatSessionWorktreeService>() {
	constructor() {
		super();
	}
	override createWorktree = vi.fn(async () => undefined) as unknown as IChatSessionWorktreeService['createWorktree'];
	override getWorktreeProperties = vi.fn((_id: string | vscode.Uri) => undefined);
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
	private _recentRepositories: { rootUri: vscode.Uri; lastAccessTime: number }[] = [];
	setRepo(repos: RepoContext) {
		this.repositories = [repos];
	}
	override async getRepository(uri: URI, forceOpen?: boolean): Promise<RepoContext | undefined> {
		if (this.repositories.length === 1) {
			return Promise.resolve(this.repositories[0]);
		}
		return undefined;
	}
	override getRecentRepositories = vi.fn((): { rootUri: vscode.Uri; lastAccessTime: number }[] => {
		return this._recentRepositories;
	});
	setTestRecentRepositories(repos: { rootUri: vscode.Uri; lastAccessTime: number }[]): void {
		this._recentRepositories = repos;
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


class FakeCopilotCLISessionService extends mock<ICopilotCLISessionService>() {
	private _sessionWorkingDirs = new Map<string, vscode.Uri>();

	override getSessionWorkingDirectory = vi.fn(async (sessionId: string): Promise<vscode.Uri | undefined> => {
		return this._sessionWorkingDirs.get(sessionId);
	});

	setTestSessionWorkingDirectory(sessionId: string, uri: vscode.Uri): void {
		this._sessionWorkingDirs.set(sessionId, uri);
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
	let tools: FakeToolsService;
	let participant: CopilotCLIChatSessionParticipant;
	let workspaceService: IWorkspaceService;
	let instantiationService: IInstantiationService;
	let manager: MockCliSdkSessionManager;
	let mcpHandler: ICopilotCLIMCPHandler;
	let folderRepositoryManager: CopilotCLIFolderRepositoryManager;
	let cliSessionServiceForFolderManager: FakeCopilotCLISessionService;
	let contentProvider: CopilotCLIChatSessionContentProvider;
	const cliSessions: TestCopilotCLISession[] = [];

	beforeEach(async () => {
		cliSessions.length = 0;
		const sdk = {
			getPackage: vi.fn(async () => ({ internal: { LocalSessionManager: MockCliSdkSessionManager } }))
		} as unknown as ICopilotCLISDK;
		const services = disposables.add(createExtensionUnitTestingServices());
		const accessor = services.createTestingAccessor();
		disposables.add(accessor);
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
		cliSessionServiceForFolderManager = new FakeCopilotCLISessionService();
		telemetry = new NullTelemetryService();
		tools = new FakeToolsService();
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
				const session = new TestCopilotCLISession(options, sdkSession, logService, workspaceService, sdk, instantiationService, delegationService, new NullRequestLogger(), new NullICopilotCLIImageSupport());
				cliSessions.push(session);
				return disposables.add(session);
			}
		} as unknown as IInstantiationService;
		sessionService = disposables.add(new CopilotCLISessionService(logService, sdk, instantiationService, new NullNativeEnvService(), new MockFileSystemService(), mcpHandler, new NullCopilotCLIAgents(), workspaceService));

		manager = await sessionService.getSessionManager() as unknown as MockCliSdkSessionManager;
		contentProvider = new class extends mock<CopilotCLIChatSessionContentProvider>() {
			override notifySessionOptionsChange = vi.fn((_resource: vscode.Uri, _updates: ReadonlyArray<{ optionId: string; value: string | vscode.ChatSessionProviderOptionItem }>): void => {
				// tracked by vi.fn
			});
		}();
		folderRepositoryManager = new CopilotCLIFolderRepositoryManager(
			worktree,
			workspaceFolderService,
			cliSessionServiceForFolderManager as unknown as ICopilotCLISessionService,
			git,
			workspaceService,
			logService,
			tools
		);

		instantiationService = accessor.get(IInstantiationService);
		const mockConfigurationService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		await mockConfigurationService.setConfig(ConfigKey.Advanced.CLIBranchSupport, true);

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
			folderRepositoryManager,
			mockConfigurationService
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
		const worktreeProperties: ChatSessionWorktreeProperties = {
			autoCommit: true,
			baseCommit: 'deadbeef',
			branchName: 'test',
			repositoryPath: `${sep}repo`,
			worktreePath: `${sep}worktree`
		};
		// Set up untitled session folder
		folderRepositoryManager.setUntitledSessionFolder('untitled:temp-new', Uri.file(`${sep}repo`));
		// Configure git to return repository for the folder
		git.setRepo({ rootUri: Uri.file(`${sep}repo`), kind: 'repository' } as unknown as RepoContext);
		// Configure worktree service to return worktree properties when createWorktree is called
		(worktree.createWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(worktreeProperties);

		const request = new TestChatRequest('Say hi');
		const context = createChatContext('untitled:temp-new', true);
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
		// Set up untitled session folder (no git repo)
		folderRepositoryManager.setUntitledSessionFolder('untitled:temp-new', Uri.file(`${sep}workspace`));
		// Git returns no repository for this folder (default FakeGitService behavior)
		const request = new TestChatRequest('Say hi');
		const context = createChatContext('untitled:temp-new', true);
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

	it('handles /delegate command from another chat (has uncommitted changes and user copies changes)', async () => {
		expect(manager.sessions.size).toBe(0);
		git.activeRepository = { get: () => ({ rootUri: Uri.file(`${sep}workspace`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];
		tools.nextConfirmationButton = 'Copy Changes';
		const request = new TestChatRequest('/delegate Build feature');
		const context = { chatSessionContext: undefined } as vscode.ChatContext;
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// With the awaitable confirmation, the session should be created in a single request
		expect(manager.sessions.size).toBe(1);
		expect(tools.invokeTool).toHaveBeenCalledWith(
			'vscode_get_confirmation_with_options',
			expect.objectContaining({ input: expect.objectContaining({ title: 'Delegate to Background Agent' }) }),
			token
		);
	});

	it('handles /delegate command from another chat without active repository', async () => {
		expect(manager.sessions.size).toBe(0);
		const request = new TestChatRequest('/delegate Build feature');
		const context = { chatSessionContext: undefined } as vscode.ChatContext;
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		expect(manager.sessions.size).toBe(1);
		// No confirmation should be invoked when there are no uncommitted changes
		expect(tools.invokeTool).not.toHaveBeenCalled();
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

	it('handles existing session with acceptedConfirmationData (no longer triggers cloud delegation)', async () => {
		// With the new flow, acceptedConfirmationData is no longer used for uncommitted changes.
		// Existing sessions proceed directly to handleRequest without confirmation flow.
		const sessionId = 'existing-confirm';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);
		const request = new TestChatRequest('my prompt');
		const context = createChatContext(sessionId, false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should call session.handleRequest normally
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('my prompt');
	});

	it('handles existing session with rejectedConfirmationData (proceeds normally)', async () => {
		// With the new flow, rejectedConfirmationData is no longer used for uncommitted changes.
		const sessionId = 'existing-confirm-reject';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);
		const request = new TestChatRequest('Apply');
		const context = createChatContext(sessionId, false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should proceed normally (no cloud delegation)
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('Apply');
	});

	it('handles existing session with unknown step acceptedConfirmationData (proceeds normally)', async () => {
		const sessionId = 'existing-confirm-unknown';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);
		const request = new TestChatRequest('Apply');
		const context = createChatContext(sessionId, false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should proceed normally
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(1);
	});

	it('prompts for uncommitted changes action for untitled session with uncommitted changes', async () => {
		git.activeRepository = { get: () => ({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];
		git.setRepo({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } } as unknown as RepoContext);
		// Set up untitled session folder so getFolderRepository returns repository info
		folderRepositoryManager.setUntitledSessionFolder('untitled:temp-new', Uri.file(`${sep}repo`));
		// User selects Copy Changes
		tools.nextConfirmationButton = 'Copy Changes';
		const request = new TestChatRequest('Fix the bug');
		const context = createChatContext('untitled:temp-new', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Session should be created in one request (no separate confirmation round-trip)
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('Fix the bug');
		// Verify confirmation tool was invoked with the right title
		expect(tools.invokeTool).toHaveBeenCalledWith(
			'vscode_get_confirmation_with_options',
			expect.objectContaining({ input: expect.objectContaining({ title: 'Uncommitted Changes' }) }),
			token
		);
	});

	it('uses request prompt directly when user accepts uncommitted changes confirmation', async () => {
		git.activeRepository = { get: () => ({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];
		git.setRepo({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } } as unknown as RepoContext);
		folderRepositoryManager.setUntitledSessionFolder('untitled:temp-new', Uri.file(`${sep}repo`));
		tools.nextConfirmationButton = 'Copy Changes';

		const request = new TestChatRequest('Fix the bug');
		const context = createChatContext('untitled:temp-new', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should create session and use request.prompt directly
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('Fix the bug');
		// Verify promptResolver was called without override prompt
		expect(promptResolver.resolvePrompt).toHaveBeenCalled();
		expect((promptResolver.resolvePrompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBeUndefined();
	});

	it('uses request prompt for session label when swapping untitled session', async () => {
		git.activeRepository = { get: () => ({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];
		git.setRepo({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } } as unknown as RepoContext);
		folderRepositoryManager.setUntitledSessionFolder('untitled:temp-new', Uri.file(`${sep}repo`));
		tools.nextConfirmationButton = 'Move Changes';

		const request = new TestChatRequest('Implement new feature');
		const context = createChatContext('untitled:temp-new', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should swap with request.prompt as label
		expect(itemProvider.swap).toHaveBeenCalled();
		const swapCall = (itemProvider.swap as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(swapCall[1].label).toBe('Implement new feature');
	});

	it('passes empty references array to resolvePrompt after confirmation', async () => {
		git.activeRepository = { get: () => ({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];
		git.setRepo({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } } as unknown as RepoContext);
		folderRepositoryManager.setUntitledSessionFolder('untitled:temp-new', Uri.file(`${sep}repo`));
		tools.nextConfirmationButton = 'Copy Changes';

		const request = new TestChatRequest('Fix the bug');
		const context = createChatContext('untitled:temp-new', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should pass empty array to resolvePrompt (no metadata to recover from)
		expect(promptResolver.resolvePrompt).toHaveBeenCalled();
		const resolvePromptCall = (promptResolver.resolvePrompt as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(resolvePromptCall[2]).toEqual([]);
	});

	it('returns empty when user cancels untitled session confirmation', async () => {
		git.activeRepository = { get: () => ({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];
		git.setRepo({ rootUri: Uri.file(`${sep}repo`), changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } } as unknown as RepoContext);
		folderRepositoryManager.setUntitledSessionFolder('untitled:temp-new', Uri.file(`${sep}repo`));
		// User clicks Cancel
		tools.nextConfirmationButton = 'Cancel';

		const request = new TestChatRequest('Fix the bug');
		const context = createChatContext('untitled:temp-new', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should not create session
		expect(cliSessions.length).toBe(0);
		expect(itemProvider.swap).not.toHaveBeenCalled();
	});

	it('does not prompt for confirmation for untitled session without uncommitted changes', async () => {
		git.activeRepository = { get: () => ({ changes: { indexChanges: [], workingTree: [] } }) } as unknown as IGitService['activeRepository'];

		const request = new TestChatRequest('Fix the bug');
		const context = createChatContext('temp-new', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should create session directly without confirmation
		expect(tools.invokeTool).not.toHaveBeenCalled();
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('Fix the bug');
	});

	it('does not prompt for confirmation for existing (non-untitled) session with uncommitted changes', async () => {
		const sessionId = 'existing-123';
		const sdkSession = new MockCliSdkSession(sessionId, new Date());
		manager.sessions.set(sessionId, sdkSession);
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] } }) } as unknown as IGitService['activeRepository'];

		const request = new TestChatRequest('Continue work');
		const context = createChatContext(sessionId, false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should not prompt for confirmation for existing sessions
		expect(tools.invokeTool).not.toHaveBeenCalled();
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
		// Set up untitled session folder so getFolderRepository returns repository info (for uncommitted changes check)
		folderRepositoryManager.setUntitledSessionFolder('untitled:temp-new', Uri.file(`${sep}workspace`));
		// User selects Copy Changes via the tools confirmation
		tools.nextConfirmationButton = 'Copy Changes';

		// First request creates the session (with confirmation handled inline)
		const request1 = new TestChatRequest('First request');
		const context1 = createChatContext('untitled:temp-new', true);
		const stream1 = new MockChatResponseStream();
		const token1 = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request1, context1, stream1, token1);

		// Session should be created
		expect(cliSessions.length).toBe(1);
		const firstSessionId = cliSessions[0].sessionId;
		expect(cliSessions[0].requests.length).toBe(1);
		expect(cliSessions[0].requests[0].prompt).toBe('First request');

		// Second request should reuse the same session
		const request2 = new TestChatRequest('Second request');
		const context2 = createChatContext(firstSessionId, false);
		const stream2 = new MockChatResponseStream();
		const token2 = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request2, context2, stream2, token2);

		// Should not create a new session
		expect(cliSessions.length).toBe(1);
		expect(cliSessions[0].sessionId).toBe(firstSessionId);
		expect(cliSessions[0].requests.length).toBe(2);
		expect(cliSessions[0].requests[1].prompt).toBe('Second request');
	});

	describe('Repository option locking behavior', () => {
		it('locks repository option on request start for untitled sessions', async () => {
			// Setup folder repository manager to return valid folder data
			const sessionId = 'untitled:temp-lock';
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: Uri.file(`${sep}workspace`),
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			// Verify lock was called with locked: true before other operations
			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const lockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && update.value?.locked === true)
			);
			expect(lockCalls.length).toBeGreaterThan(0);
		});

		it('does not lock repository option for existing (non-untitled) sessions', async () => {
			const sessionId = 'existing-lock-123';
			const sdkSession = new MockCliSdkSession(sessionId, new Date());
			manager.sessions.set(sessionId, sdkSession);

			const request = new TestChatRequest('Continue work');
			const context = createChatContext(sessionId, false);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			// Verify lock was NOT called (no calls with locked flag)
			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const lockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && update.value?.locked === true)
			);
			expect(lockCalls.length).toBe(0);
		});

		it('unlocks repository option when user rejects trust check', async () => {
			const sessionId = 'untitled:temp-trust-fail';
			// Mock folderRepositoryManager to simulate trust rejection
			const mockGetFolderRepository = vi.fn(async () => ({
				trusted: false,
				folder: Uri.file(`${sep}workspace`)
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;
			// Trust rejection now happens in initializeFolderRepository (not in the removed hasUncommittedChangesToHandleInRequest)
			const mockInitializeFolderRepository = vi.fn(async () => ({
				trusted: false,
				folder: Uri.file(`${sep}workspace`),
				repository: undefined,
				worktree: undefined,
				worktreeProperties: undefined
			}));
			(folderRepositoryManager.initializeFolderRepository as any) = mockInitializeFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			// Verify lock was called
			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const lockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && update.value?.locked === true)
			);
			expect(lockCalls.length).toBeGreaterThan(0);

			// Verify unlock was called (value is string with no locked flag)
			const unlockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && typeof update.value === 'string')
			);
			expect(unlockCalls.length).toBeGreaterThan(0);

			// Verify no session was created due to trust rejection
			expect(cliSessions.length).toBe(0);
		});

		it('does not unlock repository option when user cancels confirmation', async () => {
			const sessionId = 'untitled:temp-cancel';
			git.activeRepository = {
				get: () => ({
					rootUri: Uri.file(`${sep}repo`),
					changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] }
				})
			} as unknown as IGitService['activeRepository'];
			git.setRepo({
				rootUri: Uri.file(`${sep}repo`),
				changes: { indexChanges: [{ path: 'file.ts' }], workingTree: [] }
			} as unknown as RepoContext);

			const mockGetFolderRepository = vi.fn(async () => ({
				repository: { rootUri: Uri.file(`${sep}repo`), kind: 'repository' } as unknown as RepoContext,
				folder: Uri.file(`${sep}repo`),
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			// User cancels the confirmation
			tools.nextConfirmationButton = 'Cancel';

			const request = new TestChatRequest('Fix bug');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			// Verify lock was called
			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const lockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && update.value?.locked === true)
			);
			expect(lockCalls.length).toBeGreaterThan(0);

			// After cancel, there should be no unlock calls (repository option remains locked)
			const unlockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && typeof update.value === 'string')
			);
			expect(unlockCalls.length).toBe(0);

			// No session created due to cancellation
			expect(cliSessions.length).toBe(0);
		});

		it('does not unlock repository option when session creation fails', async () => {
			const sessionId = 'untitled:temp-fail';
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: Uri.file(`${sep}workspace`),
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			// Mock sessionService.createSession to return null
			const originalCreateSession = sessionService.createSession;
			(sessionService.createSession as any) = vi.fn(async () => undefined);

			try {
				await participant.createHandler()(request, context, stream, token);
			} finally {
				(sessionService.createSession as any) = originalCreateSession;
			}

			// Verify lock was called
			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const lockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && update.value?.locked === true)
			);
			expect(lockCalls.length).toBeGreaterThan(0);

			// Verify unlock was called on failure
			const unlockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && typeof update.value === 'string')
			);
			expect(unlockCalls.length).toBe(0);

			// No session created due to failure
			expect(cliSessions.length).toBe(0);
		});

		it('keeps repository option locked throughout successful request flow', async () => {
			const sessionId = 'untitled:temp-success';
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: Uri.file(`${sep}workspace`),
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			// Verify lock was called
			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const lockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && update.value?.locked === true)
			);
			expect(lockCalls.length).toBeGreaterThan(0);

			// Verify unlock was NOT called on successful completion
			const unlockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && typeof update.value === 'string')
			);
			expect(unlockCalls.length).toBe(0);

			// Verify session was created
			expect(cliSessions.length).toBe(1);
		});

		it('displays repo directory name (not parent workspace folder name) for sub-directory git repos in multi-root workspaces', async () => {
			// Bug scenario: multi-root workspace with folders A, B where B has sub-directories repo1, repo2.
			// When user selects repo2, the locked dropdown should display "repo2", not "B".
			const sessionId = 'untitled:temp-multiroot';
			const repoUri = Uri.file(`${sep}workspaces${sep}B${sep}repo2`);
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: repoUri,
				repository: { rootUri: repoUri, kind: 'repository' } as unknown as RepoContext,
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			// Verify the locked option uses the repo name "repo2", not the parent workspace folder "B"
			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const lockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && update.value?.locked === true)
			);
			expect(lockCalls.length).toBeGreaterThan(0);
			// When repository is available, toRepositoryOptionItem derives name from the repo URI path
			const repoLockUpdate = lockCalls.flatMap(call => call[1]).find(
				(update: any) => update.optionId === 'repository' && update.value?.locked === true
			);
			expect(repoLockUpdate.value.name).toBe('repo2');
			expect(repoLockUpdate.value.id).toBe(repoUri.fsPath);
		});

		it('displays folder basename (not workspace folder name) when locking a non-repo sub-directory folder', async () => {
			// When the selected folder is NOT a git repo but is a sub-directory of a workspace folder,
			// the locked dropdown should display the folder's basename, not the workspace folder name.
			const sessionId = 'untitled:temp-subfolder';
			const folderUri = Uri.file(`${sep}workspaces${sep}B${sep}subfolder`);
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: folderUri,
				repository: undefined,
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			// Verify the locked option uses basename "subfolder", not workspace folder name "B"
			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const lockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && update.value?.locked === true)
			);
			expect(lockCalls.length).toBeGreaterThan(0);
			const folderLockUpdate = lockCalls.flatMap(call => call[1]).find(
				(update: any) => update.optionId === 'repository' && update.value?.locked === true
			);
			expect(folderLockUpdate.value.name).toBe('subfolder');
			expect(folderLockUpdate.value.id).toBe(folderUri.fsPath);
			// Non-repo folder should use folder icon
			expect(folderLockUpdate.value.icon.id).toBe('folder');
		});

		it('uses repo icon for repository and folder icon for plain folder when locking', async () => {
			// Verify icon differentiation: repo gets 'repo' icon, plain folder gets 'folder' icon
			const sessionId = 'untitled:temp-icon';
			const repoUri = Uri.file(`${sep}workspace${sep}myrepo`);
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: repoUri,
				repository: { rootUri: repoUri, kind: 'repository' } as unknown as RepoContext,
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const repoLockUpdate = allCalls.flatMap(call => call[1]).find(
				(update: any) => update.optionId === 'repository' && update.value?.locked === true
			);
			// Repository should use 'repo' icon
			expect(repoLockUpdate.value.icon.id).toBe('repo');
		});

		it('eagerly re-locks repo option with accurate info after session creation for untitled sessions', async () => {
			// The new code at line ~735 fires `void this.lockRepoOptionForSession(context, token)`
			// after session creation to update the locked dropdown with more accurate info.
			const sessionId = 'untitled:temp-eager-lock';
			const repoUri = Uri.file(`${sep}workspace${sep}myrepo`);
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: repoUri,
				repository: { rootUri: repoUri, kind: 'repository' } as unknown as RepoContext,
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			// There should be multiple lock calls: one initial lock and one eager re-lock after session creation.
			// The eager lock should contain the updated repo information.
			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const lockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'repository' && update.value?.locked === true)
			);
			// Expect at least 2 lock calls (initial lock + eager re-lock after session creation)
			expect(lockCalls.length).toBeGreaterThanOrEqual(2);

			// The last lock call should have the accurate repo information
			const lastLockCall = lockCalls[lockCalls.length - 1];
			const lastLockUpdate = lastLockCall[1].find(
				(update: any) => update.optionId === 'repository' && update.value?.locked === true
			);
			expect(lastLockUpdate.value.name).toBe('myrepo');
			expect(lastLockUpdate.value.id).toBe(repoUri.fsPath);
		});

		it('locks with submodule/archive icon for submodule repositories', async () => {
			const sessionId = 'untitled:temp-submodule';
			const repoUri = Uri.file(`${sep}workspace${sep}submodule-repo`);
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: repoUri,
				repository: { rootUri: repoUri, kind: 'submodule' } as unknown as RepoContext,
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const repoLockUpdate = allCalls.flatMap(call => call[1]).find(
				(update: any) => update.optionId === 'repository' && update.value?.locked === true
			);
			// Submodule repositories should use 'archive' icon (not 'repo')
			expect(repoLockUpdate.value.icon.id).toBe('archive');
			expect(repoLockUpdate.value.name).toBe('submodule-repo');
		});

		it('locks branch option alongside repository option when branch is selected', async () => {
			const sessionId = 'untitled:temp-branch-lock';
			const repoUri = Uri.file(`${sep}workspace${sep}myrepo`);
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: repoUri,
				repository: { rootUri: repoUri, kind: 'repository' } as unknown as RepoContext,
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			// Simulate branch selection via initial options
			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			(context.chatSessionContext as any).initialSessionOptions = [
				{ optionId: 'branch', value: 'feature-branch' }
			];
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			// Find a lock call that includes both repo and branch locking
			const branchLockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'branch' && update.value?.locked === true)
			);
			expect(branchLockCalls.length).toBeGreaterThan(0);

			const branchLockUpdate = branchLockCalls.flatMap(call => call[1]).find(
				(update: any) => update.optionId === 'branch' && update.value?.locked === true
			);
			expect(branchLockUpdate.value.name).toBe('feature-branch');
			expect(branchLockUpdate.value.icon.id).toBe('git-branch');
		});

		it('does not lock branch option when no branch is selected', async () => {
			const sessionId = 'untitled:temp-no-branch-lock';
			const repoUri = Uri.file(`${sep}workspace${sep}myrepo`);
			const mockGetFolderRepository = vi.fn(async () => ({
				folder: repoUri,
				repository: { rootUri: repoUri, kind: 'repository' } as unknown as RepoContext,
				trusted: true
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;

			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			const branchLockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'branch')
			);
			expect(branchLockCalls.length).toBe(0);
		});

		it('unlocks branch option alongside repository option when trust is denied', async () => {
			const sessionId = 'untitled:temp-branch-unlock';
			const mockGetFolderRepository = vi.fn(async () => ({
				trusted: false,
				folder: Uri.file(`${sep}workspace`)
			}));
			(folderRepositoryManager.getFolderRepository as any) = mockGetFolderRepository;
			const mockInitializeFolderRepository = vi.fn(async () => ({
				trusted: false,
				folder: Uri.file(`${sep}workspace`),
				repository: undefined,
				worktree: undefined,
				worktreeProperties: undefined
			}));
			(folderRepositoryManager.initializeFolderRepository as any) = mockInitializeFolderRepository;

			// Simulate having a branch selected before running
			const request = new TestChatRequest('Say hi');
			const context = createChatContext(sessionId, true);
			(context.chatSessionContext as any).initialSessionOptions = [
				{ optionId: 'branch', value: 'my-branch' }
			];
			const stream = new MockChatResponseStream();
			const token = disposables.add(new CancellationTokenSource()).token;

			await participant.createHandler()(request, context, stream, token);

			const allCalls = (contentProvider.notifySessionOptionsChange as unknown as ReturnType<typeof vi.fn>).mock.calls;
			// Find unlock calls (value is string, not an object with locked flag)
			const branchUnlockCalls = allCalls.filter(
				call => call[1].some((update: any) => update.optionId === 'branch' && typeof update.value === 'string')
			);
			expect(branchUnlockCalls.length).toBeGreaterThan(0);
		});
	});
});
