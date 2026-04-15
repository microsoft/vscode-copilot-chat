/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatSessionService } from '../../../platform/chat/common/chatSessionService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { IFileSystemService, createDirectoryIfNotExists } from '../../../platform/filesystem/common/fileSystemService';
import { ILogService } from '../../../platform/log/common/logService';
import { createServiceIdentifier } from '../../../util/common/services';
import { TimeoutTimer } from '../../../util/vs/base/common/async';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableMap } from '../../../util/vs/base/common/lifecycle';
import { LRUCache } from '../../../util/vs/base/common/map';
import { URI } from '../../../util/vs/base/common/uri';
import { Conversation } from '../../prompt/common/conversation';

export const IConversationStore = createServiceIdentifier<IConversationStore>('IConversationStore');

export interface IConversationSummary {
	readonly id: string;
	readonly title: string;
	readonly lastUpdated: number;
}

export interface IConversationTurnEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly content: string;
	readonly timestamp: number;
}

export interface IConversationTurnLifecycleEvent {
	readonly conversationId: string;
	readonly turnId: string;
}

export interface IConversationTurnChunkEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly content: string;
}

export interface IConversationTurnReferenceEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly label: string;
	readonly uri: string | undefined;
}

export interface IConversationTurnCodeCitationEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly uri: string;
	readonly license: string;
	readonly snippet: string;
}

export type IConversationAssistantStatusKind = 'progress' | 'warning' | 'thinking';

export interface IConversationTurnStatusEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly kind: IConversationAssistantStatusKind;
	readonly content: string;
}

export interface IConversationTurnToolInvocationEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly toolName: string;
	readonly toolCallId: string;
	readonly message: string | undefined;
	readonly isError: boolean;
	readonly isComplete: boolean;
}

export interface IConversationTurnConfirmationEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly title: string;
	readonly message: string;
	readonly buttons: readonly string[] | undefined;
}

export type IConversationQuestionType = 'text' | 'singleSelect' | 'multiSelect' | 'unknown';

export interface IConversationQuestionItem {
	readonly id: string;
	readonly type: IConversationQuestionType;
	readonly title: string;
	readonly message: string | undefined;
	readonly options: readonly string[] | undefined;
	readonly allowFreeformInput: boolean;
}

export interface IConversationTurnQuestionCarouselEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly allowSkip: boolean;
	readonly questions: readonly IConversationQuestionItem[];
}

export interface IConversationTurnCommandButtonEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly commandId: string;
	readonly title: string;
	readonly args: readonly unknown[] | undefined;
}

export interface IConversationAssistantAnchorItem {
	readonly kind: 'anchor';
	readonly label: string;
	readonly uri: string | undefined;
}

export interface IConversationAssistantFileTreeItem {
	readonly kind: 'fileTree';
	readonly baseUri: string;
	readonly tree: string;
}

export interface IConversationAssistantCodeblockUriItem {
	readonly kind: 'codeblockUri';
	readonly uri: string;
	readonly isEdit: boolean;
	readonly undoStopId: string | undefined;
}

export interface IConversationAssistantTextEditItem {
	readonly kind: 'textEdit';
	readonly uri: string;
	readonly editCount: number;
	readonly isDone: boolean;
}

export interface IConversationAssistantNotebookEditItem {
	readonly kind: 'notebookEdit';
	readonly uri: string;
	readonly editCount: number;
	readonly isDone: boolean;
}

export interface IConversationAssistantWorkspaceEditOperationItem {
	readonly oldUri: string | undefined;
	readonly newUri: string | undefined;
}

export interface IConversationAssistantWorkspaceEditItem {
	readonly kind: 'workspaceEdit';
	readonly edits: readonly IConversationAssistantWorkspaceEditOperationItem[];
}

export interface IConversationAssistantMoveItem {
	readonly kind: 'move';
	readonly uri: string;
	readonly startLine: number;
	readonly endLine: number;
}

export interface IConversationAssistantExtensionsItem {
	readonly kind: 'extensions';
	readonly extensions: readonly string[];
}

export interface IConversationAssistantPullRequestItem {
	readonly kind: 'pullRequest';
	readonly title: string;
	readonly description: string;
	readonly author: string;
	readonly linkTag: string;
	readonly commandId: string | undefined;
	readonly commandArgs: readonly unknown[] | undefined;
}

export interface IConversationAssistantExternalEditItem {
	readonly kind: 'externalEdit';
	readonly uris: readonly string[];
}

export interface IConversationAssistantMultiDiffEntryItem {
	readonly originalUri: string | undefined;
	readonly modifiedUri: string | undefined;
	readonly goToFileUri: string | undefined;
	readonly added: number | undefined;
	readonly removed: number | undefined;
}

export interface IConversationAssistantMultiDiffItem {
	readonly kind: 'multiDiff';
	readonly title: string;
	readonly readOnly: boolean;
	readonly entries: readonly IConversationAssistantMultiDiffEntryItem[];
}

export type IConversationAssistantExtraItem =
	| IConversationAssistantAnchorItem
	| IConversationAssistantFileTreeItem
	| IConversationAssistantCodeblockUriItem
	| IConversationAssistantTextEditItem
	| IConversationAssistantNotebookEditItem
	| IConversationAssistantWorkspaceEditItem
	| IConversationAssistantMoveItem
	| IConversationAssistantExtensionsItem
	| IConversationAssistantPullRequestItem
	| IConversationAssistantExternalEditItem
	| IConversationAssistantMultiDiffItem;

export interface IConversationTurnExtraEvent {
	readonly conversationId: string;
	readonly turnId: string;
	readonly extra: IConversationAssistantExtraItem;
}

export interface IConversationAssistantStatusItem {
	readonly kind: IConversationAssistantStatusKind;
	readonly content: string;
}

export interface IConversationAssistantToolInvocationItem {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly message: string | undefined;
	readonly isError: boolean;
	readonly isComplete: boolean;
}

export interface IConversationAssistantReferenceItem {
	readonly label: string;
	readonly uri: string | undefined;
}

export interface IConversationAssistantCodeCitationItem {
	readonly uri: string;
	readonly license: string;
	readonly snippet: string;
}

export interface IConversationAssistantConfirmationItem {
	readonly title: string;
	readonly message: string;
	readonly buttons: readonly string[] | undefined;
}

export interface IConversationAssistantQuestionCarouselItem {
	readonly allowSkip: boolean;
	readonly questions: readonly IConversationQuestionItem[];
}

export interface IConversationAssistantCommandButtonItem {
	readonly commandId: string;
	readonly title: string;
	readonly args: readonly unknown[] | undefined;
}

export interface IConversationTurnArtifacts {
	readonly statuses: readonly IConversationAssistantStatusItem[];
	readonly tools: readonly IConversationAssistantToolInvocationItem[];
	readonly references: readonly IConversationAssistantReferenceItem[];
	readonly codeCitations: readonly IConversationAssistantCodeCitationItem[];
	readonly confirmations: readonly IConversationAssistantConfirmationItem[];
	readonly questionCarousels: readonly IConversationAssistantQuestionCarouselItem[];
	readonly commandButtons: readonly IConversationAssistantCommandButtonItem[];
	readonly extras: readonly IConversationAssistantExtraItem[];
}

export interface IConversationStore {
	readonly _serviceBrand: undefined;
	readonly onDidConversationListChanged: Event<void>;
	readonly onDidUserTurn: Event<IConversationTurnEvent>;
	readonly onDidAssistantTurnStart: Event<IConversationTurnLifecycleEvent>;
	readonly onDidAssistantTurnChunk: Event<IConversationTurnChunkEvent>;
	readonly onDidAssistantTurnReference: Event<IConversationTurnReferenceEvent>;
	readonly onDidAssistantTurnCodeCitation: Event<IConversationTurnCodeCitationEvent>;
	readonly onDidAssistantTurnStatus: Event<IConversationTurnStatusEvent>;
	readonly onDidAssistantTurnToolInvocation: Event<IConversationTurnToolInvocationEvent>;
	readonly onDidAssistantTurnConfirmation: Event<IConversationTurnConfirmationEvent>;
	readonly onDidAssistantTurnQuestionCarousel: Event<IConversationTurnQuestionCarouselEvent>;
	readonly onDidAssistantTurnCommandButton: Event<IConversationTurnCommandButtonEvent>;
	readonly onDidAssistantTurnExtra: Event<IConversationTurnExtraEvent>;
	readonly onDidAssistantTurnComplete: Event<IConversationTurnLifecycleEvent>;

	addConversation(responseId: string, conversation: Conversation): void;
	getConversation(responseId: string): Conversation | undefined;
	getConversationBySessionId(sessionId: string): Conversation | undefined;
	getAssistantTurnArtifacts(conversationId: string, turnId: string): IConversationTurnArtifacts | undefined;
	listConversations(): readonly IConversationSummary[];
	reportUserTurn(event: IConversationTurnEvent): void;
	reportAssistantTurnStart(event: IConversationTurnLifecycleEvent): void;
	reportAssistantTurnChunk(event: IConversationTurnChunkEvent): void;
	reportAssistantTurnReference(event: IConversationTurnReferenceEvent): void;
	reportAssistantTurnCodeCitation(event: IConversationTurnCodeCitationEvent): void;
	reportAssistantTurnStatus(event: IConversationTurnStatusEvent): void;
	reportAssistantTurnToolInvocation(event: IConversationTurnToolInvocationEvent): void;
	reportAssistantTurnConfirmation(event: IConversationTurnConfirmationEvent): void;
	reportAssistantTurnQuestionCarousel(event: IConversationTurnQuestionCarouselEvent): void;
	reportAssistantTurnCommandButton(event: IConversationTurnCommandButtonEvent): void;
	reportAssistantTurnExtra(event: IConversationTurnExtraEvent): void;
	reportAssistantTurnComplete(event: IConversationTurnLifecycleEvent): void;
	lastConversation: Conversation | undefined;
}

const CLEANUP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SUMMARIES_FILE = 'conversations.json';
const PERSIST_DEBOUNCE_MS = 2000;
const TURN_ARTIFACTS_KEY_SEPARATOR = '\u0000';

type MutableConversationTurnArtifacts = {
	statuses: IConversationAssistantStatusItem[];
	tools: IConversationAssistantToolInvocationItem[];
	references: IConversationAssistantReferenceItem[];
	codeCitations: IConversationAssistantCodeCitationItem[];
	confirmations: IConversationAssistantConfirmationItem[];
	questionCarousels: IConversationAssistantQuestionCarouselItem[];
	commandButtons: IConversationAssistantCommandButtonItem[];
	extras: IConversationAssistantExtraItem[];
};

export class ConversationStore extends Disposable implements IConversationStore {
	readonly _serviceBrand: undefined;

	private readonly conversationMap: LRUCache<string, Conversation>;
	private readonly pendingCleanups: DisposableMap<string, TimeoutTimer> = this._register(new DisposableMap());
	private readonly _onDidConversationListChanged = this._register(new Emitter<void>());
	readonly onDidConversationListChanged: Event<void> = this._onDidConversationListChanged.event;
	private readonly _onDidUserTurn = this._register(new Emitter<IConversationTurnEvent>());
	readonly onDidUserTurn: Event<IConversationTurnEvent> = this._onDidUserTurn.event;
	private readonly _onDidAssistantTurnStart = this._register(new Emitter<IConversationTurnLifecycleEvent>());
	readonly onDidAssistantTurnStart: Event<IConversationTurnLifecycleEvent> = this._onDidAssistantTurnStart.event;
	private readonly _onDidAssistantTurnChunk = this._register(new Emitter<IConversationTurnChunkEvent>());
	readonly onDidAssistantTurnChunk: Event<IConversationTurnChunkEvent> = this._onDidAssistantTurnChunk.event;
	private readonly _onDidAssistantTurnReference = this._register(new Emitter<IConversationTurnReferenceEvent>());
	readonly onDidAssistantTurnReference: Event<IConversationTurnReferenceEvent> = this._onDidAssistantTurnReference.event;
	private readonly _onDidAssistantTurnCodeCitation = this._register(new Emitter<IConversationTurnCodeCitationEvent>());
	readonly onDidAssistantTurnCodeCitation: Event<IConversationTurnCodeCitationEvent> = this._onDidAssistantTurnCodeCitation.event;
	private readonly _onDidAssistantTurnStatus = this._register(new Emitter<IConversationTurnStatusEvent>());
	readonly onDidAssistantTurnStatus: Event<IConversationTurnStatusEvent> = this._onDidAssistantTurnStatus.event;
	private readonly _onDidAssistantTurnToolInvocation = this._register(new Emitter<IConversationTurnToolInvocationEvent>());
	readonly onDidAssistantTurnToolInvocation: Event<IConversationTurnToolInvocationEvent> = this._onDidAssistantTurnToolInvocation.event;
	private readonly _onDidAssistantTurnConfirmation = this._register(new Emitter<IConversationTurnConfirmationEvent>());
	readonly onDidAssistantTurnConfirmation: Event<IConversationTurnConfirmationEvent> = this._onDidAssistantTurnConfirmation.event;
	private readonly _onDidAssistantTurnQuestionCarousel = this._register(new Emitter<IConversationTurnQuestionCarouselEvent>());
	readonly onDidAssistantTurnQuestionCarousel: Event<IConversationTurnQuestionCarouselEvent> = this._onDidAssistantTurnQuestionCarousel.event;
	private readonly _onDidAssistantTurnCommandButton = this._register(new Emitter<IConversationTurnCommandButtonEvent>());
	readonly onDidAssistantTurnCommandButton: Event<IConversationTurnCommandButtonEvent> = this._onDidAssistantTurnCommandButton.event;
	private readonly _onDidAssistantTurnExtra = this._register(new Emitter<IConversationTurnExtraEvent>());
	readonly onDidAssistantTurnExtra: Event<IConversationTurnExtraEvent> = this._onDidAssistantTurnExtra.event;
	private readonly _onDidAssistantTurnComplete = this._register(new Emitter<IConversationTurnLifecycleEvent>());
	readonly onDidAssistantTurnComplete: Event<IConversationTurnLifecycleEvent> = this._onDidAssistantTurnComplete.event;

	private readonly persistedSummaries = new Map<string, IConversationSummary>();
	private readonly assistantArtifactsByTurn = new Map<string, MutableConversationTurnArtifacts>();
	private readonly summariesUri: URI | undefined;
	private persistTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IChatSessionService chatSessionService: IChatSessionService,
		@IVSCodeExtensionContext extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly fileSystemService: IFileSystemService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.conversationMap = new LRUCache<string, Conversation>(1000);
		this._register(chatSessionService.onDidDisposeChatSession(sessionId => {
			this._scheduleSessionCleanup(sessionId);
		}));

		const globalStorageUri = extensionContext.globalStorageUri;
		if (globalStorageUri) {
			this.summariesUri = URI.joinPath(globalStorageUri, SUMMARIES_FILE);
			void this.loadPersistedSummaries();
		}
	}

	addConversation(responseId: string, conversation: Conversation): void {
		this.conversationMap.set(responseId, conversation);
		this.pendingCleanups.deleteAndDispose(conversation.sessionId);
		this._onDidConversationListChanged.fire();
		this.schedulePersist();
	}

	getConversation(responseId: string): Conversation | undefined {
		const conversation = this.conversationMap.get(responseId);
		if (conversation) {
			this.pendingCleanups.deleteAndDispose(conversation.sessionId);
		}
		return conversation;
	}

	getConversationBySessionId(sessionId: string): Conversation | undefined {
		let foundConversation: Conversation | undefined;
		this.conversationMap.forEach(conversation => {
			if (conversation.sessionId !== sessionId) {
				return;
			}

			if (!foundConversation || this.getConversationLastUpdated(conversation) > this.getConversationLastUpdated(foundConversation)) {
				foundConversation = conversation;
			}
		});

		if (foundConversation) {
			this.pendingCleanups.deleteAndDispose(foundConversation.sessionId);
		}

		return foundConversation;
	}

	getAssistantTurnArtifacts(conversationId: string, turnId: string): IConversationTurnArtifacts | undefined {
		const key = this.getAssistantTurnArtifactsKey(conversationId, turnId);
		const artifacts = this.assistantArtifactsByTurn.get(key);
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
		const conversationsBySession = new Map<string, IConversationSummary>();

		// Start with persisted summaries (historical)
		for (const [id, summary] of this.persistedSummaries) {
			conversationsBySession.set(id, summary);
		}

		// In-memory conversations override persisted summaries
		this.conversationMap.forEach(conversation => {
			const id = conversation.sessionId;
			const lastUpdated = this.getConversationLastUpdated(conversation);
			const existing = conversationsBySession.get(id);
			if (!existing || lastUpdated > existing.lastUpdated) {
				conversationsBySession.set(id, {
					id,
					title: this.getConversationTitle(conversation),
					lastUpdated,
				});
			}
		});

		return Array.from(conversationsBySession.values())
			.sort((a, b) => b.lastUpdated - a.lastUpdated);
	}

	reportUserTurn(event: IConversationTurnEvent): void {
		this._onDidUserTurn.fire(event);
	}

	reportAssistantTurnStart(event: IConversationTurnLifecycleEvent): void {
		this._onDidAssistantTurnStart.fire(event);
	}

	reportAssistantTurnChunk(event: IConversationTurnChunkEvent): void {
		this._onDidAssistantTurnChunk.fire(event);
	}

	reportAssistantTurnReference(event: IConversationTurnReferenceEvent): void {
		this.recordAssistantReference(event);
		this._onDidAssistantTurnReference.fire(event);
	}

	reportAssistantTurnCodeCitation(event: IConversationTurnCodeCitationEvent): void {
		this.recordAssistantCodeCitation(event);
		this._onDidAssistantTurnCodeCitation.fire(event);
	}

	reportAssistantTurnStatus(event: IConversationTurnStatusEvent): void {
		this.recordAssistantStatus(event);
		this._onDidAssistantTurnStatus.fire(event);
	}

	reportAssistantTurnToolInvocation(event: IConversationTurnToolInvocationEvent): void {
		this.recordAssistantToolInvocation(event);
		this._onDidAssistantTurnToolInvocation.fire(event);
	}

	reportAssistantTurnConfirmation(event: IConversationTurnConfirmationEvent): void {
		this.recordAssistantConfirmation(event);
		this._onDidAssistantTurnConfirmation.fire(event);
	}

	reportAssistantTurnQuestionCarousel(event: IConversationTurnQuestionCarouselEvent): void {
		this.recordAssistantQuestionCarousel(event);
		this._onDidAssistantTurnQuestionCarousel.fire(event);
	}

	reportAssistantTurnCommandButton(event: IConversationTurnCommandButtonEvent): void {
		this.recordAssistantCommandButton(event);
		this._onDidAssistantTurnCommandButton.fire(event);
	}

	reportAssistantTurnExtra(event: IConversationTurnExtraEvent): void {
		this.recordAssistantExtra(event);
		this._onDidAssistantTurnExtra.fire(event);
	}

	reportAssistantTurnComplete(event: IConversationTurnLifecycleEvent): void {
		this._onDidAssistantTurnComplete.fire(event);
	}

	get lastConversation(): Conversation | undefined {
		const conversation = this.conversationMap.last;
		if (conversation) {
			this.pendingCleanups.deleteAndDispose(conversation.sessionId);
		}
		return conversation;
	}

	private _scheduleSessionCleanup(sessionId: string): void {
		let timer = this.pendingCleanups.get(sessionId);
		if (!timer) {
			timer = new TimeoutTimer();
			this.pendingCleanups.set(sessionId, timer);
		}
		timer.cancelAndSet(() => {
			this._cleanupSession(sessionId);
		}, CLEANUP_TIMEOUT_MS);
	}

	private _cleanupSession(sessionId: string): void {
		this.pendingCleanups.deleteAndDispose(sessionId);
		const keysToDelete: string[] = [];
		this.conversationMap.forEach((conversation, responseId) => {
			if (conversation.sessionId === sessionId) {
				keysToDelete.push(responseId);
			}
		});
		for (const key of keysToDelete) {
			this.conversationMap.delete(key);
		}

		for (const key of this.assistantArtifactsByTurn.keys()) {
			if (key.startsWith(`${sessionId}${TURN_ARTIFACTS_KEY_SEPARATOR}`)) {
				this.assistantArtifactsByTurn.delete(key);
			}
		}

		if (keysToDelete.length > 0) {
			this._onDidConversationListChanged.fire();
			this.schedulePersist();
		}
	}

	private getConversationTitle(conversation: Conversation): string {
		const firstUserTurn = conversation.turns.find(turn => turn.request.type === 'user' && turn.request.message.trim().length > 0);
		const title = firstUserTurn?.request.message ?? conversation.getLatestTurn().request.message;
		if (title.length <= 80) {
			return title;
		}

		return `${title.slice(0, 77)}...`;
	}

	private getConversationLastUpdated(conversation: Conversation): number {
		return conversation.getLatestTurn().startTime;
	}

	private recordAssistantReference(event: IConversationTurnReferenceEvent): void {
		const artifacts = this.getOrCreateAssistantTurnArtifacts(event.conversationId, event.turnId);
		if (artifacts.references.some(item => item.label === event.label && item.uri === event.uri)) {
			return;
		}

		artifacts.references.push({
			label: event.label,
			uri: event.uri,
		});
	}

	private recordAssistantCodeCitation(event: IConversationTurnCodeCitationEvent): void {
		const artifacts = this.getOrCreateAssistantTurnArtifacts(event.conversationId, event.turnId);
		if (artifacts.codeCitations.some(item => item.uri === event.uri && item.license === event.license && item.snippet === event.snippet)) {
			return;
		}

		artifacts.codeCitations.push({
			uri: event.uri,
			license: event.license,
			snippet: event.snippet,
		});
	}

	private recordAssistantStatus(event: IConversationTurnStatusEvent): void {
		const artifacts = this.getOrCreateAssistantTurnArtifacts(event.conversationId, event.turnId);
		if (artifacts.statuses.some(item => item.kind === event.kind && item.content === event.content)) {
			return;
		}

		artifacts.statuses.push({
			kind: event.kind,
			content: event.content,
		});
	}

	private recordAssistantToolInvocation(event: IConversationTurnToolInvocationEvent): void {
		const artifacts = this.getOrCreateAssistantTurnArtifacts(event.conversationId, event.turnId);
		const existingIndex = artifacts.tools.findIndex(item => item.toolCallId === event.toolCallId);
		const updatedItem: IConversationAssistantToolInvocationItem = {
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			message: event.message,
			isError: event.isError,
			isComplete: event.isComplete,
		};

		if (existingIndex === -1) {
			artifacts.tools.push(updatedItem);
			return;
		}

		const previous = artifacts.tools[existingIndex];
		artifacts.tools[existingIndex] = {
			toolName: updatedItem.toolName,
			toolCallId: updatedItem.toolCallId,
			message: updatedItem.message ?? previous.message,
			isError: updatedItem.isError,
			isComplete: updatedItem.isComplete,
		};
	}

	private recordAssistantConfirmation(event: IConversationTurnConfirmationEvent): void {
		const artifacts = this.getOrCreateAssistantTurnArtifacts(event.conversationId, event.turnId);
		const signature = `${event.title}\u0000${event.message}\u0000${event.buttons?.join('\u0000') ?? ''}`;
		if (artifacts.confirmations.some(item => `${item.title}\u0000${item.message}\u0000${item.buttons?.join('\u0000') ?? ''}` === signature)) {
			return;
		}

		artifacts.confirmations.push({
			title: event.title,
			message: event.message,
			buttons: event.buttons,
		});
	}

	private recordAssistantQuestionCarousel(event: IConversationTurnQuestionCarouselEvent): void {
		const artifacts = this.getOrCreateAssistantTurnArtifacts(event.conversationId, event.turnId);
		const signature = JSON.stringify({
			allowSkip: event.allowSkip,
			questions: event.questions,
		});
		if (artifacts.questionCarousels.some(item => JSON.stringify(item) === signature)) {
			return;
		}

		artifacts.questionCarousels.push({
			allowSkip: event.allowSkip,
			questions: [...event.questions],
		});
	}

	private recordAssistantCommandButton(event: IConversationTurnCommandButtonEvent): void {
		const artifacts = this.getOrCreateAssistantTurnArtifacts(event.conversationId, event.turnId);
		const signature = `${event.commandId}\u0000${event.title}\u0000${JSON.stringify(event.args ?? [])}`;
		if (artifacts.commandButtons.some(item => `${item.commandId}\u0000${item.title}\u0000${JSON.stringify(item.args ?? [])}` === signature)) {
			return;
		}

		artifacts.commandButtons.push({
			commandId: event.commandId,
			title: event.title,
			args: event.args,
		});
	}

	private recordAssistantExtra(event: IConversationTurnExtraEvent): void {
		const artifacts = this.getOrCreateAssistantTurnArtifacts(event.conversationId, event.turnId);
		const extra = event.extra;

		if (extra.kind === 'textEdit' || extra.kind === 'notebookEdit') {
			const existingIndex = artifacts.extras.findIndex(item => item.kind === extra.kind && item.uri === extra.uri);
			if (existingIndex === -1) {
				artifacts.extras.push(extra);
				return;
			}

			const existing = artifacts.extras[existingIndex];
			if (existing.kind === extra.kind) {
				artifacts.extras[existingIndex] = {
					kind: extra.kind,
					uri: extra.uri,
					editCount: Math.max(existing.editCount, extra.editCount),
					isDone: existing.isDone || extra.isDone,
				};
			}
			return;
		}

		const signature = JSON.stringify(extra);
		if (artifacts.extras.some(item => JSON.stringify(item) === signature)) {
			return;
		}

		artifacts.extras.push(extra);
	}

	private getOrCreateAssistantTurnArtifacts(conversationId: string, turnId: string): MutableConversationTurnArtifacts {
		const key = this.getAssistantTurnArtifactsKey(conversationId, turnId);
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

	private getAssistantTurnArtifactsKey(conversationId: string, turnId: string): string {
		return `${conversationId}${TURN_ARTIFACTS_KEY_SEPARATOR}${turnId}`;
	}

	private schedulePersist(): void {
		if (!this.summariesUri) {
			return;
		}
		if (this.persistTimer !== undefined) {
			clearTimeout(this.persistTimer);
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			void this.persistSummaries();
		}, PERSIST_DEBOUNCE_MS);
	}

	private async persistSummaries(): Promise<void> {
		if (!this.summariesUri) {
			return;
		}

		const summaries = this.listConversations();
		const data = JSON.stringify(summaries, undefined, '\t');
		const encoded = new TextEncoder().encode(data);

		try {
			const dirUri = URI.joinPath(this.summariesUri, '..');
			await createDirectoryIfNotExists(this.fileSystemService, dirUri);
			await this.fileSystemService.writeFile(this.summariesUri, encoded);
		} catch (err) {
			this.logService.warn(`[ConversationStore] Failed to persist conversation summaries: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async loadPersistedSummaries(): Promise<void> {
		if (!this.summariesUri) {
			return;
		}

		const parseAndStoreSummaries = (decoded: string): boolean => {
			const parsed: unknown = JSON.parse(decoded);
			if (!Array.isArray(parsed)) {
				return false;
			}

			for (const entry of parsed) {
				if (typeof entry === 'object' && entry !== null && typeof entry.id === 'string' && typeof entry.title === 'string' && typeof entry.lastUpdated === 'number') {
					this.persistedSummaries.set(entry.id, {
						id: entry.id,
						title: entry.title,
						lastUpdated: entry.lastUpdated,
					});
				}
			}

			return true;
		};

		try {
			const content = await this.fileSystemService.readFile(this.summariesUri);
			const decoded = new TextDecoder().decode(content);
			parseAndStoreSummaries(decoded);
		} catch {
			// File doesn't exist yet or is malformed.
		}

		if (this.persistedSummaries.size > 0) {
			this._onDidConversationListChanged.fire();
		}
	}
}
