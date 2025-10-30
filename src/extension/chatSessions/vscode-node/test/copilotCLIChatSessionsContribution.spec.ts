/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { URI } from '../../../../util/vs/base/common/uri';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequestTurn, ChatRequestTurn2, ChatResponseMarkdownPart, ChatResponseTurn2, ChatToolInvocationPart, MarkdownString, Uri } from '../../../../vscodeTypes';
import { ICopilotCLIModels } from '../../../agents/copilotcli/node/copilotCli';
import { CopilotCLIPromptResolver } from '../../../agents/copilotcli/node/copilotcliPromptResolver';
import { ICopilotCLISession } from '../../../agents/copilotcli/node/copilotcliSession';
import { ICopilotCLISessionService } from '../../../agents/copilotcli/node/copilotcliSessionService';
import { ChatSummarizerProvider } from '../../../prompt/node/summarizer';
import { createExtensionUnitTestingServices } from '../../../test/node/services';
import { CopilotCLIChatSessionContentProvider, CopilotCLIChatSessionItemProvider, CopilotCLIChatSessionParticipant, registerCLIChatCommands } from '../copilotCLIChatSessionsContribution';
import { ICopilotCLITerminalIntegration } from '../copilotCLITerminalIntegration';
import { CopilotChatSessionsProvider } from '../copilotCloudSessionsProvider';
// Mock PowerShell shim to avoid import-analysis errors
vi.mock('../copilotCLIShim.ps1', () => ({}));

// --------------------------------------------------------------------------------------
// Snapshot helper (mirrors claudeChatSessionContentProvider.spec.ts style)
// --------------------------------------------------------------------------------------
function mapHistoryForSnapshot(history: readonly (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[]) {
	return history.map(turn => {
		if (turn instanceof ChatRequestTurn) {
			return { type: 'request', prompt: turn.prompt };
		} else if (turn instanceof ChatResponseTurn2) {
			return {
				type: 'response',
				parts: turn.response.map(part => {
					if (part instanceof ChatResponseMarkdownPart) {
						return { type: 'markdown', content: part.value.value };
					} else if (part instanceof ChatToolInvocationPart) {
						return {
							type: 'tool',
							toolName: part.toolName,
							toolCallId: part.toolCallId,
							isError: part.isError,
							invocationMessage: part.invocationMessage ? (typeof part.invocationMessage === 'string' ? part.invocationMessage : part.invocationMessage.value) : undefined
						};
					}
					return { type: 'unknown' };
				})
			};
		}
		return { type: 'unknown' };
	});
}

// --------------------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------------------
// --- Minimal vi.fn based mocks (preferred style) ---
interface MockSession extends ICopilotCLISession { _history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] }

function createMockSession(id: string): MockSession {
	const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn2)[] = [];
	return {
		serviceBrand: undefined as any,
		_sessionBrand: undefined as any,
		status: vscode.ChatSessionStatus.Completed,
		sessionId: id,
		addUserMessage: (content: string) => { history.push(new ChatRequestTurn2(content, undefined, [], '', [], undefined)); },
		addUserAssistantMessage: (content: string) => { history.push(new ChatResponseTurn2([new ChatResponseMarkdownPart(new MarkdownString(content))], {}, '')); },
		handleRequest: async (prompt: string, _attachments: any[], _toolToken: any, stream: vscode.ChatResponseStream) => {
			history.push(new ChatRequestTurn2(prompt, undefined, [], '', [], undefined));
			stream.markdown('Response: ' + prompt);
			history.push(new ChatResponseTurn2([new ChatResponseMarkdownPart(new MarkdownString('Response: ' + prompt))], {}, ''));
		},
		getChatHistory: async () => history.slice(),
		getSelectedModelId: () => 'mock-model',
		_history: history
	} as any;
}

function createMockSessionService() {
	const onDidChange = new Emitter<void>();
	const sessions = new Map<string, MockSession>();
	return {
		_serviceBrand: undefined,
		onDidChangeSessions: onDidChange.event,
		getAllSessions: vi.fn(async () => Array.from(sessions.values()).map(s => ({ id: s.sessionId, label: 'Label ' + s.sessionId, timestamp: new Date(), status: s.status }))),
		getSession: vi.fn(async (id: string) => sessions.get(id)),
		createSession: vi.fn(async (prompt: string) => { const id = `sess-${prompt}-${sessions.size + 1}`; const s = createMockSession(id); sessions.set(id, s); onDidChange.fire(); return s; }),
		deleteSession: vi.fn(async (id: string) => { sessions.delete(id); onDidChange.fire(); })
	} as unknown as ICopilotCLISessionService;
}

function createMockModels(): ICopilotCLIModels {
	const available = [
		{ id: 'model-a', name: 'Model A', description: 'A' },
		{ id: 'model-b', name: 'Model B', description: 'B' },
		{ id: 'model-c', name: 'Model C', description: 'C' }
	];
	let def = available[0];
	return {
		_serviceBrand: undefined,
		getAvailableModels: vi.fn(async () => available),
		getDefaultModel: vi.fn(async () => def),
		setDefaultModel: vi.fn((m: vscode.ChatSessionProviderOptionItem) => { def = available.find(a => a.id === m.id) ?? def; }),
		toModelProvider: vi.fn((id: string) => id)
	} as any;
}

function createMockTerminalIntegration(): ICopilotCLITerminalIntegration {
	return { _serviceBrand: undefined, openTerminal: vi.fn(async () => { }) } as any;
}

function createMockPromptResolver(): CopilotCLIPromptResolver {
	return { resolvePrompt: vi.fn(async (request: vscode.ChatRequest) => ({ prompt: request.prompt, attachments: [] })) } as any;
}

function createMockSummarizer(): ChatSummarizerProvider {
	return { _serviceBrand: undefined, provideChatSummary: vi.fn(async () => 'Summary') } as any;
}

function createMockCloudProvider(uncommittedChangesHandled: boolean = false): CopilotChatSessionsProvider {
	return {
		_serviceBrand: undefined,
		onDidChangeChatSessionItems: Event.None,
		onDidCommitChatSessionItem: Event.None,
		refresh: () => { },
		provideChatSessionItems: vi.fn(async () => []),
		provideChatSessionContent: vi.fn(async () => ({ history: [] })),
		provideChatSessionProviderOptions: vi.fn(async () => ({ optionGroups: [] })),
		provideHandleOptionsChange: vi.fn(async () => { }),
		tryHandleUncommittedChanges: vi.fn(async () => uncommittedChangesHandled),
		createDelegatedChatSession: vi.fn(async () => ({ uri: 'https://example.com/pr/1', title: 'T & <Test>', description: 'Desc > details', author: 'Alice " Apos \'', linkTag: 'PR-1' }))
	} as any;
}

class CapturingStream implements Partial<vscode.ChatResponseStream> {
	output: string[] = [];
	markdown(v: string): void { this.output.push(v); }
	warning(v: string): void { this.output.push('[warn] ' + v); }
}

function createCapturingStream() {
	return new CapturingStream() as unknown as (vscode.ChatResponseStream & { output: string[] });
}

describe('copilotCLIChatSessionsContribution', () => {
	const store = new DisposableStore();
	let instantiationService: IInstantiationService;
	let sessionService: ICopilotCLISessionService;
	let models: ICopilotCLIModels;
	let terminal: ICopilotCLITerminalIntegration;
	let promptResolver: CopilotCLIPromptResolver;
	let summarizer: ChatSummarizerProvider;
	let cloudProvider: CopilotChatSessionsProvider;
	let itemProvider: CopilotCLIChatSessionItemProvider;
	let contentProvider: CopilotCLIChatSessionContentProvider;

	beforeEach(() => {
		const services = store.add(createExtensionUnitTestingServices());

		// Provide minimal vscode.commands/window stubs if missing
		if (!(vscode as any).commands) {
			(vscode as any).commands = {
				executeCommand: vi.fn().mockResolvedValue(undefined),
				registerCommand: vi.fn().mockImplementation((_id: string, _handler: Function) => ({ dispose() { } }))
			};
		} else {
			vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
			if (!('registerCommand' in vscode.commands)) {
				(vscode.commands as any).registerCommand = vi.fn().mockImplementation((_id: string, _handler: Function) => ({ dispose() { } }));
			}
		}
		if (!(vscode as any).window) {
			(vscode as any).window = { showWarningMessage: vi.fn().mockResolvedValue(undefined) } as any;
		} else if (!(vscode.window as any).showWarningMessage) {
			(vscode.window as any).showWarningMessage = vi.fn().mockResolvedValue(undefined);
		}
		// Minimal mocks
		sessionService = createMockSessionService();
		models = createMockModels();
		terminal = createMockTerminalIntegration();
		promptResolver = createMockPromptResolver();
		summarizer = createMockSummarizer();
		cloudProvider = createMockCloudProvider();

		services.define(ICopilotCLISessionService, sessionService as any);
		services.define(ICopilotCLIModels, models as any);
		services.define(ICopilotCLITerminalIntegration, terminal as any);
		instantiationService = services.createTestingAccessor().get(IInstantiationService);
		itemProvider = instantiationService.createInstance(CopilotCLIChatSessionItemProvider);
		contentProvider = instantiationService.createInstance(CopilotCLIChatSessionContentProvider);
	});

	afterEach(() => {
		store.clear();
		vi.clearAllMocks();
	});

	function createSessionIdUri(id: string) { return URI.parse(`copilotcli:/${id}`); }

	// ---------------- Item Provider ----------------
	it('lists sessions and maps to ChatSessionItems', async () => {
		await sessionService.createSession('Hello', undefined, CancellationToken.None);

		const items = await itemProvider.provideChatSessionItems(CancellationToken.None);
		expect(items.length).toBe(1);
		expect(items[0].resource.scheme).toBe('copilotcli');
	});

	it('fires refresh event', async () => {
		const spy = vi.fn();
		store.add(itemProvider.onDidChangeChatSessionItems(spy));

		itemProvider.refresh();

		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('fires swap event', () => {
		const spy = vi.fn();
		itemProvider.onDidCommitChatSessionItem(spy);
		const original: vscode.ChatSessionItem = { resource: createSessionIdUri('temp'), label: 'temp', timing: { startTime: Date.now() } };
		const modified: vscode.ChatSessionItem = { resource: createSessionIdUri('real'), label: 'real', timing: { startTime: Date.now() } };

		itemProvider.swap(original, modified);

		expect(spy).toHaveBeenCalledWith({ original, modified });
	});

	// ---------------- Content Provider ----------------
	it('returns empty history when session missing', async () => {
		const uri = createSessionIdUri('missing');

		const result = await contentProvider.provideChatSessionContent(uri, CancellationToken.None);
		expect(result.history).toEqual([]);
		expect(result.options?.model || result.options?.['model']).toBeDefined();
	});

	it('returns existing session history', async () => {
		// If we used the real SDK, then we'd have other items in history as well
		// However this is enough to verify that user and assistant messages are captured correctly.
		const s = await sessionService.createSession('Prompt', undefined, CancellationToken.None);
		s.addUserMessage('User turn');
		s.addUserAssistantMessage('Assistant turn');

		const uri = createSessionIdUri(s.sessionId);
		const result = await contentProvider.provideChatSessionContent(uri, CancellationToken.None);
		expect(mapHistoryForSnapshot(result.history)).toMatchInlineSnapshot(`
			[
			  {
			    "prompt": "User turn",
			    "type": "request",
			  },
			  {
			    "parts": [
			      {
			        "content": "Assistant turn",
			        "type": "markdown",
			      },
			    ],
			    "type": "response",
			  },
			]
		`);
	});

	it('provides model option group', async () => {
		const opts = await contentProvider.provideChatSessionProviderOptions();

		expect(opts.optionGroups?.[0]?.id).toBe('model');
		expect(opts.optionGroups?.[0]?.items?.length).toBeGreaterThan(1);
	});

	it('updates model preference via provideHandleOptionsChange', async () => {
		const s = await sessionService.createSession('Prompt', undefined, CancellationToken.None);
		const uri = createSessionIdUri(s.sessionId);

		await contentProvider.provideHandleOptionsChange(uri, [{ optionId: 'model', value: 'model-b' }], CancellationToken.None);
		let result = await contentProvider.provideChatSessionContent(uri, CancellationToken.None);
		expect(result.options?.['model']).toBe('model-b');

		// Change again
		await contentProvider.provideHandleOptionsChange(uri, [{ optionId: 'model', value: 'model-c' }], CancellationToken.None);
		result = await contentProvider.provideChatSessionContent(uri, CancellationToken.None);
		expect(result.options?.['model']).toBe('model-c');

		// New sessions should get model-c as default now
		const s2 = await sessionService.createSession('Prompt', undefined, CancellationToken.None);
		const uri2 = createSessionIdUri(s2.sessionId);

		result = await contentProvider.provideChatSessionContent(uri2, CancellationToken.None);
		expect(result.options?.['model']).toBe('model-c');
	});

	it('clears model preference when undefined', async () => {
		const s = await sessionService.createSession('Prompt', undefined, CancellationToken.None);
		const uri = createSessionIdUri(s.sessionId);

		await contentProvider.provideHandleOptionsChange(uri, [{ optionId: 'model', value: 'model-b' }], CancellationToken.None);
		await contentProvider.provideHandleOptionsChange(uri, [{ optionId: 'model', value: undefined }], CancellationToken.None);
		const result = await contentProvider.provideChatSessionContent(uri, CancellationToken.None);

		// Falls back to current default (persisted previously to model-b)
		expect(result.options?.['model']).toBe('model-b');
	});

	// ---------------- Participant ----------------
	it('creates new session for untitled context and swaps item', async () => {
		// First verify that there are no sessions.
		const itemsBefore = await itemProvider.provideChatSessionItems(CancellationToken.None);
		expect(itemsBefore.length).toBe(0);

		const participant = new CopilotCLIChatSessionParticipant(promptResolver as any, itemProvider, cloudProvider, summarizer as any, sessionService as any, { error: vi.fn(), info: vi.fn() } as any, models as any, { activeRepository: { get: () => undefined } } as any);
		const handler = participant.createHandler();
		const stream = createCapturingStream();
		const untitledItem: vscode.ChatSessionItem = { resource: createSessionIdUri('temp'), label: 'Temp', timing: { startTime: Date.now() } };
		const swapSpy = vi.fn();
		itemProvider.onDidCommitChatSessionItem(swapSpy);

		await handler({ prompt: 'Hello', toolInvocationToken: {} } as any, { chatSessionContext: { chatSessionItem: untitledItem, isUntitled: true } } as any, stream, CancellationToken.None);

		expect(swapSpy).toHaveBeenCalled();
		expect(stream.output.some(o => o.includes('Response'))).toBe(true);

		// Verify this session is in the item provider now
		const items = await itemProvider.provideChatSessionItems(CancellationToken.None);
		expect(items.length).toBe(1);
		expect(items[0].resource.toString()).not.toBe(untitledItem.resource.toString());
		expect(items[0].label).toContain('Hello');
	});

	it('attempt to use existing session will result in warning if missing', async () => {
		const participant = new CopilotCLIChatSessionParticipant(promptResolver as any, itemProvider, cloudProvider, summarizer as any, sessionService as any, { error: vi.fn(), info: vi.fn() } as any, models as any, { activeRepository: { get: () => undefined } } as any);
		const handler = participant.createHandler();
		const stream = createCapturingStream();
		const existingItem: vscode.ChatSessionItem = { resource: createSessionIdUri('does-not-exist'), label: 'X', timing: { startTime: Date.now() } };

		await handler({ prompt: 'Hello', toolInvocationToken: {} } as any, { chatSessionContext: { chatSessionItem: existingItem, isUntitled: false } } as any, stream, CancellationToken.None);

		expect(stream.output.some(o => o.includes('Chat session not found'))).toBe(true);
	});

	it('handles /delegate command and records push assistant message', async () => {
		const newSession = await sessionService.createSession('Initial', undefined, CancellationToken.None);
		const participant = new CopilotCLIChatSessionParticipant(promptResolver as any, itemProvider, cloudProvider, summarizer as any, sessionService as any, { error: vi.fn(), info: vi.fn() } as any, models as any, { activeRepository: { get: () => ({ changes: { indexChanges: [] } }) } } as any);
		const handler = participant.createHandler();
		const stream = createCapturingStream();
		const item: vscode.ChatSessionItem = { resource: createSessionIdUri(newSession.sessionId), label: 'S', timing: { startTime: Date.now() } };

		await handler({ prompt: '/delegate Implement & <feature>' } as any, { chatSessionContext: { chatSessionItem: item, isUntitled: false } } as any, stream, CancellationToken.None);

		const session = await sessionService.getSession(newSession.sessionId, undefined, false, CancellationToken.None);
		const hist = await session!.getChatHistory();

		// Last user & assistant message should contain the right messages
		const userText = (hist[hist.length - 2] as ChatRequestTurn2).prompt;
		expect(userText).toContain('Implement & <feature>');
		const assistantText = ((hist[hist.length - 1] as ChatResponseTurn2).response[0] as ChatResponseMarkdownPart).value.value;
		expect(assistantText).toContain('GitHub Copilot cloud agent has begun working on your request');
		expect(assistantText).toContain('Follow its progress in the associated chat and pull request');
	});

	it('handles /delegate command and does not records push assistant message', async () => {
		const newSession = await sessionService.createSession('Initial', undefined, CancellationToken.None);
		cloudProvider = createMockCloudProvider(true);
		const participant = new CopilotCLIChatSessionParticipant(promptResolver as any, itemProvider, cloudProvider, summarizer as any, sessionService as any, { error: vi.fn(), info: vi.fn() } as any, models as any, { activeRepository: { get: () => ({ changes: { indexChanges: [] } }) } } as any);
		const handler = participant.createHandler();
		const stream = createCapturingStream();
		const item: vscode.ChatSessionItem = { resource: createSessionIdUri(newSession.sessionId), label: 'S', timing: { startTime: Date.now() } };

		await handler({ prompt: '/delegate Implement & <feature>' } as any, { chatSessionContext: { chatSessionItem: item, isUntitled: false } } as any, stream, CancellationToken.None);

		const session = await sessionService.getSession(newSession.sessionId, undefined, false, CancellationToken.None);
		const hist = await session!.getChatHistory();

		expect(hist.length).toBe(0); // No messages recorded
	});

	it('push confirmation path creates new session when no context', async () => {
		const participant = new CopilotCLIChatSessionParticipant(promptResolver as any, itemProvider, cloudProvider, summarizer as any, sessionService as any, { error: vi.fn(), info: vi.fn() } as any, models as any, { activeRepository: { get: () => undefined } } as any);
		const handler = participant.createHandler();
		const stream = createCapturingStream();
		const openSpy = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

		await handler({ prompt: 'Do push' } as any, { chatSessionContext: undefined } as any, stream, CancellationToken.None);

		// Expect two executeCommand calls: open + submit
		expect(openSpy).toBeCalledTimes(2);
		expect(openSpy.mock.calls[0][0]).toBe('vscode.open');
		expect((openSpy.mock.calls[0][1] as Uri).scheme).toBe('copilotcli');
		expect(openSpy.mock.calls[1][0]).toBe('workbench.action.chat.submit');
		expect(openSpy.mock.calls[1][1].inputValue).toContain('Do push');
		openSpy.mockRestore();
	});

	// ---------------- Content Provider tool invocation history ----------------
	it('includes tool invocation part in snapshot', async () => {
		const s = await sessionService.createSession('Prompt', undefined, CancellationToken.None);
		const toolPart = new ChatToolInvocationPart('bash', 'tool-1', false);
		toolPart.isError = false;
		toolPart.toolName = 'bash';
		toolPart.toolCallId = 'tool-1';

		(s as MockSession)._history.push(new ChatResponseTurn2([toolPart], {}, ''));

		const uri = createSessionIdUri(s.sessionId);
		const result = await contentProvider.provideChatSessionContent(uri, CancellationToken.None);
		const snap = mapHistoryForSnapshot(result.history);
		expect(JSON.stringify(snap)).toMatch(/"toolName":"bash"/);
	});

	// ---------------- Commands ----------------
	it('registers and invokes refresh commands', () => {
		const regSpy = vi.spyOn(vscode.commands, 'registerCommand');
		const disposable = registerCLIChatCommands(itemProvider, sessionService);
		const registrations = regSpy.mock.calls.map(c => ({ id: c[0] as string, handler: c[1] as Function }));
		const refreshHandlers = registrations.filter(r => r.id.includes('refresh'));

		expect(refreshHandlers.length).toBe(2);

		const eventSpy = vi.fn();
		store.add(itemProvider.onDidChangeChatSessionItems(eventSpy));

		refreshHandlers.forEach(r => r.handler());

		expect(eventSpy).toHaveBeenCalledTimes(2);
		disposable.dispose();
	});

	it('invokes delete command after confirmation', async () => {
		const regSpy = vi.spyOn(vscode.commands, 'registerCommand');
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Delete' as any);
		const session = await sessionService.createSession('Prompt', undefined, CancellationToken.None);
		let items = await itemProvider.provideChatSessionItems(CancellationToken.None);
		expect(items.length).toBe(1);

		store.add(registerCLIChatCommands(itemProvider, sessionService));
		const registrations = regSpy.mock.calls.map(c => ({ id: c[0] as string, handler: c[1] as Function }));
		const del = registrations.find(r => r.id.endsWith('.delete'))!;

		await del.handler({ resource: createSessionIdUri(session.sessionId), label: 'X', timing: { startTime: Date.now() } });

		items = await itemProvider.provideChatSessionItems(CancellationToken.None);
		expect(items.length).toBe(0);
	});

	it('invokes resume terminnal commands', async () => {
		const regSpy = vi.spyOn(vscode.commands, 'registerCommand');
		const session = await sessionService.createSession('Prompt', undefined, CancellationToken.None);
		store.add(registerCLIChatCommands(itemProvider, sessionService));
		const registrations = regSpy.mock.calls.map(c => ({ id: c[0] as string, handler: c[1] as Function }));
		const resume = registrations.find(r => r.id.endsWith('.resumeInTerminal'))!;
		const openSpy = terminal.openTerminal as any;

		await resume.handler({ resource: createSessionIdUri(session.sessionId), label: 'X', timing: { startTime: Date.now() } });

		expect(openSpy.mock.calls.length).toBe(1);
	});

	it('invokes newTerminalSession commands', async () => {
		const regSpy = vi.spyOn(vscode.commands, 'registerCommand');
		store.add(registerCLIChatCommands(itemProvider, sessionService));
		const registrations = regSpy.mock.calls.map(c => ({ id: c[0] as string, handler: c[1] as Function }));
		const newTerm = registrations.find(r => r.id.endsWith('.newTerminalSession'))!;
		const openSpy = terminal.openTerminal as any;

		await newTerm.handler();

		expect(openSpy.mock.calls.length).toBe(1);
	});
});
