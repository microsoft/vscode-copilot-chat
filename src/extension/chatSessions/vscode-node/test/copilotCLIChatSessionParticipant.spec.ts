/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IRunCommandExecutionService } from '../../../../platform/commands/common/runCommandExecutionService';
import type { IGitService } from '../../../../platform/git/common/gitService';
import type { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { mock } from '../../../../util/common/test/simpleMock';
import { CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import type { ICopilotCLIModels } from '../../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../../agents/copilotcli/node/copilotcliPromptResolver';
import type { ICopilotCLISession } from '../../../agents/copilotcli/node/copilotcliSession';
import type { ICopilotCLISessionService } from '../../../agents/copilotcli/node/copilotcliSessionService';
import { PermissionRequest } from '../../../agents/copilotcli/node/permissionHelpers';
import { ChatSummarizerProvider } from '../../../prompt/node/summarizer';
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

// Minimal fake implementations for dependencies used by the participant

class FakePromptResolver extends mock<CopilotCLIPromptResolver>() {
	override resolvePrompt(request: vscode.ChatRequest) {
		return Promise.resolve({ prompt: request.prompt, attachments: [] });
	}
}

class FakeSessionItemProvider extends mock<CopilotCLIChatSessionItemProvider>() {
	override swap = vi.fn();
}

class FakeSummarizerProvider extends mock<ChatSummarizerProvider>() {
	override provideChatSummary(_context: vscode.ChatContext) { return Promise.resolve('summary text'); }
}

class FakeWorktreeManager extends mock<CopilotCLIWorktreeManager>() {
	override createWorktree = vi.fn(async () => undefined);
	override storeWorktreePath = vi.fn(async () => { });
	override getWorktreePath = vi.fn((_id: string) => undefined);
	override getIsolationPreference = vi.fn(() => true);
}

interface CreateSessionArgs { prompt: string | undefined; modelId: string | undefined; workingDirectory: string | undefined }

class FakeCopilotCLISession implements ICopilotCLISession {
	public sessionId: string;
	public status: any;
	public permissionRequested: any;
	public onDidChangeStatus: any = () => ({ dispose() { } });
	public attachPermissionHandler = vi.fn(() => ({ dispose() { } }));
	// Implementation uses the (typo'd) method name `attchStream`.
	public attachStream = vi.fn(() => ({ dispose() { } }));
	public handleRequest = vi.fn(async () => { });
	public addUserMessage = vi.fn();
	public addUserAssistantMessage = vi.fn();
	public getSelectedModelId = vi.fn(async () => 'model-default');
	public getChatHistory = vi.fn(() => []);
	constructor(id: string) { this.sessionId = id; }
	onPermissionRequested: vscode.Event<PermissionRequest> = () => ({ dispose() { } });
	dispose(): void {
		throw new Error('Method not implemented.');
	}
}

class FakeSessionService extends DisposableStore implements ICopilotCLISessionService {
	_serviceBrand: undefined;
	public createdArgs: CreateSessionArgs | undefined;
	public createSession = vi.fn(async (prompt: string | undefined, modelId: string | undefined, workingDirectory: string | undefined) => {
		this.createdArgs = { prompt, modelId, workingDirectory };
		const s = new FakeCopilotCLISession('new-session-id');
		return s as unknown as ICopilotCLISession;
	});
	private existing: Map<string, ICopilotCLISession> = new Map();
	public getSession = vi.fn(async (id: string) => this.existing.get(id));
	public getAllSessions = vi.fn(async () => []);
	public deleteSession = vi.fn(async () => { });
	public onDidChangeSessions = this.add(new Emitter<void>()).event;
	// helper
	setExisting(id: string, session: ICopilotCLISession) { this.existing.set(id, session); }
}

class FakeModels implements ICopilotCLIModels {
	_serviceBrand: undefined;
	getDefaultModel = vi.fn(async () => ({ id: 'base', name: 'Base' }));
	getAvailableModels = vi.fn(async () => [{ id: 'base', name: 'Base' }]);
	setDefaultModel = vi.fn(async () => { });
	toModelProvider = vi.fn((id: string) => id); // passthrough
}

class FakeTelemetry extends mock<ITelemetryService>() {
	override sendMSFTTelemetryEvent = vi.fn();
}

class FakeToolsService extends mock<IToolsService>() { }

class FakeGitService extends mock<IGitService>() {
	override activeRepository = { get: () => undefined } as unknown as IGitService['activeRepository'];
}

// Cloud provider fake for delegate scenario
class FakeCloudProvider extends mock<CopilotCloudSessionsProvider>() {
	override tryHandleUncommittedChanges = vi.fn(async () => false);
	override createDelegatedChatSession = vi.fn(async () => ({ uri: 'pr://1', title: 'PR Title', description: 'Desc', author: 'Me', linkTag: 'tag' })) as unknown as CopilotCloudSessionsProvider['createDelegatedChatSession'];
}

class FakeCommandExecutionService extends mock<IRunCommandExecutionService>() {
	override executeCommand = vi.fn(async () => { });
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

describe('CopilotCLIChatSessionParticipant.handleRequest', () => {
	const disposables = new DisposableStore();
	let promptResolver: FakePromptResolver;
	let itemProvider: FakeSessionItemProvider;
	let cloudProvider: FakeCloudProvider;
	let summarizer: FakeSummarizerProvider;
	let worktree: FakeWorktreeManager;
	let git: FakeGitService;
	let models: FakeModels;
	let sessionService: FakeSessionService;
	let telemetry: FakeTelemetry;
	let tools: FakeToolsService;
	let participant: CopilotCLIChatSessionParticipant;
	let commandExecutionService: FakeCommandExecutionService;

	beforeEach(() => {
		promptResolver = new FakePromptResolver();
		itemProvider = new FakeSessionItemProvider();
		cloudProvider = new FakeCloudProvider();
		summarizer = new FakeSummarizerProvider();
		worktree = new FakeWorktreeManager();
		git = new FakeGitService();
		models = new FakeModels();
		sessionService = disposables.add(new FakeSessionService());
		telemetry = new FakeTelemetry();
		tools = new FakeToolsService();
		commandExecutionService = new FakeCommandExecutionService();
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
			commandExecutionService
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

		await participant.createHandler()(request, context, stream, token);

		// createSession was used
		expect(sessionService.createSession).toHaveBeenCalled();
		const createdSession = sessionService.createSession.mock.results[0].value as Promise<ICopilotCLISession>;
		const session = await createdSession;
		// handleRequest on the returned session
		// handleRequest signature: (prompt, attachments, modelId, token)
		expect(session.handleRequest).toHaveBeenCalledWith('Say hi', [], 'base', token);
		// Swap should have been called to replace the untitled item
		expect(itemProvider.swap).toHaveBeenCalled();
	});

	it('reuses existing session (non-untitled) and does not create new one', async () => {
		const existing = new FakeCopilotCLISession('existing-123');
		sessionService.setExisting('existing-123', existing as unknown as ICopilotCLISession);
		const request = new TestChatRequest('Continue');
		const context = createChatContext('existing-123', false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		expect(sessionService.getSession).toHaveBeenCalledWith('existing-123', undefined, undefined, false, token);
		expect(sessionService.createSession).not.toHaveBeenCalled();
		expect(existing.handleRequest).toHaveBeenCalledWith('Continue', [], 'base', token);
		// No swap for existing session
		expect(itemProvider.swap).not.toHaveBeenCalled();
	});

	it('handles /delegate command for existing session (no session.handleRequest)', async () => {
		const existing = new FakeCopilotCLISession('existing-delegate');
		sessionService.setExisting('existing-delegate', existing as unknown as ICopilotCLISession);
		// Simulate uncommitted changes
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }] } }) } as unknown as IGitService['activeRepository'];
		const request = new TestChatRequest('/delegate Build feature');
		const context = createChatContext('existing-delegate', false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		expect(sessionService.getSession).toHaveBeenCalled();
		expect(existing.handleRequest).not.toHaveBeenCalled();
		expect(cloudProvider.tryHandleUncommittedChanges).toHaveBeenCalled();
		expect(cloudProvider.createDelegatedChatSession).toHaveBeenCalled();
		// PR metadata recorded
		expect(existing.addUserMessage).toHaveBeenCalledWith('/delegate Build feature');
		const assistantArg = existing.addUserAssistantMessage.mock.calls[0][0];
		expect(assistantArg).toContain('pr://1');
		// Uncommitted changes warning surfaced
		// Warning should appear (we emitted stream.warning). The mock stream only records markdown.
		// Delegate path adds assistant PR metadata; ensure output contains PR metadata tag instead of relying on warning capture.
		expect(assistantArg).toMatch(/<pr_metadata uri="pr:\/\/1"/);
	});

	it('handles /delegate command for new session', async () => {
		const newSession = new FakeCopilotCLISession('push-session-id');
		git.activeRepository = { get: () => ({ changes: { indexChanges: [{ path: 'file.ts' }] } }) } as unknown as IGitService['activeRepository'];
		const request = new TestChatRequest('/delegate Build feature');
		const context = createChatContext('existing-delegate', true);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		sessionService.createSession.mockResolvedValue(newSession);

		await participant.createHandler()(request, context, stream, token);

		expect(sessionService.createSession).toHaveBeenCalled();
		expect(cloudProvider.tryHandleUncommittedChanges).toHaveBeenCalled();
		expect(cloudProvider.createDelegatedChatSession).toHaveBeenCalled();
		// PR metadata recorded
		expect(newSession.addUserMessage).toHaveBeenCalledWith('/delegate Build feature');
		const assistantArg = newSession.addUserAssistantMessage.mock.calls[0][0];
		expect(assistantArg).toContain('pr://1');
		// Uncommitted changes warning surfaced
		// Warning should appear (we emitted stream.warning). The mock stream only records markdown.
		// Delegate path adds assistant PR metadata; ensure output contains PR metadata tag instead of relying on warning capture.
		expect(assistantArg).toMatch(/<pr_metadata uri="pr:\/\/1"/);
	});

	it('invokes handlePushConfirmationData without existing chatSessionContext (summary via summarizer)', async () => {
		const request = new TestChatRequest('Push this');
		const context = { chatSessionContext: undefined, chatSummary: undefined } as unknown as vscode.ChatContext;
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		const summarySpy = vi.spyOn(summarizer, 'provideChatSummary');
		const execSpy = vi.spyOn(commandExecutionService, 'executeCommand');
		sessionService.createSession.mockResolvedValue(new FakeCopilotCLISession('push-session-id') as any);

		await participant.createHandler()(request, context, stream, token);

		const expectedPrompt = 'Push this\n**Summary**\nsummary text';
		expect(sessionService.createSession).toHaveBeenCalledWith(expectedPrompt, undefined, undefined, token);
		expect(summarySpy).toHaveBeenCalledTimes(1);
		expect(execSpy).toHaveBeenCalledTimes(2);
		expect(execSpy.mock.calls[0]).toEqual(['vscode.open', expect.any(Object)]);
		expect(String(execSpy.mock.calls[0].at(1))).toContain('copilotcli:/push-session-id');
		expect(execSpy.mock.calls[1]).toEqual(['workbench.action.chat.submit', { inputValue: expectedPrompt }]);
	});
	it('invokes handlePushConfirmationData using existing chatSummary and skips summarizer', async () => {
		const request = new TestChatRequest('Push that');
		const context = { chatSessionContext: undefined, chatSummary: { history: 'precomputed history' } } as unknown as vscode.ChatContext;
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		const summarySpy = vi.spyOn(summarizer, 'provideChatSummary');
		const execSpy = vi.spyOn(commandExecutionService, 'executeCommand');
		sessionService.createSession.mockResolvedValue(new FakeCopilotCLISession('push2-session-id') as any);

		await participant.createHandler()(request, context, stream, token);

		const expectedPrompt = 'Push that\n**Summary**\nprecomputed history';
		expect(sessionService.createSession).toHaveBeenCalledWith(expectedPrompt, undefined, undefined, token);
		expect(summarySpy).not.toHaveBeenCalled();
		expect(execSpy).toHaveBeenCalledTimes(2);
		expect(execSpy.mock.calls[0].at(0)).toBe('vscode.open');
		expect(execSpy.mock.calls[1]).toEqual(['workbench.action.chat.submit', { inputValue: expectedPrompt }]);
	});

	it('handleConfirmationData accepts uncommitted-changes and records push', async () => {
		// Existing session (non-untitled) so confirmation path is hit
		const existing = new FakeCopilotCLISession('existing-confirm');
		sessionService.setExisting('existing-confirm', existing as unknown as ICopilotCLISession);
		const request = new TestChatRequest('Apply');
		(request as any).acceptedConfirmationData = [{ step: 'uncommitted-changes', metadata: { prompt: 'delegate work', history: 'hist' } }];
		const context = createChatContext('existing-confirm', false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;
		// Cloud provider will create delegated chat session returning prInfo
		(cloudProvider.createDelegatedChatSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ uri: 'pr://2', title: 'T', description: 'D', author: 'A', linkTag: 'L' });

		await participant.createHandler()(request, context, stream, token);

		// Should NOT call session.handleRequest, instead record push messages
		expect(existing.handleRequest).not.toHaveBeenCalled();
		expect(existing.addUserMessage).toHaveBeenCalledWith('Apply');
		const assistantArg = existing.addUserAssistantMessage.mock.calls[0][0];
		expect(assistantArg).toContain('pr://2');
		// Cloud provider used with provided metadata
		expect(cloudProvider.createDelegatedChatSession).toHaveBeenCalledWith({ prompt: 'delegate work', history: 'hist', chatContext: context }, expect.anything(), token);
	});

	it('handleConfirmationData cancels when uncommitted-changes rejected', async () => {
		const existing = new FakeCopilotCLISession('existing-confirm-reject');
		sessionService.setExisting('existing-confirm-reject', existing as unknown as ICopilotCLISession);
		const request = new TestChatRequest('Apply');
		(request as any).rejectedConfirmationData = [{ step: 'uncommitted-changes', metadata: { prompt: 'delegate work', history: 'hist' } }];
		const context = createChatContext('existing-confirm-reject', false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// Should not record push or call delegate session
		expect(existing.addUserAssistantMessage).not.toHaveBeenCalled();
		expect(cloudProvider.createDelegatedChatSession).not.toHaveBeenCalled();
		// Cancellation message markdown captured
		expect(stream.output.some(o => /Cloud agent delegation request cancelled/i.test(o))).toBe(true);
	});

	it('handleConfirmationData unknown step warns and skips', async () => {
		const existing = new FakeCopilotCLISession('existing-confirm-unknown');
		sessionService.setExisting('existing-confirm-unknown', existing as unknown as ICopilotCLISession);
		const request = new TestChatRequest('Apply');
		(request as any).acceptedConfirmationData = [{ step: 'mystery-step', metadata: {} }];
		const context = createChatContext('existing-confirm-unknown', false);
		const stream = new MockChatResponseStream();
		const token = disposables.add(new CancellationTokenSource()).token;

		await participant.createHandler()(request, context, stream, token);

		// No push recorded, assistant message absent
		expect(existing.addUserAssistantMessage).not.toHaveBeenCalled();
		// Warning emitted (MockChatResponseStream records markdown, not warning; plugin emits with stream.warning -> not captured)
		// We just assert no PR metadata present and user message not added by recordPushToSession
		expect(existing.addUserMessage).not.toHaveBeenCalledWith('Apply');
	});
});
