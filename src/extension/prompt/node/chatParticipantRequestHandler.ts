/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type { ChatRequest, ChatRequestTurn2, ChatResponseStream, ChatResult, ExtendedChatResponsePart, Location } from 'vscode';
import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { IAuthenticationChatUpgradeService } from '../../../platform/authentication/common/authenticationUpgrade';
import { getChatParticipantNameFromId } from '../../../platform/chat/common/chatAgents';
import { CanceledMessage, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { IIgnoreService } from '../../../platform/ignore/common/ignoreService';
import { ILogService } from '../../../platform/log/common/logService';
import { FilterReason } from '../../../platform/networking/common/openai';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { getWorkspaceFileDisplayPath, IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { ChatResponseStreamImpl } from '../../../util/common/chatResponseStreamImpl';
import { fileTreePartToMarkdown } from '../../../util/common/fileTree';
import { isLocation, isSymbolInformation } from '../../../util/common/types';
import { coalesce } from '../../../util/vs/base/common/arrays';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Schemas } from '../../../util/vs/base/common/network';
import { mixin } from '../../../util/vs/base/common/objects';
import { isEqual } from '../../../util/vs/base/common/resources';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService, ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatQuestionType, ChatRequestEditorData, ChatRequestNotebookData, ChatRequestTurn, ChatResponseAnchorPart, ChatResponseCodeblockUriPart, ChatResponseCodeCitationPart, ChatResponseCommandButtonPart, ChatResponseConfirmationPart, ChatResponseExtensionsPart, ChatResponseExternalEditPart, ChatResponseFileTreePart, ChatResponseMarkdownPart, ChatResponseMarkdownWithVulnerabilitiesPart, ChatResponseMovePart, ChatResponseNotebookEditPart, ChatResponseProgressPart, ChatResponseProgressPart2, ChatResponsePullRequestPart, ChatResponseQuestionCarouselPart, ChatResponseReferencePart, ChatResponseReferencePart2, ChatResponseTextEditPart, ChatResponseThinkingProgressPart, ChatResponseTurn, ChatResponseWarningPart, ChatResponseWorkspaceEditPart, ChatToolInvocationPart, ChatLocation as VSChatLocation } from '../../../vscodeTypes';
import { ICommandService } from '../../commands/node/commandService';
import { getAgentForIntent, Intent } from '../../common/constants';
import { IConversationAssistantExtraItem, IConversationAssistantStatusKind, IConversationQuestionItem, IConversationQuestionType, IConversationStore, IConversationTurnCodeCitationEvent, IConversationTurnCommandButtonEvent, IConversationTurnConfirmationEvent, IConversationTurnExtraEvent, IConversationTurnQuestionCarouselEvent, IConversationTurnReferenceEvent, IConversationTurnStatusEvent, IConversationTurnToolInvocationEvent } from '../../conversationStore/node/conversationStore';
import { IIntentService } from '../../intents/node/intentService';
import { UnknownIntent } from '../../intents/node/unknownIntent';
import { ContributedToolName } from '../../tools/common/toolNames';
import { ChatVariablesCollection } from '../common/chatVariablesCollection';
import { AnthropicTokenUsageMetadata, Conversation, getGlobalContextCacheKey, GlobalContextMessageMetadata, ICopilotChatResult, ICopilotChatResultIn, normalizeSummariesOnRounds, RenderedUserMessageMetadata, Turn, TurnStatus } from '../common/conversation';
import { InternalToolReference } from '../common/intents';
import { ChatTelemetryBuilder } from './chatParticipantTelemetry';
import { DefaultIntentRequestHandler } from './defaultIntentRequestHandler';
import { IDocumentContext } from './documentContext';
import { IntentDetector } from './intentDetector';
import { CommandDetails } from './intentRegistry';
import { IIntent } from './intents';

export interface IChatAgentArgs {
	agentName: string;
	agentId: string;
	intentId?: string;
}

type ChatResponseMultiDiffEntryLike = {
	readonly originalUri?: { toString(): string };
	readonly modifiedUri?: { toString(): string };
	readonly goToFileUri?: { toString(): string };
	readonly added?: number;
	readonly removed?: number;
};

type ChatResponseMultiDiffPartLike = {
	readonly value: readonly ChatResponseMultiDiffEntryLike[];
	readonly title: string;
	readonly readOnly?: boolean;
};

/**
 * Handles a single chat request:
 * 1) selects intent
 * 2) invoke intent via `IIntentRequestHandler/AbstractIntentRequestHandler`
 */
export class ChatParticipantRequestHandler {

	public readonly conversation: Conversation;

	private readonly location: ChatLocation;
	private readonly stream: ChatResponseStream;
	private readonly documentContext: IDocumentContext | undefined;
	private readonly intentDetector: IntentDetector;
	private readonly turn: Turn;

	private readonly chatTelemetry: ChatTelemetryBuilder;

	constructor(
		private readonly rawHistory: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>,
		private request: ChatRequest,
		stream: ChatResponseStream,
		private readonly token: CancellationToken,
		private readonly chatAgentArgs: IChatAgentArgs,
		private readonly yieldRequested: () => boolean,
		telemetryMessageId: string | undefined,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IEndpointProvider private readonly _endpointProvider: IEndpointProvider,
		@ICommandService private readonly _commandService: ICommandService,
		@IIgnoreService private readonly _ignoreService: IIgnoreService,
		@IIntentService private readonly _intentService: IIntentService,
		@IConversationStore private readonly _conversationStore: IConversationStore,
		@ITabsAndEditorsService tabsAndEditorsService: ITabsAndEditorsService,
		@ILogService private readonly _logService: ILogService,
		@IAuthenticationService private readonly _authService: IAuthenticationService,
		@IAuthenticationChatUpgradeService private readonly _authenticationUpgradeService: IAuthenticationChatUpgradeService,
	) {
		this.location = this.getLocation(request);

		this.intentDetector = this._instantiationService.createInstance(IntentDetector);

		this.stream = stream;

		if (request.location2 instanceof ChatRequestEditorData) {

			// don't send back references that are the same as the document as the one from which
			// the request has been made

			const documentUri = request.location2.document.uri;

			this.stream = ChatResponseStreamImpl.filter(stream, part => {
				if (part instanceof ChatResponseReferencePart || part instanceof ChatResponseProgressPart2) {
					const uri = URI.isUri(part.value) ? part.value : (<Location>part.value).uri;
					return !isEqual(uri, documentUri);
				}
				return true;
			});
		}

		const { turns, sessionId } = _instantiationService.invokeFunction(accessor => addHistoryToConversation(accessor, rawHistory));
		normalizeSummariesOnRounds(turns);
		// Use session ID from history, then VS Code's request.sessionId, then fallback to UUID
		const actualSessionId = sessionId ?? request.sessionId ?? generateUuid();

		this.documentContext = IDocumentContext.inferDocumentContext(request, tabsAndEditorsService.activeTextEditor, turns);

		this.chatTelemetry = this._instantiationService.createInstance(ChatTelemetryBuilder,
			Date.now(),
			actualSessionId,
			this.documentContext,
			turns.length === 0,
			this.request,
			telemetryMessageId
		);

		const latestTurn = Turn.fromRequest(
			this.chatTelemetry.telemetryMessageId,
			this.request);

		this.conversation = new Conversation(actualSessionId, turns.concat(latestTurn));

		this.turn = latestTurn;
		this._conversationStore.reportUserTurn({
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
			content: this.turn.request.message,
			timestamp: this.turn.startTime,
		});

		this.stream = ChatResponseStreamImpl.spy(this.stream, part => {
			const chunk = this.getStreamingChunk(part);
			if (chunk) {
				this._conversationStore.reportAssistantTurnChunk({
					conversationId: this.conversation.sessionId,
					turnId: this.turn.id,
					content: chunk,
				});
			}

			const statusEvent = this.getStreamingStatus(part);
			if (statusEvent) {
				this._conversationStore.reportAssistantTurnStatus(statusEvent);
			}

			const reference = this.getStreamingReference(part);
			if (reference) {
				this._conversationStore.reportAssistantTurnReference(reference);
			}

			const codeCitation = this.getStreamingCodeCitation(part);
			if (codeCitation) {
				this._conversationStore.reportAssistantTurnCodeCitation(codeCitation);
			}

			const toolInvocation = this.getStreamingToolInvocation(part);
			if (toolInvocation) {
				this._conversationStore.reportAssistantTurnToolInvocation(toolInvocation);
			}

			const confirmation = this.getStreamingConfirmation(part);
			if (confirmation) {
				this._conversationStore.reportAssistantTurnConfirmation(confirmation);
			}

			const questionCarousel = this.getStreamingQuestionCarousel(part);
			if (questionCarousel) {
				this._conversationStore.reportAssistantTurnQuestionCarousel(questionCarousel);
			}

			const commandButton = this.getStreamingCommandButton(part);
			if (commandButton) {
				this._conversationStore.reportAssistantTurnCommandButton(commandButton);
			}

			const extra = this.getStreamingExtra(part);
			if (extra) {
				this._conversationStore.reportAssistantTurnExtra(extra);
			}
		});
	}

	private getLocation(request: ChatRequest) {
		if (request.location2 instanceof ChatRequestEditorData) {
			return ChatLocation.Editor;
		} else if (request.location2 instanceof ChatRequestNotebookData) {
			return ChatLocation.Notebook;
		}
		switch (request.location) { // deprecated, but location2 does not yet allow to distinguish between panel, editing session and others
			case VSChatLocation.Editor:
				return ChatLocation.Editor;
			case VSChatLocation.Panel:
				return ChatLocation.Panel;
			case VSChatLocation.Terminal:
				return ChatLocation.Terminal;
			default:
				return ChatLocation.Other;
		}
	}

	private getStreamingChunk(part: ExtendedChatResponsePart): string | undefined {
		if (part instanceof ChatResponseMarkdownPart || part instanceof ChatResponseMarkdownWithVulnerabilitiesPart) {
			const value = typeof part.value === 'string' ? part.value : part.value.value;
			if (value.length > 0) {
				return value;
			}
		}

		return undefined;
	}

	private getStreamingStatus(part: ExtendedChatResponsePart): IConversationTurnStatusEvent | undefined {
		if (part instanceof ChatResponseProgressPart || part instanceof ChatResponseProgressPart2) {
			return this.createStatusEvent('progress', this.extractTextValue(part.value));
		}

		if (part instanceof ChatResponseWarningPart) {
			return this.createStatusEvent('warning', this.extractTextValue(part.value));
		}

		if (part instanceof ChatResponseThinkingProgressPart) {
			const value = Array.isArray(part.value) ? part.value.join('\n') : part.value;
			return this.createStatusEvent('thinking', value);
		}

		return undefined;
	}

	private createStatusEvent(kind: IConversationAssistantStatusKind, content: string | undefined): IConversationTurnStatusEvent | undefined {
		if (!content) {
			return undefined;
		}

		return {
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
			kind,
			content,
		};
	}

	private getStreamingReference(part: ExtendedChatResponsePart): IConversationTurnReferenceEvent | undefined {
		if (!(part instanceof ChatResponseReferencePart || part instanceof ChatResponseReferencePart2)) {
			return undefined;
		}

		const serialized = this.serializeReferenceValue(part.value);
		if (!serialized) {
			return undefined;
		}

		return {
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
			label: serialized.label,
			uri: serialized.uri,
		};
	}

	private getStreamingCodeCitation(part: ExtendedChatResponsePart): IConversationTurnCodeCitationEvent | undefined {
		if (!(part instanceof ChatResponseCodeCitationPart)) {
			return undefined;
		}

		return {
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
			uri: part.value.toString(),
			license: part.license,
			snippet: part.snippet,
		};
	}

	private getStreamingToolInvocation(part: ExtendedChatResponsePart): IConversationTurnToolInvocationEvent | undefined {
		if (!(part instanceof ChatToolInvocationPart)) {
			return undefined;
		}

		const toolName = part.toolName.trim();
		const toolCallId = part.toolCallId.trim();
		if (!toolName || !toolCallId) {
			return undefined;
		}

		const message =
			this.extractTextValue(part.invocationMessage)
			?? this.extractTextValue(part.pastTenseMessage)
			?? this.extractTextValue(part.originMessage);

		return {
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
			toolName,
			toolCallId,
			message,
			isError: Boolean(part.isError),
			isComplete: Boolean(part.isComplete),
		};
	}

	private getStreamingConfirmation(part: ExtendedChatResponsePart): IConversationTurnConfirmationEvent | undefined {
		if (!(part instanceof ChatResponseConfirmationPart)) {
			return undefined;
		}

		const title = part.title.trim();
		const message = this.extractTextValue(part.message) ?? '';
		if (!title && !message) {
			return undefined;
		}

		return {
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
			title,
			message,
			buttons: Array.isArray(part.buttons) && part.buttons.length > 0 ? [...part.buttons] : undefined,
		};
	}

	private getStreamingQuestionCarousel(part: ExtendedChatResponsePart): IConversationTurnQuestionCarouselEvent | undefined {
		if (!(part instanceof ChatResponseQuestionCarouselPart)) {
			return undefined;
		}

		const questions: IConversationQuestionItem[] = [];
		for (const question of part.questions) {
			const title = question.title.trim();
			if (!title) {
				continue;
			}

			questions.push({
				id: question.id,
				type: this.toConversationQuestionType(question.type),
				title,
				message: this.extractTextValue(question.message),
				options: Array.isArray(question.options) && question.options.length > 0
					? question.options.map(option => option.label)
					: undefined,
				allowFreeformInput: Boolean(question.allowFreeformInput),
			});
		}

		if (questions.length === 0) {
			return undefined;
		}

		return {
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
			allowSkip: Boolean(part.allowSkip),
			questions,
		};
	}

	private toConversationQuestionType(type: ChatQuestionType): IConversationQuestionType {
		switch (type) {
			case ChatQuestionType.Text:
				return 'text';
			case ChatQuestionType.SingleSelect:
				return 'singleSelect';
			case ChatQuestionType.MultiSelect:
				return 'multiSelect';
			default:
				return 'unknown';
		}
	}

	private getStreamingCommandButton(part: ExtendedChatResponsePart): IConversationTurnCommandButtonEvent | undefined {
		if (!(part instanceof ChatResponseCommandButtonPart)) {
			return undefined;
		}

		const commandId = typeof part.value.command === 'string' ? part.value.command.trim() : '';
		if (!commandId) {
			return undefined;
		}

		const title = typeof part.value.title === 'string' && part.value.title.trim().length > 0
			? part.value.title.trim()
			: commandId;

		return {
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
			commandId,
			title,
			args: Array.isArray(part.value.arguments) ? [...part.value.arguments] : undefined,
		};
	}

	private getStreamingExtra(part: ExtendedChatResponsePart): IConversationTurnExtraEvent | undefined {
		const extra = this.toStreamingExtra(part);
		if (!extra) {
			return undefined;
		}

		return {
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
			extra,
		};
	}

	private toStreamingExtra(part: ExtendedChatResponsePart): IConversationAssistantExtraItem | undefined {
		if (part instanceof ChatResponseFileTreePart) {
			const tree = fileTreePartToMarkdown(part).trim();
			if (!tree) {
				return undefined;
			}

			return {
				kind: 'fileTree',
				baseUri: part.baseUri.toString(),
				tree,
			};
		}

		if (part instanceof ChatResponseAnchorPart) {
			const serialized = this.serializeAnchorPart(part);
			if (!serialized) {
				return undefined;
			}

			return {
				kind: 'anchor',
				label: serialized.label,
				uri: serialized.uri,
			};
		}

		if (part instanceof ChatResponseCodeblockUriPart) {
			return {
				kind: 'codeblockUri',
				uri: part.value.toString(),
				isEdit: Boolean(part.isEdit),
				undoStopId: part.undoStopId,
			};
		}

		if (part instanceof ChatResponseTextEditPart) {
			return {
				kind: 'textEdit',
				uri: part.uri.toString(),
				editCount: Array.isArray(part.edits) ? part.edits.length : 0,
				isDone: Boolean(part.isDone),
			};
		}

		if (part instanceof ChatResponseNotebookEditPart) {
			return {
				kind: 'notebookEdit',
				uri: part.uri.toString(),
				editCount: Array.isArray(part.edits) ? part.edits.length : 0,
				isDone: Boolean(part.isDone),
			};
		}

		if (part instanceof ChatResponseWorkspaceEditPart) {
			const edits = part.edits
				.map(edit => ({
					oldUri: edit.oldResource?.toString(),
					newUri: edit.newResource?.toString(),
				}))
				.filter(edit => edit.oldUri || edit.newUri);
			if (edits.length === 0) {
				return undefined;
			}

			return {
				kind: 'workspaceEdit',
				edits,
			};
		}

		if (part instanceof ChatResponseMovePart) {
			return {
				kind: 'move',
				uri: part.uri.toString(),
				startLine: part.range.start.line + 1,
				endLine: part.range.end.line + 1,
			};
		}

		if (part instanceof ChatResponseExtensionsPart) {
			const extensions = part.extensions
				.map(extensionId => extensionId.trim())
				.filter(extensionId => extensionId.length > 0);
			if (extensions.length === 0) {
				return undefined;
			}

			return {
				kind: 'extensions',
				extensions,
			};
		}

		if (part instanceof ChatResponsePullRequestPart) {
			const title = part.title.trim();
			const description = part.description.trim();
			const author = part.author.trim();
			const linkTag = part.linkTag.trim();
			if (!title && !description && !author) {
				return undefined;
			}

			const commandId = typeof part.command?.command === 'string' && part.command.command.trim().length > 0
				? part.command.command.trim()
				: undefined;

			return {
				kind: 'pullRequest',
				title: title || 'Pull request',
				description,
				author,
				linkTag,
				commandId,
				commandArgs: Array.isArray(part.command?.arguments) ? [...part.command.arguments] : undefined,
			};
		}

		if (part instanceof ChatResponseExternalEditPart) {
			const uris = part.uris
				.map(uri => uri.toString())
				.filter(uri => uri.trim().length > 0);
			if (uris.length === 0) {
				return undefined;
			}

			return {
				kind: 'externalEdit',
				uris,
			};
		}

		if (this.isChatResponseMultiDiffPart(part)) {
			const entries = part.value
				.map(entry => ({
					originalUri: entry.originalUri?.toString(),
					modifiedUri: entry.modifiedUri?.toString(),
					goToFileUri: entry.goToFileUri?.toString(),
					added: typeof entry.added === 'number' ? entry.added : undefined,
					removed: typeof entry.removed === 'number' ? entry.removed : undefined,
				}))
				.filter(entry => entry.originalUri || entry.modifiedUri || entry.goToFileUri || entry.added !== undefined || entry.removed !== undefined);
			if (entries.length === 0 && part.title.trim().length === 0) {
				return undefined;
			}

			return {
				kind: 'multiDiff',
				title: part.title.trim() || 'Changes',
				readOnly: Boolean(part.readOnly),
				entries,
			};
		}

		return undefined;
	}

	private isChatResponseMultiDiffPart(part: ExtendedChatResponsePart): part is ExtendedChatResponsePart & ChatResponseMultiDiffPartLike {
		const candidate = part as Partial<ChatResponseMultiDiffPartLike>;
		return Array.isArray(candidate.value)
			&& typeof candidate.title === 'string'
			&& (candidate.readOnly === undefined || typeof candidate.readOnly === 'boolean');
	}

	private extractTextValue(value: unknown): string | undefined {
		if (typeof value === 'string') {
			const normalized = value.trim();
			return normalized || undefined;
		}

		if (typeof value === 'object' && value !== null && 'value' in value && typeof value.value === 'string') {
			const normalized = value.value.trim();
			return normalized || undefined;
		}

		return undefined;
	}

	private serializeReferenceValue(value: unknown): { label: string; uri: string | undefined } | undefined {
		if (typeof value === 'string') {
			const label = value.trim();
			if (!label) {
				return undefined;
			}

			return {
				label,
				uri: undefined,
			};
		}

		if (URI.isUri(value)) {
			return {
				label: this.referenceLabelFromUri(value),
				uri: value.toString(),
			};
		}

		if (isLocation(value)) {
			return {
				label: this.referenceLabelFromLocation(value),
				uri: value.uri.toString(),
			};
		}

		if (typeof value === 'object' && value !== null) {
			const variableReference = value as { variableName?: unknown; value?: unknown };
			if (typeof variableReference.variableName !== 'string') {
				return undefined;
			}

			const label = variableReference.variableName.trim();
			const nestedValue = variableReference.value;
			const nestedUri = this.referenceUriFromUnknown(nestedValue);
			if (!label && !nestedUri) {
				return undefined;
			}

			return {
				label: label || this.referenceLabelFromUri(nestedUri!),
				uri: nestedUri?.toString(),
			};
		}

		return undefined;
	}

	private serializeAnchorPart(part: ChatResponseAnchorPart): { label: string; uri: string | undefined } | undefined {
		const anchorWithValue2 = part as ChatResponseAnchorPart & { value2?: unknown };
		const value = anchorWithValue2.value2 ?? part.value;
		const title = typeof part.title === 'string' ? part.title.trim() : '';

		if (isSymbolInformation(value)) {
			const symbolName = value.name.trim();
			if (!title && !symbolName) {
				return undefined;
			}

			return {
				label: title || symbolName,
				uri: value.location?.uri?.toString(),
			};
		}

		const serialized = this.serializeReferenceValue(value);
		if (!serialized) {
			return undefined;
		}

		return {
			label: title || serialized.label,
			uri: serialized.uri,
		};
	}

	private referenceUriFromUnknown(value: unknown): URI | undefined {
		if (!value) {
			return undefined;
		}

		if (URI.isUri(value)) {
			return value;
		}

		if (isLocation(value)) {
			return value.uri;
		}

		return undefined;
	}

	private referenceLabelFromUri(uri: URI): string {
		const pathSegments = uri.path.split('/');
		const basename = pathSegments[pathSegments.length - 1];
		return basename || uri.toString();
	}

	private referenceLabelFromLocation(location: Location): string {
		const startLine = location.range.start.line + 1;
		const endLine = location.range.end.line + 1;
		const lineSuffix = startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`;
		return `${this.referenceLabelFromUri(location.uri)}${lineSuffix}`;
	}

	private async sanitizeVariables(): Promise<ChatRequest> {
		const variablePromises = this.request.references.map(async (ref) => {
			const uri = isLocation(ref.value) ? ref.value.uri : URI.isUri(ref.value) ? ref.value : undefined;
			if (!uri) {
				return ref;
			}

			if (uri.scheme === Schemas.untitled) {
				return ref;
			}

			let removeVariable;
			try {
				// Filter out variables which contain paths which are ignored
				removeVariable = await this._ignoreService.isCopilotIgnored(uri);
			} catch {
				// Non-existent files will be handled elsewhere. This might be a virtual document so it's ok if the fs service can't find it.
			}

			if (removeVariable && ref.range) {
				// Also sanitize the user message since file paths are sensitive
				this.turn.request.message = this.turn.request.message.slice(0, ref.range[0]) + this.turn.request.message.slice(ref.range[1]);
			}

			return removeVariable ? null : ref;
		});

		const newVariables = coalesce(await Promise.all(variablePromises));

		return { ...this.request, references: newVariables };
	}

	private async _shouldAskForPermissiveAuth(): Promise<boolean> {
		// The user has confirmed that they want to auth, so prompt them.
		const findConfirmRequest = this.request.acceptedConfirmationData?.find(ref => ref?.authPermissionPrompted);
		if (findConfirmRequest) {
			this.request = await this._authenticationUpgradeService.handleConfirmationRequest(this.stream, this.request, this.rawHistory);
			this.turn.request.message = this.request.prompt;
			return false;
		}

		// Only ask for confirmation if we're invoking the codebase tool or workspace chat participant
		const isWorkspaceCall = this.request.toolReferences.some(ref => ref.name === ContributedToolName.Codebase);
		// and only if we can't access all repos in the workspace
		if (isWorkspaceCall && await this._authenticationUpgradeService.shouldRequestPermissiveSessionUpgrade()) {
			this._authenticationUpgradeService.showPermissiveSessionUpgradeInChat(this.stream, this.request);
			return true;
		}
		return false;
	}

	async getResult(): Promise<ICopilotChatResult> {
		if (await this._shouldAskForPermissiveAuth()) {
			// Return a random response
			return {
				metadata: {
					modelMessageId: this.turn.responseId ?? '',
					responseId: this.turn.id,
					sessionId: this.conversation.sessionId,
					agentId: this.chatAgentArgs.agentId,
					command: this.request.command,
				}
			};
		}
		this._logService.trace(`[${ChatLocation.toStringShorter(this.location)}] chat request received from extension host`);
		this._conversationStore.reportAssistantTurnStart({
			conversationId: this.conversation.sessionId,
			turnId: this.turn.id,
		});
		try {

			// sanitize the variables of all requests
			// this is done here because all intents must honor ignored files
			this.request = await this.sanitizeVariables();

			const command = this.chatAgentArgs.intentId ?
				this._commandService.getCommand(this.chatAgentArgs.intentId, this.location) :
				undefined;

			let result = this.checkCommandUsage(command);

			if (!result) {
				// this is norm-case, e.g checkCommandUsage didn't produce an error-result
				// and we proceed with the actual intent invocation

				const history = this.conversation.turns.slice(0, -1);
				const intent = await this.selectIntent(command, history);

				let chatResult: Promise<ChatResult>;
				if (typeof intent.handleRequest === 'function') {
					chatResult = intent.handleRequest(this.conversation, this.request, this.stream, this.token, this.documentContext, this.chatAgentArgs.agentName, this.location, this.chatTelemetry, this.yieldRequested);
				} else {
					const intentHandler = this._instantiationService.createInstance(DefaultIntentRequestHandler, intent, this.conversation, this.request, this.stream, this.token, this.documentContext, this.location, this.chatTelemetry, undefined, this.yieldRequested);
					chatResult = intentHandler.getResult();
				}

				if (!this.request.isParticipantDetected) {
					this.intentDetector.collectIntentDetectionContextInternal(
						this.turn.request.message,
						this.request.enableCommandDetection ? intent.id : 'none',
						new ChatVariablesCollection(this.request.references),
						this.location,
						history,
						this.documentContext?.document
					);
				}

				result = await chatResult;
				const endpoint = await this._endpointProvider.getChatEndpoint(this.request);
				result.details = this._authService.copilotToken?.isNoAuthUser ?
					`${endpoint.name}` :
					`${endpoint.name} • ${endpoint.multiplier ?? 0}x`;
			}

			this._conversationStore.addConversation(this.turn.id, this.conversation);

			// mixin fixed metadata shape into result. Modified in place because the object is already
			// cached in the conversation store and we want the full information when looking this up
			// later
			mixin(result, {
				metadata: {
					modelMessageId: this.turn.responseId ?? '',
					responseId: this.turn.id,
					sessionId: this.conversation.sessionId,
					agentId: this.chatAgentArgs.agentId,
					command: this.request.command
				}
			} satisfies ICopilotChatResult, true);

			this._conversationStore.reportAssistantTurnComplete({
				conversationId: this.conversation.sessionId,
				turnId: this.turn.id,
			});

			return <ICopilotChatResult>result;

		} catch (err) {
			this._conversationStore.reportAssistantTurnComplete({
				conversationId: this.conversation.sessionId,
				turnId: this.turn.id,
			});

			// TODO This method should not throw at all, but return a result with errorDetails, and call the IConversationStore
			throw err;
		}
	}

	private async selectIntent(command: CommandDetails | undefined, history: Turn[]): Promise<IIntent> {
		if (!command?.intent && this.location === ChatLocation.Editor) { // TODO@jrieken do away with location specific code

			let preferredIntent: Intent | undefined;
			if (this.documentContext && this.request.attempt === 0 && history.length === 0) {
				if (this.documentContext.selection.isEmpty && this.documentContext.document.lineAt(this.documentContext.selection.start.line).text.trim() === '') {
					preferredIntent = Intent.Generate;
				} else if (!this.documentContext.selection.isEmpty && this.documentContext.selection.start.line !== this.documentContext.selection.end.line) {
					preferredIntent = Intent.Edit;
				}
			}
			if (preferredIntent) {
				return this._intentService.getIntent(preferredIntent, this.location) ?? this._intentService.unknownIntent;
			}
		}

		return command?.intent ?? this._intentService.unknownIntent;
	}

	private checkCommandUsage(command: CommandDetails | undefined): ChatResult | undefined {
		if (command?.intent && !(command.intent.commandInfo?.allowsEmptyArgs ?? true) && !this.turn.request.message) {
			const commandAgent = getAgentForIntent(command.intent.id as Intent, this.location);
			let usage = '';
			if (commandAgent) {
				// If the command was used, it must have an agent
				usage = `@${commandAgent.agent} `;
				if (commandAgent.command) {
					usage += ` /${commandAgent.command}`;
				}
				usage += ` ${command.details}`;

			}

			const message = l10n.t(`Please specify a question when using this command.\n\nUsage: {0}`, usage);
			const chatResult = { errorDetails: { message } };
			this.turn.setResponse(TurnStatus.Error, { type: 'meta', message }, undefined, chatResult);
			return chatResult;
		}
	}
}


export function addHistoryToConversation(accessor: ServicesAccessor, history: ReadonlyArray<ChatRequestTurn | ChatResponseTurn>): { turns: Turn[]; sessionId: string | undefined } {
	const instaService = accessor.get(IInstantiationService);

	const turns: Turn[] = [];
	let sessionId: string | undefined;
	let previousChatRequestTurn: ChatRequestTurn | undefined;

	for (const entry of history) {
		// The extension API model technically supports arbitrary requests/responses not in pairs, but this isn't used anywhere,
		// so we can just fit this to our Conversation model for now.
		if (entry instanceof ChatRequestTurn) {
			previousChatRequestTurn = entry;
		} else {
			const existingTurn = instaService.invokeFunction(findExistingTurnFromVSCodeChatHistoryTurn, entry);
			if (existingTurn) {
				turns.push(existingTurn);
			} else {
				if (previousChatRequestTurn) {
					const deserializedTurn = instaService.invokeFunction(createTurnFromVSCodeChatHistoryTurns, previousChatRequestTurn, entry);
					previousChatRequestTurn = undefined;
					turns.push(deserializedTurn);
				}
			}

			const copilotResult = entry.result as ICopilotChatResultIn;
			if (typeof copilotResult.metadata?.sessionId === 'string') {
				sessionId = copilotResult.metadata.sessionId;
			}
		}
	}

	return { turns, sessionId };
}

/**
 * Try to find an existing `Turn` instance that we created previously based on the responseId of a vscode turn.
 */
function findExistingTurnFromVSCodeChatHistoryTurn(accessor: ServicesAccessor, turn: ChatRequestTurn | ChatResponseTurn): Turn | undefined {
	const conversationStore = accessor.get(IConversationStore);
	const responseId = getResponseIdFromVSCodeChatHistoryTurn(turn);
	const conversation = responseId ? conversationStore.getConversation(responseId) : undefined;
	return conversation?.turns.find(turn => turn.id === responseId);
}

function getResponseIdFromVSCodeChatHistoryTurn(turn: ChatRequestTurn | ChatResponseTurn): string | undefined {
	if (turn instanceof ChatResponseTurn) {
		const lastEntryResult = turn.result as ICopilotChatResultIn | undefined;
		return lastEntryResult?.metadata?.responseId;
	}
	return undefined;
}

/**
 * Try as best as possible to create a `Turn` object from data that comes from vscode.
 */
function createTurnFromVSCodeChatHistoryTurns(
	accessor: ServicesAccessor,
	chatRequestTurn: ChatRequestTurn,
	chatResponseTurn: ChatResponseTurn
): Turn {
	const commandService = accessor.get(ICommandService);
	const workspaceService = accessor.get(IWorkspaceService);
	const instaService = accessor.get(IInstantiationService);

	const chatRequestAsTurn2 = chatRequestTurn as ChatRequestTurn2;
	const currentTurn = new Turn(
		undefined,
		{ message: chatRequestTurn.prompt, type: 'user' },
		new ChatVariablesCollection(chatRequestTurn.references),
		chatRequestTurn.toolReferences.map(InternalToolReference.from),
		chatRequestAsTurn2.editedFileEvents
	);

	// Take just the content messages
	const content = chatResponseTurn.response.map(r => {
		if (r instanceof ChatResponseMarkdownPart) {
			return r.value.value;
		} else if (r instanceof ChatResponseFileTreePart) {
			return fileTreePartToMarkdown(r);
		} else if ('content' in r) {
			return r.content;
		} else if (r instanceof ChatResponseAnchorPart) {
			return anchorPartToMarkdown(workspaceService, r);
		} else {
			return null;
		}
	}).filter(Boolean).join('');
	const intentId = chatResponseTurn.command || getChatParticipantNameFromId(chatResponseTurn.participant);
	const command = commandService.getCommand(intentId, ChatLocation.Panel);
	let status: TurnStatus;
	if (!chatResponseTurn.result.errorDetails) {
		status = TurnStatus.Success;
	} else if (chatResponseTurn.result.errorDetails?.responseIsFiltered) {
		if (chatResponseTurn.result.metadata?.category === FilterReason.Prompt) {
			status = TurnStatus.PromptFiltered;
		} else {
			status = TurnStatus.Filtered;
		}
	} else if (chatResponseTurn.result.errorDetails.message === 'Cancelled' || chatResponseTurn.result.errorDetails.message === CanceledMessage.message) {
		status = TurnStatus.Cancelled;
	} else {
		status = TurnStatus.Error;
	}

	currentTurn.setResponse(status, { message: content, type: 'model', name: command?.commandId || UnknownIntent.ID }, undefined, chatResponseTurn.result);
	const turnMetadata = (chatResponseTurn.result as ICopilotChatResultIn).metadata;
	if (turnMetadata?.renderedGlobalContext) {
		const cacheKey = turnMetadata.globalContextCacheKey ?? instaService.invokeFunction(getGlobalContextCacheKey);
		currentTurn.setMetadata(new GlobalContextMessageMetadata(turnMetadata?.renderedGlobalContext, cacheKey));
	}
	if (turnMetadata?.renderedUserMessage) {
		currentTurn.setMetadata(new RenderedUserMessageMetadata(turnMetadata.renderedUserMessage));
	}
	if (turnMetadata?.promptTokens && turnMetadata?.outputTokens) {
		currentTurn.setMetadata(new AnthropicTokenUsageMetadata(turnMetadata.promptTokens, turnMetadata.outputTokens));
	}

	return currentTurn;
}

function anchorPartToMarkdown(workspaceService: IWorkspaceService, anchor: ChatResponseAnchorPart): string {
	let text: string;
	let path: string;

	if (URI.isUri(anchor.value)) {
		path = getWorkspaceFileDisplayPath(workspaceService, anchor.value);
		const label = anchor.title ?? path;
		text = `\`${label}\``;
	} else if (isLocation(anchor.value)) {
		path = getWorkspaceFileDisplayPath(workspaceService, anchor.value.uri);
		const label = anchor.title ?? `${path}#L${anchor.value.range.start.line + 1}${anchor.value.range.start.line === anchor.value.range.end.line ? '' : `-${anchor.value.range.end.line + 1}`}`;
		text = `\`${label}\``;
	} else if (isSymbolInformation(anchor.value)) {
		path = getWorkspaceFileDisplayPath(workspaceService, anchor.value.location.uri);
		text = `\`${anchor.value.name}\``;
	} else {
		// Unknown anchor type
		return '';
	}

	return `[${text}](${path} ${anchor.title ? `"${anchor.title}"` : ''})`;
}
