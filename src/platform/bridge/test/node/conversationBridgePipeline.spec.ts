/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatResult } from 'vscode';
import { RawData, WebSocket } from 'ws';
import {
	IConversationAssistantCodeCitationItem,
	IConversationAssistantCommandButtonItem,
	IConversationAssistantConfirmationItem,
	IConversationAssistantExtraItem,
	IConversationAssistantQuestionCarouselItem,
	IConversationAssistantReferenceItem,
	IConversationAssistantStatusItem,
	IConversationAssistantToolInvocationItem,
	IConversationStore,
	IConversationSummary,
	IConversationTurnArtifacts,
	IConversationTurnChunkEvent,
	IConversationTurnCodeCitationEvent,
	IConversationTurnCommandButtonEvent,
	IConversationTurnConfirmationEvent,
	IConversationTurnEvent,
	IConversationTurnExtraEvent,
	IConversationTurnLifecycleEvent,
	IConversationTurnQuestionCarouselEvent,
	IConversationTurnReferenceEvent,
	IConversationTurnStatusEvent,
	IConversationTurnToolInvocationEvent,
} from '../../../../extension/conversationStore/node/conversationStore';
import { Conversation, Turn, TurnStatus } from '../../../../extension/prompt/common/conversation';
import { Emitter, Event } from '../../../../util/vs/base/common/event';
import { URI } from '../../../../util/vs/base/common/uri';
import { IVSCodeExtensionContext } from '../../../extContext/common/extensionContext';
import { FileType } from '../../../filesystem/common/fileTypes';
import { MockFileSystemService } from '../../../filesystem/node/test/mockFileSystemService';
import { TestLogService } from '../../../testing/common/testLogService';
import { BridgeConversationSummary, BridgeMessage, BridgeServer } from '../../bridgeServer';
import { ConversationBridge } from '../../conversationBridge';

class TestConversationStore implements IConversationStore {
	readonly _serviceBrand: undefined;

	private readonly onDidConversationListChangedEmitter = new Emitter<void>();
	readonly onDidConversationListChanged: Event<void> = this.onDidConversationListChangedEmitter.event;

	private readonly onDidUserTurnEmitter = new Emitter<IConversationTurnEvent>();
	readonly onDidUserTurn: Event<IConversationTurnEvent> = this.onDidUserTurnEmitter.event;

	private readonly onDidAssistantTurnStartEmitter = new Emitter<IConversationTurnLifecycleEvent>();
	readonly onDidAssistantTurnStart: Event<IConversationTurnLifecycleEvent> = this.onDidAssistantTurnStartEmitter.event;

	private readonly onDidAssistantTurnChunkEmitter = new Emitter<IConversationTurnChunkEvent>();
	readonly onDidAssistantTurnChunk: Event<IConversationTurnChunkEvent> = this.onDidAssistantTurnChunkEmitter.event;

	private readonly onDidAssistantTurnReferenceEmitter = new Emitter<IConversationTurnReferenceEvent>();
	readonly onDidAssistantTurnReference: Event<IConversationTurnReferenceEvent> = this.onDidAssistantTurnReferenceEmitter.event;

	private readonly onDidAssistantTurnCodeCitationEmitter = new Emitter<IConversationTurnCodeCitationEvent>();
	readonly onDidAssistantTurnCodeCitation: Event<IConversationTurnCodeCitationEvent> = this.onDidAssistantTurnCodeCitationEmitter.event;

	private readonly onDidAssistantTurnStatusEmitter = new Emitter<IConversationTurnStatusEvent>();
	readonly onDidAssistantTurnStatus: Event<IConversationTurnStatusEvent> = this.onDidAssistantTurnStatusEmitter.event;

	private readonly onDidAssistantTurnToolInvocationEmitter = new Emitter<IConversationTurnToolInvocationEvent>();
	readonly onDidAssistantTurnToolInvocation: Event<IConversationTurnToolInvocationEvent> = this.onDidAssistantTurnToolInvocationEmitter.event;

	private readonly onDidAssistantTurnConfirmationEmitter = new Emitter<IConversationTurnConfirmationEvent>();
	readonly onDidAssistantTurnConfirmation: Event<IConversationTurnConfirmationEvent> = this.onDidAssistantTurnConfirmationEmitter.event;

	private readonly onDidAssistantTurnQuestionCarouselEmitter = new Emitter<IConversationTurnQuestionCarouselEvent>();
	readonly onDidAssistantTurnQuestionCarousel: Event<IConversationTurnQuestionCarouselEvent> = this.onDidAssistantTurnQuestionCarouselEmitter.event;

	private readonly onDidAssistantTurnCommandButtonEmitter = new Emitter<IConversationTurnCommandButtonEvent>();
	readonly onDidAssistantTurnCommandButton: Event<IConversationTurnCommandButtonEvent> = this.onDidAssistantTurnCommandButtonEmitter.event;

	private readonly onDidAssistantTurnExtraEmitter = new Emitter<IConversationTurnExtraEvent>();
	readonly onDidAssistantTurnExtra: Event<IConversationTurnExtraEvent> = this.onDidAssistantTurnExtraEmitter.event;

	private readonly onDidAssistantTurnCompleteEmitter = new Emitter<IConversationTurnLifecycleEvent>();
	readonly onDidAssistantTurnComplete: Event<IConversationTurnLifecycleEvent> = this.onDidAssistantTurnCompleteEmitter.event;

	private readonly conversationsByResponseId = new Map<string, Conversation>();
	private readonly conversationsBySessionId = new Map<string, Conversation>();
	private readonly assistantArtifactsByTurn = new Map<string, {
		statuses: IConversationAssistantStatusItem[];
		tools: IConversationAssistantToolInvocationItem[];
		references: IConversationAssistantReferenceItem[];
		codeCitations: IConversationAssistantCodeCitationItem[];
		confirmations: IConversationAssistantConfirmationItem[];
		questionCarousels: IConversationAssistantQuestionCarouselItem[];
		commandButtons: IConversationAssistantCommandButtonItem[];
		extras: IConversationAssistantExtraItem[];
	}>();
	private summaries: readonly IConversationSummary[] = [];
	private _lastConversation: Conversation | undefined;

	addConversation(responseId: string, conversation: Conversation): void {
		this.conversationsByResponseId.set(responseId, conversation);
		this.conversationsBySessionId.set(conversation.sessionId, conversation);
		this._lastConversation = conversation;
		this.onDidConversationListChangedEmitter.fire();
	}

	getConversation(responseId: string): Conversation | undefined {
		return this.conversationsByResponseId.get(responseId);
	}

	getConversationBySessionId(sessionId: string): Conversation | undefined {
		return this.conversationsBySessionId.get(sessionId);
	}

	getAssistantTurnArtifacts(conversationId: string, turnId: string): IConversationTurnArtifacts | undefined {
		const artifacts = this.assistantArtifactsByTurn.get(this.getArtifactsKey(conversationId, turnId));
		if (!artifacts) {
			return undefined;
		}

		return {
			statuses: [...artifacts.statuses],
			tools: [...artifacts.tools],
			references: [...artifacts.references],
			codeCitations: [...artifacts.codeCitations],
			confirmations: [...artifacts.confirmations],
			questionCarousels: [...artifacts.questionCarousels],
			commandButtons: [...artifacts.commandButtons],
			extras: [...artifacts.extras],
		};
	}

	listConversations(): readonly IConversationSummary[] {
		return this.summaries;
	}

	reportUserTurn(event: IConversationTurnEvent): void {
		this.onDidUserTurnEmitter.fire(event);
	}

	reportAssistantTurnStart(event: IConversationTurnLifecycleEvent): void {
		this.onDidAssistantTurnStartEmitter.fire(event);
	}

	reportAssistantTurnChunk(event: IConversationTurnChunkEvent): void {
		this.onDidAssistantTurnChunkEmitter.fire(event);
	}

	reportAssistantTurnReference(event: IConversationTurnReferenceEvent): void {
		const artifacts = this.getOrCreateArtifacts(event.conversationId, event.turnId);
		artifacts.references.push({
			label: event.label,
			uri: event.uri,
		});
		this.onDidAssistantTurnReferenceEmitter.fire(event);
	}

	reportAssistantTurnCodeCitation(event: IConversationTurnCodeCitationEvent): void {
		const artifacts = this.getOrCreateArtifacts(event.conversationId, event.turnId);
		artifacts.codeCitations.push({
			uri: event.uri,
			license: event.license,
			snippet: event.snippet,
		});
		this.onDidAssistantTurnCodeCitationEmitter.fire(event);
	}

	reportAssistantTurnStatus(event: IConversationTurnStatusEvent): void {
		const artifacts = this.getOrCreateArtifacts(event.conversationId, event.turnId);
		artifacts.statuses.push({
			kind: event.kind,
			content: event.content,
		});
		this.onDidAssistantTurnStatusEmitter.fire(event);
	}

	reportAssistantTurnToolInvocation(event: IConversationTurnToolInvocationEvent): void {
		const artifacts = this.getOrCreateArtifacts(event.conversationId, event.turnId);
		artifacts.tools.push({
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			message: event.message,
			isError: event.isError,
			isComplete: event.isComplete,
		});
		this.onDidAssistantTurnToolInvocationEmitter.fire(event);
	}

	reportAssistantTurnConfirmation(event: IConversationTurnConfirmationEvent): void {
		const artifacts = this.getOrCreateArtifacts(event.conversationId, event.turnId);
		artifacts.confirmations.push({
			title: event.title,
			message: event.message,
			buttons: event.buttons,
		});
		this.onDidAssistantTurnConfirmationEmitter.fire(event);
	}

	reportAssistantTurnQuestionCarousel(event: IConversationTurnQuestionCarouselEvent): void {
		const artifacts = this.getOrCreateArtifacts(event.conversationId, event.turnId);
		artifacts.questionCarousels.push({
			allowSkip: event.allowSkip,
			questions: [...event.questions],
		});
		this.onDidAssistantTurnQuestionCarouselEmitter.fire(event);
	}

	reportAssistantTurnCommandButton(event: IConversationTurnCommandButtonEvent): void {
		const artifacts = this.getOrCreateArtifacts(event.conversationId, event.turnId);
		artifacts.commandButtons.push({
			commandId: event.commandId,
			title: event.title,
			args: event.args,
		});
		this.onDidAssistantTurnCommandButtonEmitter.fire(event);
	}

	reportAssistantTurnExtra(event: IConversationTurnExtraEvent): void {
		const artifacts = this.getOrCreateArtifacts(event.conversationId, event.turnId);
		artifacts.extras.push(event.extra);
		this.onDidAssistantTurnExtraEmitter.fire(event);
	}

	reportAssistantTurnComplete(event: IConversationTurnLifecycleEvent): void {
		this.onDidAssistantTurnCompleteEmitter.fire(event);
	}

	get lastConversation(): Conversation | undefined {
		return this._lastConversation;
	}

	setConversation(conversation: Conversation): void {
		this.conversationsBySessionId.set(conversation.sessionId, conversation);
		this._lastConversation = conversation;
	}

	setSummaries(summaries: readonly IConversationSummary[]): void {
		this.summaries = summaries;
	}

	private getOrCreateArtifacts(conversationId: string, turnId: string): {
		statuses: IConversationAssistantStatusItem[];
		tools: IConversationAssistantToolInvocationItem[];
		references: IConversationAssistantReferenceItem[];
		codeCitations: IConversationAssistantCodeCitationItem[];
		confirmations: IConversationAssistantConfirmationItem[];
		questionCarousels: IConversationAssistantQuestionCarouselItem[];
		commandButtons: IConversationAssistantCommandButtonItem[];
		extras: IConversationAssistantExtraItem[];
	} {
		const key = this.getArtifactsKey(conversationId, turnId);
		let artifacts = this.assistantArtifactsByTurn.get(key);
		if (!artifacts) {
			artifacts = {
				statuses: [],
				tools: [],
				references: [],
				codeCitations: [],
				confirmations: [],
				questionCarousels: [],
				commandButtons: [],
				extras: [],
			};
			this.assistantArtifactsByTurn.set(key, artifacts);
		}

		return artifacts;
	}

	private getArtifactsKey(conversationId: string, turnId: string): string {
		return `${conversationId}:${turnId}`;
	}

	dispose(): void {
		this.onDidConversationListChangedEmitter.dispose();
		this.onDidUserTurnEmitter.dispose();
		this.onDidAssistantTurnStartEmitter.dispose();
		this.onDidAssistantTurnChunkEmitter.dispose();
		this.onDidAssistantTurnReferenceEmitter.dispose();
		this.onDidAssistantTurnCodeCitationEmitter.dispose();
		this.onDidAssistantTurnStatusEmitter.dispose();
		this.onDidAssistantTurnToolInvocationEmitter.dispose();
		this.onDidAssistantTurnConfirmationEmitter.dispose();
		this.onDidAssistantTurnQuestionCarouselEmitter.dispose();
		this.onDidAssistantTurnCommandButtonEmitter.dispose();
		this.onDidAssistantTurnExtraEmitter.dispose();
		this.onDidAssistantTurnCompleteEmitter.dispose();
	}
}

class BridgeClient {
	private readonly _messages: BridgeMessage[] = [];

	constructor(readonly socket: WebSocket) {
		socket.on('message', data => {
			this._messages.push(parseBridgeMessage(data));
		});
	}

	get messages(): readonly BridgeMessage[] {
		return this._messages;
	}

	send(message: unknown): void {
		this.socket.send(JSON.stringify(message));
	}

	countType(type: BridgeMessage['type']): number {
		return this._messages.filter(message => message.type === type).length;
	}

	async waitForType<TType extends BridgeMessage['type']>(type: TType, occurrence = 1): Promise<Extract<BridgeMessage, { type: TType }>> {
		await vi.waitFor(() => {
			expect(this.countType(type)).toBeGreaterThanOrEqual(occurrence);
		}, { timeout: 5000 });

		const typedMessages = this._messages.filter((message): message is Extract<BridgeMessage, { type: TType }> => message.type === type);
		return typedMessages[occurrence - 1];
	}

	async close(): Promise<void> {
		if (this.socket.readyState === WebSocket.CLOSED) {
			return;
		}

		await new Promise<void>(resolve => {
			this.socket.once('close', () => {
				resolve();
			});
			this.socket.close();
		});
	}
}

type BridgeHarness = {
	readonly bridgeServer: BridgeServer;
	readonly bridge: ConversationBridge;
	readonly store: TestConversationStore;
	readonly client: BridgeClient;
	setProviderSummaries(summaries: readonly BridgeConversationSummary[]): void;
};

type HarnessWorkspaceSessionFile = {
	readonly id: string;
	readonly contents: string;
	readonly mtime: number;
};

type BridgeHarnessOptions = {
	readonly storageUri?: URI;
	readonly workspaceSessionFiles?: readonly HarnessWorkspaceSessionFile[];
};

function parseBridgeMessage(data: RawData): BridgeMessage {
	if (typeof data === 'string') {
		return JSON.parse(data) as BridgeMessage;
	}
	if (Buffer.isBuffer(data)) {
		return JSON.parse(data.toString('utf8')) as BridgeMessage;
	}
	if (Array.isArray(data)) {
		return JSON.parse(Buffer.concat(data).toString('utf8')) as BridgeMessage;
	}
	return JSON.parse(data.toString()) as BridgeMessage;
}

async function connectClient(port: number, token: string): Promise<BridgeClient> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
	const client = new BridgeClient(socket);
	await new Promise<void>((resolve, reject) => {
		const onClose = () => {
			socket.off('open', onOpen);
			socket.off('error', onError);
			reject(new Error('WebSocket closed before opening'));
		};
		const onOpen = () => {
			socket.off('error', onError);
			socket.off('close', onClose);
			resolve();
		};
		const onError = (error: Error) => {
			socket.off('open', onOpen);
			socket.off('close', onClose);
			reject(error);
		};
		socket.once('open', onOpen);
		socket.once('error', onError);
		socket.once('close', onClose);
	});
	return client;
}

async function createHarness(initialProviderSummaries: readonly BridgeConversationSummary[], options: BridgeHarnessOptions = {}): Promise<BridgeHarness> {
	let providerSummaries = [...initialProviderSummaries];
	const bridgeServer = new BridgeServer();
	const store = new TestConversationStore();
	const fileSystemService = new MockFileSystemService();
	const logService = new TestLogService();
	if (options.storageUri && options.workspaceSessionFiles && options.workspaceSessionFiles.length > 0) {
		const workspaceChatSessionsDirUri = URI.joinPath(options.storageUri, '..', 'chatSessions');
		fileSystemService.mockDirectory(workspaceChatSessionsDirUri, options.workspaceSessionFiles.map(file => [`${file.id}.jsonl`, FileType.File]));
		for (const file of options.workspaceSessionFiles) {
			const sessionFileUri = URI.joinPath(workspaceChatSessionsDirUri, `${file.id}.jsonl`);
			fileSystemService.mockFile(sessionFileUri, file.contents, file.mtime);
		}
	}
	const extensionContext = {
		storageUri: options.storageUri,
		globalStorageUri: undefined,
	} as unknown as IVSCodeExtensionContext;
	const bridge = new ConversationBridge(
		bridgeServer,
		store,
		logService,
		fileSystemService,
		extensionContext,
		async () => providerSummaries,
	);
	bridge.activate();

	const port = await bridgeServer.start();
	const client = await connectClient(port, bridgeServer.sessionToken);

	return {
		bridgeServer,
		bridge,
		store,
		client,
		setProviderSummaries(summaries: readonly BridgeConversationSummary[]) {
			providerSummaries = [...summaries];
		},
	};
}

function createConversationWithAssistantResponse(sessionId: string, prompt: string, response: string): Conversation {
	const turn = new Turn('turn-1', { message: prompt, type: 'user' });
	turn.setResponse(TurnStatus.Success, { message: response, type: 'model' }, 'response-1', undefined);
	return new Conversation(sessionId, [turn]);
}

function createConversationWithRoundFallbackResponse(sessionId: string, prompt: string, roundResponse: string): Conversation {
	const turn = new Turn('turn-1', { message: prompt, type: 'user' });
	turn.setResponse(TurnStatus.Success, undefined, 'response-1', {
		metadata: {
			modelMessageId: 'model-message-1',
			responseId: 'response-1',
			sessionId,
			agentId: 'agent',
			toolCallRounds: [
				{
					id: 'round-1',
					response: roundResponse,
					toolInputRetry: 0,
					toolCalls: [],
				},
			],
		},
	} as unknown as ChatResult);
	return new Conversation(sessionId, [turn]);
}

function createWorkspaceChatSessionFileContents(requests: readonly unknown[], customTitle?: string): string {
	const state: Record<string, unknown> = { requests };
	if (customTitle) {
		state.customTitle = customTitle;
	}

	return `${JSON.stringify({ kind: 0, v: state })}\n`;
}

describe('ConversationBridge pipeline', () => {
	let harness: BridgeHarness | undefined;

	afterEach(async () => {
		if (harness) {
			await harness.client.close();
			harness.bridge.dispose();
			await harness.bridgeServer.stop();
			harness.bridgeServer.dispose();
			harness.store.dispose();
			harness = undefined;
		}
	});

	test('sends snapshot on connect and returns conversation history over the socket', async () => {
		const summary: BridgeConversationSummary = {
			id: 'session-1',
			title: 'Ship release',
			lastUpdated: 1712345678901,
			provider: 'cloud',
			status: 'completed',
		};
		harness = await createHarness([summary]);
		harness.store.setConversation(createConversationWithAssistantResponse('session-1', 'How is release?', 'Release is healthy'));

		const conversationListMessage = await harness.client.waitForType('conversation:list');
		expect(conversationListMessage.conversations).toEqual([summary]);

		const uiStateMessage = await harness.client.waitForType('ui:state');
		expect(uiStateMessage.selectedModeId).toBe('agent');
		expect(uiStateMessage.modes.map(mode => mode.id)).toEqual(['agent', 'ask', 'plan']);

		harness.client.send({ type: 'conversation:select', conversationId: 'session-1' });
		const conversationHistoryMessage = await harness.client.waitForType('conversation:history');
		expect(conversationHistoryMessage.conversationId).toBe('session-1');
		expect(conversationHistoryMessage.turns).toEqual([
			{ role: 'user', content: 'How is release?', timestamp: expect.any(Number) },
			{ role: 'assistant', content: 'Release is healthy', timestamp: expect.any(Number) },
		]);
	});

	test('normalizes plan mode ids and command mode casing', async () => {
		harness = await createHarness([]);
		const privateBridge = harness.bridge as unknown as {
			normalizeModeId(modeId: string): string;
			modeIdForCommand(modeId: string): string;
		};

		await harness.client.waitForType('conversation:list');
		const uiStateMessage = await harness.client.waitForType('ui:state');
		expect(uiStateMessage.modes.map(mode => mode.id)).toContain('plan');
		expect(privateBridge.normalizeModeId('plan')).toBe('plan');
		expect(privateBridge.normalizeModeId('Plan')).toBe('plan');
		expect(privateBridge.normalizeModeId('ask')).toBe('ask');
		expect(privateBridge.normalizeModeId('Agent')).toBe('agent');
		expect(privateBridge.modeIdForCommand('plan')).toBe('Plan');
		expect(privateBridge.modeIdForCommand('ask')).toBe('Ask');
		expect(privateBridge.modeIdForCommand('agent')).toBe('Agent');
	});

	test('uses provider summaries as canonical list when provider sessions are available', async () => {
		const storageUri = URI.parse('file:///workspace/.storage/provider-canonical');
		harness = await createHarness(
			[
				{
					id: 'provider-session',
					title: 'Provider canonical title',
					lastUpdated: 1000,
					provider: 'cloud',
					status: 'completed',
				},
			],
			{
				storageUri,
				workspaceSessionFiles: [
					{
						id: 'provider-session',
						contents: createWorkspaceChatSessionFileContents([{ request: { message: 'Workspace title should not win' } }], 'Workspace title should not win'),
						mtime: 2000,
					},
					{
						id: 'stale-session',
						contents: createWorkspaceChatSessionFileContents([{ request: { message: 'Stale workspace session' } }], 'Stale workspace session'),
						mtime: 3000,
					},
				],
			}
		);

		const conversationListMessage = await harness.client.waitForType('conversation:list');
		expect(conversationListMessage.conversations).toEqual([
			{
				id: 'provider-session',
				title: 'Provider canonical title',
				lastUpdated: 2000,
				provider: 'cloud',
				status: 'completed',
			},
		]);
	});

	test('replaces generic provider titles with descriptive workspace titles', async () => {
		const storageUri = URI.parse('file:///workspace/.storage/provider-generic-title');
		harness = await createHarness(
			[
				{
					id: 'provider-session',
					title: 'Conversation',
					lastUpdated: 1000,
					provider: 'cloud',
					status: 'completed',
				},
			],
			{
				storageUri,
				workspaceSessionFiles: [
					{
						id: 'provider-session',
						contents: createWorkspaceChatSessionFileContents([{ request: { message: 'Workspace descriptive title' } }], 'Workspace descriptive title'),
						mtime: 2000,
					},
				],
			}
		);

		const conversationListMessage = await harness.client.waitForType('conversation:list');
		expect(conversationListMessage.conversations).toEqual([
			{
				id: 'provider-session',
				title: 'Workspace descriptive title',
				lastUpdated: 2000,
				provider: 'cloud',
				status: 'completed',
			},
		]);
	});

	test('extracts assistant history from response value parts and skips thinking content', async () => {
		const storageUri = URI.parse('file:///workspace/.storage/response-values');
		harness = await createHarness([], {
			storageUri,
			workspaceSessionFiles: [
				{
					id: 'session-value',
					contents: createWorkspaceChatSessionFileContents([
						{
							request: { message: 'What changed?' },
							response: [
								{ kind: 'thinking', value: 'internal reasoning that should be hidden' },
								{ kind: 'markdown', value: 'Applied fix in response value' },
							],
						},
					]),
					mtime: 1712345678000,
				},
			],
		});

		await harness.client.waitForType('conversation:list');
		await harness.client.waitForType('ui:state');

		harness.client.send({ type: 'conversation:select', conversationId: 'session-value' });
		const historyMessage = await harness.client.waitForType('conversation:history');
		expect(historyMessage.turns).toEqual([
			{ role: 'user', content: 'What changed?', timestamp: expect.any(Number) },
			{ role: 'assistant', content: 'Applied fix in response value', timestamp: expect.any(Number) },
		]);
	});

	test('falls back to round responses when responseMessage is missing', async () => {
		harness = await createHarness([]);
		await harness.client.waitForType('conversation:list');
		await harness.client.waitForType('ui:state');

		harness.store.setConversation(createConversationWithRoundFallbackResponse('session-rounds', 'Need a status update', 'Round response fallback works'));
		harness.client.send({ type: 'conversation:select', conversationId: 'session-rounds' });

		const historyMessage = await harness.client.waitForType('conversation:history');
		expect(historyMessage.turns).toEqual([
			{ role: 'user', content: 'Need a status update', timestamp: expect.any(Number) },
			{ role: 'assistant', content: 'Round response fallback works', timestamp: expect.any(Number) },
		]);
	});

	test('broadcasts turn lifecycle events and refreshes conversation list after completion', async () => {
		const summary: BridgeConversationSummary = {
			id: 'session-2',
			title: 'Bridge stream',
			lastUpdated: 1712345678999,
			provider: 'claude',
			status: 'in-progress',
		};
		harness = await createHarness([summary]);

		await harness.client.waitForType('conversation:list');
		await harness.client.waitForType('ui:state');
		const initialListCount = harness.client.countType('conversation:list');

		harness.store.reportUserTurn({
			conversationId: 'session-2',
			turnId: 'turn-2',
			content: 'Start streaming',
			timestamp: Date.now(),
		});
		harness.store.reportAssistantTurnStart({
			conversationId: 'session-2',
			turnId: 'turn-2',
		});
		harness.store.reportAssistantTurnChunk({
			conversationId: 'session-2',
			turnId: 'turn-2',
			content: 'Chunk A',
		});
		harness.store.reportAssistantTurnReference({
			conversationId: 'session-2',
			turnId: 'turn-2',
			label: 'README.md',
			uri: 'file:///workspace/README.md',
		});
		harness.store.reportAssistantTurnCodeCitation({
			conversationId: 'session-2',
			turnId: 'turn-2',
			uri: 'file:///workspace/LICENSE.txt',
			license: 'MIT',
			snippet: 'Copyright (c) Microsoft Corporation.',
		});
		harness.store.reportAssistantTurnStatus({
			conversationId: 'session-2',
			turnId: 'turn-2',
			kind: 'thinking',
			content: 'Planning next steps',
		});
		harness.store.reportAssistantTurnToolInvocation({
			conversationId: 'session-2',
			turnId: 'turn-2',
			toolName: 'grep_search',
			toolCallId: 'tool-1',
			message: 'Searching workspace',
			isError: false,
			isComplete: false,
		});
		harness.store.reportAssistantTurnConfirmation({
			conversationId: 'session-2',
			turnId: 'turn-2',
			title: 'Apply changes?',
			message: 'Review and approve edits',
			buttons: ['Accept', 'Reject'],
		});
		harness.store.reportAssistantTurnQuestionCarousel({
			conversationId: 'session-2',
			turnId: 'turn-2',
			allowSkip: true,
			questions: [
				{
					id: 'q1',
					type: 'singleSelect',
					title: 'Pick a target',
					message: 'Choose one',
					options: ['web', 'desktop'],
					allowFreeformInput: false,
				},
			],
		});
		harness.store.reportAssistantTurnCommandButton({
			conversationId: 'session-2',
			turnId: 'turn-2',
			commandId: 'workbench.action.chat.open',
			title: 'Open Chat',
			args: [{ query: 'Hello' }],
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'textEdit',
				uri: 'file:///workspace/src/index.ts',
				editCount: 2,
				isDone: false,
			},
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'extensions',
				extensions: ['ms-python.python', 'github.copilot-chat'],
			},
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'pullRequest',
				title: 'Fix chat parity',
				description: 'Adds missing streaming part support',
				author: 'octocat',
				linkTag: 'PR',
				commandId: 'vscode.open',
				commandArgs: ['https://github.com/org/repo/pull/42'],
			},
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'externalEdit',
				uris: ['file:///workspace/src/one.ts', 'file:///workspace/src/two.ts'],
			},
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'multiDiff',
				title: 'Proposed changes',
				readOnly: true,
				entries: [
					{
						originalUri: 'file:///workspace/src/old.ts',
						modifiedUri: 'file:///workspace/src/new.ts',
						goToFileUri: 'file:///workspace/src/new.ts',
						added: 10,
						removed: 3,
					},
				],
			},
		});
		harness.store.reportAssistantTurnComplete({
			conversationId: 'session-2',
			turnId: 'turn-2',
		});

		const userTurnMessage = await harness.client.waitForType('turn:user');
		expect(userTurnMessage.content).toBe('Start streaming');

		const assistantStartMessage = await harness.client.waitForType('turn:start');
		expect(assistantStartMessage.turnId).toBe('turn-2');

		const assistantChunkMessage = await harness.client.waitForType('turn:chunk');
		expect(assistantChunkMessage.content).toBe('Chunk A');

		const assistantReferenceMessage = await harness.client.waitForType('turn:reference');
		expect(assistantReferenceMessage).toEqual({
			type: 'turn:reference',
			conversationId: 'session-2',
			turnId: 'turn-2',
			label: 'README.md',
			uri: 'file:///workspace/README.md',
		});

		const assistantCodeCitationMessage = await harness.client.waitForType('turn:codeCitation');
		expect(assistantCodeCitationMessage).toEqual({
			type: 'turn:codeCitation',
			conversationId: 'session-2',
			turnId: 'turn-2',
			uri: 'file:///workspace/LICENSE.txt',
			license: 'MIT',
			snippet: 'Copyright (c) Microsoft Corporation.',
		});

		const assistantStatusMessage = await harness.client.waitForType('turn:status');
		expect(assistantStatusMessage).toEqual({
			type: 'turn:status',
			conversationId: 'session-2',
			turnId: 'turn-2',
			kind: 'thinking',
			content: 'Planning next steps',
		});

		const assistantToolMessage = await harness.client.waitForType('turn:tool');
		expect(assistantToolMessage).toEqual({
			type: 'turn:tool',
			conversationId: 'session-2',
			turnId: 'turn-2',
			toolName: 'grep_search',
			toolCallId: 'tool-1',
			message: 'Searching workspace',
			isError: false,
			isComplete: false,
		});

		const assistantConfirmationMessage = await harness.client.waitForType('turn:confirmation');
		expect(assistantConfirmationMessage).toEqual({
			type: 'turn:confirmation',
			conversationId: 'session-2',
			turnId: 'turn-2',
			title: 'Apply changes?',
			message: 'Review and approve edits',
			buttons: ['Accept', 'Reject'],
		});

		const assistantQuestionsMessage = await harness.client.waitForType('turn:questions');
		expect(assistantQuestionsMessage).toEqual({
			type: 'turn:questions',
			conversationId: 'session-2',
			turnId: 'turn-2',
			allowSkip: true,
			questions: [
				{
					id: 'q1',
					type: 'singleSelect',
					title: 'Pick a target',
					message: 'Choose one',
					options: ['web', 'desktop'],
					allowFreeformInput: false,
				},
			],
		});

		const assistantButtonMessage = await harness.client.waitForType('turn:button');
		expect(assistantButtonMessage).toEqual({
			type: 'turn:button',
			conversationId: 'session-2',
			turnId: 'turn-2',
			commandId: 'workbench.action.chat.open',
			title: 'Open Chat',
			args: [{ query: 'Hello' }],
		});

		const assistantExtraMessage = await harness.client.waitForType('turn:extra');
		expect(assistantExtraMessage).toEqual({
			type: 'turn:extra',
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'textEdit',
				uri: 'file:///workspace/src/index.ts',
				editCount: 2,
				isDone: false,
			},
		});

		const assistantExtensionsExtraMessage = await harness.client.waitForType('turn:extra', 2);
		expect(assistantExtensionsExtraMessage).toEqual({
			type: 'turn:extra',
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'extensions',
				extensions: ['ms-python.python', 'github.copilot-chat'],
			},
		});

		const assistantPullRequestExtraMessage = await harness.client.waitForType('turn:extra', 3);
		expect(assistantPullRequestExtraMessage).toEqual({
			type: 'turn:extra',
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'pullRequest',
				title: 'Fix chat parity',
				description: 'Adds missing streaming part support',
				author: 'octocat',
				linkTag: 'PR',
				commandId: 'vscode.open',
				commandArgs: ['https://github.com/org/repo/pull/42'],
			},
		});

		const assistantExternalEditExtraMessage = await harness.client.waitForType('turn:extra', 4);
		expect(assistantExternalEditExtraMessage).toEqual({
			type: 'turn:extra',
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'externalEdit',
				uris: ['file:///workspace/src/one.ts', 'file:///workspace/src/two.ts'],
			},
		});

		const assistantMultiDiffExtraMessage = await harness.client.waitForType('turn:extra', 5);
		expect(assistantMultiDiffExtraMessage).toEqual({
			type: 'turn:extra',
			conversationId: 'session-2',
			turnId: 'turn-2',
			extra: {
				kind: 'multiDiff',
				title: 'Proposed changes',
				readOnly: true,
				entries: [
					{
						originalUri: 'file:///workspace/src/old.ts',
						modifiedUri: 'file:///workspace/src/new.ts',
						goToFileUri: 'file:///workspace/src/new.ts',
						added: 10,
						removed: 3,
					},
				],
			},
		});

		const assistantCompleteMessage = await harness.client.waitForType('turn:complete');
		expect(assistantCompleteMessage.turnId).toBe('turn-2');

		const refreshedConversationList = await harness.client.waitForType('conversation:list', initialListCount + 1);
		expect(refreshedConversationList.conversations[0]?.id).toBe('session-2');
	});

	test('rehydrates assistant artifacts in conversation history', async () => {
		harness = await createHarness([]);
		await harness.client.waitForType('conversation:list');
		await harness.client.waitForType('ui:state');

		harness.store.setConversation(createConversationWithAssistantResponse('session-3', 'What happened?', 'Summary response'));
		harness.store.reportAssistantTurnStatus({
			conversationId: 'session-3',
			turnId: 'turn-1',
			kind: 'progress',
			content: 'Gathering context',
		});
		harness.store.reportAssistantTurnToolInvocation({
			conversationId: 'session-3',
			turnId: 'turn-1',
			toolName: 'semantic_search',
			toolCallId: 'tool-3',
			message: 'Searching workspace',
			isError: false,
			isComplete: true,
		});
		harness.store.reportAssistantTurnReference({
			conversationId: 'session-3',
			turnId: 'turn-1',
			label: 'conversationBridge.ts',
			uri: 'file:///workspace/src/platform/bridge/conversationBridge.ts',
		});
		harness.store.reportAssistantTurnCodeCitation({
			conversationId: 'session-3',
			turnId: 'turn-1',
			uri: 'file:///workspace/LICENSE.txt',
			license: 'MIT',
			snippet: 'Licensed under the MIT License.',
		});
		harness.store.reportAssistantTurnConfirmation({
			conversationId: 'session-3',
			turnId: 'turn-1',
			title: 'Commit these edits?',
			message: 'You can accept or reject',
			buttons: ['Accept', 'Reject'],
		});
		harness.store.reportAssistantTurnQuestionCarousel({
			conversationId: 'session-3',
			turnId: 'turn-1',
			allowSkip: false,
			questions: [
				{
					id: 'q2',
					type: 'text',
					title: 'Describe scope',
					message: 'Short answer',
					options: undefined,
					allowFreeformInput: true,
				},
			],
		});
		harness.store.reportAssistantTurnCommandButton({
			conversationId: 'session-3',
			turnId: 'turn-1',
			commandId: 'workbench.action.chat.open',
			title: 'Re-open Chat',
			args: [{ query: 'resume' }],
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-3',
			turnId: 'turn-1',
			extra: {
				kind: 'anchor',
				label: 'README.md',
				uri: 'file:///workspace/README.md',
			},
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-3',
			turnId: 'turn-1',
			extra: {
				kind: 'extensions',
				extensions: ['ms-python.python'],
			},
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-3',
			turnId: 'turn-1',
			extra: {
				kind: 'pullRequest',
				title: 'Ship sidecar parity',
				description: 'Includes remaining response part support',
				author: 'octocat',
				linkTag: 'PR',
				commandId: 'vscode.open',
				commandArgs: ['https://github.com/org/repo/pull/99'],
			},
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-3',
			turnId: 'turn-1',
			extra: {
				kind: 'externalEdit',
				uris: ['file:///workspace/src/edited.ts'],
			},
		});
		harness.store.reportAssistantTurnExtra({
			conversationId: 'session-3',
			turnId: 'turn-1',
			extra: {
				kind: 'multiDiff',
				title: 'Workspace changes',
				readOnly: false,
				entries: [
					{
						originalUri: 'file:///workspace/src/before.ts',
						modifiedUri: 'file:///workspace/src/after.ts',
						goToFileUri: 'file:///workspace/src/after.ts',
						added: 5,
						removed: 1,
					},
				],
			},
		});

		harness.client.send({ type: 'conversation:select', conversationId: 'session-3' });
		const historyMessage = await harness.client.waitForType('conversation:history');
		expect(historyMessage.turns).toEqual([
			{ role: 'user', content: 'What happened?', timestamp: expect.any(Number) },
			{
				role: 'assistant',
				content: 'Summary response',
				timestamp: expect.any(Number),
				artifacts: {
					statuses: [
						{ kind: 'progress', content: 'Gathering context' },
					],
					tools: [
						{
							toolName: 'semantic_search',
							toolCallId: 'tool-3',
							message: 'Searching workspace',
							isError: false,
							isComplete: true,
						},
					],
					references: [
						{
							label: 'conversationBridge.ts',
							uri: 'file:///workspace/src/platform/bridge/conversationBridge.ts',
						},
					],
					codeCitations: [
						{
							uri: 'file:///workspace/LICENSE.txt',
							license: 'MIT',
							snippet: 'Licensed under the MIT License.',
						},
					],
					confirmations: [
						{
							title: 'Commit these edits?',
							message: 'You can accept or reject',
							buttons: ['Accept', 'Reject'],
						},
					],
					questionCarousels: [
						{
							allowSkip: false,
							questions: [
								{
									id: 'q2',
									type: 'text',
									title: 'Describe scope',
									message: 'Short answer',
									options: undefined,
									allowFreeformInput: true,
								},
							],
						},
					],
					commandButtons: [
						{
							commandId: 'workbench.action.chat.open',
							title: 'Re-open Chat',
							args: [{ query: 'resume' }],
						},
					],
					extras: [
						{
							kind: 'anchor',
							label: 'README.md',
							uri: 'file:///workspace/README.md',
						},
						{
							kind: 'extensions',
							extensions: ['ms-python.python'],
						},
						{
							kind: 'pullRequest',
							title: 'Ship sidecar parity',
							description: 'Includes remaining response part support',
							author: 'octocat',
							linkTag: 'PR',
							commandId: 'vscode.open',
							commandArgs: ['https://github.com/org/repo/pull/99'],
						},
						{
							kind: 'externalEdit',
							uris: ['file:///workspace/src/edited.ts'],
						},
						{
							kind: 'multiDiff',
							title: 'Workspace changes',
							readOnly: false,
							entries: [
								{
									originalUri: 'file:///workspace/src/before.ts',
									modifiedUri: 'file:///workspace/src/after.ts',
									goToFileUri: 'file:///workspace/src/after.ts',
									added: 5,
									removed: 1,
								},
							],
						},
					],
				},
			},
		]);
	});

	test('applies conversation filters from conversation:list:request messages', async () => {
		harness = await createHarness([
			{ id: 'session-1', title: 'Ship release', lastUpdated: 3, provider: 'claude', status: 'completed' },
			{ id: 'session-2', title: 'Fix flaky tests', lastUpdated: 2, provider: 'cloud', status: 'in-progress' },
			{ id: 'session-3', title: 'Ship docs', lastUpdated: 1, provider: 'claude', status: 'failed' },
		]);

		await harness.client.waitForType('conversation:list');
		await harness.client.waitForType('ui:state');
		const initialListCount = harness.client.countType('conversation:list');

		harness.client.send({
			type: 'conversation:list:request',
			filter: {
				providers: ['claude'],
				statuses: ['completed'],
				search: 'ship',
			},
		});

		const filteredConversationList = await harness.client.waitForType('conversation:list', initialListCount + 1);
		expect(filteredConversationList.conversations).toEqual([
			{ id: 'session-1', title: 'Ship release', lastUpdated: 3, provider: 'claude', status: 'completed' },
		]);
	});
});
