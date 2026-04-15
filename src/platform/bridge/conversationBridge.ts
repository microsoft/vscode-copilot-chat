/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IConversationStore, IConversationTurnArtifacts } from '../../extension/conversationStore/node/conversationStore';
import { Disposable } from '../../util/vs/base/common/lifecycle';
import { URI } from '../../util/vs/base/common/uri';
import { IVSCodeExtensionContext } from '../extContext/common/extensionContext';
import { IFileSystemService } from '../filesystem/common/fileSystemService';
import { ILogService } from '../log/common/logService';
import { BridgeAssistantTurnArtifacts, BridgeConversationFilter, BridgeConversationProvider, BridgeConversationStatus, BridgeConversationSummary, BridgeMessage, BridgeModelOption, BridgeModeOption, BridgeServer, BridgeTurnHistoryItem, BridgeUiCommandId } from './bridgeServer';

type GitRepositoryLike = {
	readonly rootUri: vscode.Uri;
	readonly state: {
		readonly HEAD: {
			readonly name?: string;
		} | undefined;
	};
};

type GitApiLike = {
	readonly repositories: readonly GitRepositoryLike[];
	getRepository(uri: vscode.Uri): GitRepositoryLike | null;
};

type GitExtensionLike = {
	readonly enabled: boolean;
	getAPI(version: 1): GitApiLike;
};

const TITLE_MAX_LENGTH = 80;
const DEFAULT_MODE_ID = 'agent';
const UI_MODES: readonly BridgeModeOption[] = [
	{ id: 'agent', label: 'Agent' },
	{ id: 'ask', label: 'Ask' },
	{ id: 'plan', label: 'Plan' },
];
const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;
const ENABLE_LEGACY_GLOBAL_JSON_FALLBACK = false;
const ENABLE_LEGACY_CLI_METADATA_FALLBACK = false;
const GLOBAL_STORAGE_SCAN_MAX_DEPTH = 6;
const KNOWN_NON_SESSION_MAP_KEYS = new Set<string>([
	'cache',
	'chat',
	'chats',
	'config',
	'configuration',
	'conversation',
	'conversations',
	'history',
	'index',
	'message',
	'messages',
	'metadata',
	'mode',
	'modes',
	'model',
	'models',
	'pendingrequests',
	'request',
	'requests',
	'session',
	'sessions',
	'state',
	'settings',
	'transcript',
	'transcripts',
	'turn',
	'turns',
	'workspace',
	'workspacefolder',
]);

type BridgeUiStateMessage = Extract<BridgeMessage, { type: 'ui:state' }>;
type ParsedTranscriptEntry = {
	readonly type: string | undefined;
	readonly role: 'user' | 'assistant' | undefined;
	readonly timestamp: number;
	readonly content: string | undefined;
};
type JsonConversationScanOptions = {
	readonly sourceFolder: string;
	readonly fileStem: string;
	readonly filePathLabel: string;
	readonly providerHint: BridgeConversationProvider;
	readonly fallbackLastUpdated: number;
};

export class ConversationBridge extends Disposable {
	private isActive = false;
	private readonly transcriptsDirUri: URI | undefined;
	private readonly workspaceChatSessionsDirUri: URI | undefined;
	private readonly globalStorageRootUri: URI | undefined;
	private readonly copilotCliMetadataUri: URI | undefined;
	private readonly readProviderSessionSummaries: (() => Promise<readonly BridgeConversationSummary[]>) | undefined;
	private readonly modelOptionsById = new Map<string, BridgeModelOption>();
	private readonly textDecoder = new TextDecoder();
	private selectedModelId: string | undefined;
	private selectedModeId = DEFAULT_MODE_ID;

	constructor(
		private readonly bridgeServer: BridgeServer,
		private readonly conversationStore: IConversationStore,
		private readonly logService: ILogService,
		private readonly fileSystemService: IFileSystemService,
		extensionContext: IVSCodeExtensionContext,
		readProviderSessionSummaries?: () => Promise<readonly BridgeConversationSummary[]>,
	) {
		super();
		this.readProviderSessionSummaries = readProviderSessionSummaries;
		const storageUri = extensionContext.storageUri;
		if (storageUri) {
			this.transcriptsDirUri = URI.joinPath(storageUri, 'transcripts');
			const workspaceBucketUri = URI.joinPath(storageUri, '..');
			this.workspaceChatSessionsDirUri = URI.joinPath(workspaceBucketUri, 'chatSessions');
		}

		const globalStorageUri = extensionContext.globalStorageUri;
		if (globalStorageUri) {
			this.globalStorageRootUri = globalStorageUri;
			this.copilotCliMetadataUri = URI.joinPath(globalStorageUri, 'copilotCli', 'copilotcli.session.metadata.json');
		}
	}

	activate(): void {
		if (this.isActive) {
			return;
		}
		this.isActive = true;

		this.bridgeServer.onPromptReceived = (prompt, conversationId) => {
			void this.submitPrompt(prompt, conversationId);
		};
		this.bridgeServer.onConversationListRequested = (respond, filter) => {
			void this.sendSnapshot(respond, filter);
		};
		this.bridgeServer.onConversationSelected = (conversationId, respond) => {
			void this.getConversationHistory(conversationId).then(turns => {
				respond({
					type: 'conversation:history',
					conversationId,
					turns,
				});
			});
		};
		this.bridgeServer.onUiModelSelected = modelId => {
			void this.changeModel(modelId);
		};
		this.bridgeServer.onUiModeSelected = modeId => {
			void this.changeMode(modeId);
		};
		this.bridgeServer.onUiCommandRequested = (commandId, args) => {
			void this.executeUiCommand(commandId, args);
		};

		this._register(this.conversationStore.onDidConversationListChanged(() => {
			void this.broadcastConversationList();
		}));
		this._register(this.conversationStore.onDidUserTurn(event => {
			this.bridgeServer.broadcast({
				type: 'turn:user',
				conversationId: event.conversationId,
				turnId: event.turnId,
				content: event.content,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnStart(event => {
			this.bridgeServer.broadcast({
				type: 'turn:start',
				conversationId: event.conversationId,
				turnId: event.turnId,
				role: 'assistant',
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnChunk(event => {
			this.bridgeServer.broadcast({
				type: 'turn:chunk',
				conversationId: event.conversationId,
				turnId: event.turnId,
				content: event.content,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnReference(event => {
			this.bridgeServer.broadcast({
				type: 'turn:reference',
				conversationId: event.conversationId,
				turnId: event.turnId,
				label: event.label,
				uri: event.uri,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnCodeCitation(event => {
			this.bridgeServer.broadcast({
				type: 'turn:codeCitation',
				conversationId: event.conversationId,
				turnId: event.turnId,
				uri: event.uri,
				license: event.license,
				snippet: event.snippet,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnStatus(event => {
			this.bridgeServer.broadcast({
				type: 'turn:status',
				conversationId: event.conversationId,
				turnId: event.turnId,
				kind: event.kind,
				content: event.content,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnToolInvocation(event => {
			this.bridgeServer.broadcast({
				type: 'turn:tool',
				conversationId: event.conversationId,
				turnId: event.turnId,
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				message: event.message,
				isError: event.isError,
				isComplete: event.isComplete,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnConfirmation(event => {
			this.bridgeServer.broadcast({
				type: 'turn:confirmation',
				conversationId: event.conversationId,
				turnId: event.turnId,
				title: event.title,
				message: event.message,
				buttons: event.buttons,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnQuestionCarousel(event => {
			this.bridgeServer.broadcast({
				type: 'turn:questions',
				conversationId: event.conversationId,
				turnId: event.turnId,
				allowSkip: event.allowSkip,
				questions: event.questions,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnCommandButton(event => {
			this.bridgeServer.broadcast({
				type: 'turn:button',
				conversationId: event.conversationId,
				turnId: event.turnId,
				commandId: event.commandId,
				title: event.title,
				args: event.args,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnExtra(event => {
			this.bridgeServer.broadcast({
				type: 'turn:extra',
				conversationId: event.conversationId,
				turnId: event.turnId,
				extra: event.extra,
			});
		}));
		this._register(this.conversationStore.onDidAssistantTurnComplete(event => {
			this.bridgeServer.broadcast({
				type: 'turn:complete',
				conversationId: event.conversationId,
				turnId: event.turnId,
			});
			void this.broadcastConversationList();
		}));
	}

	private async sendSnapshot(respond: (message: BridgeMessage) => void, filter?: BridgeConversationFilter): Promise<void> {
		respond({
			type: 'conversation:list',
			conversations: await this.getConversationSummaries(filter),
		});
		respond(await this.getUiStateMessage());
	}

	private async broadcastConversationList(): Promise<void> {
		this.bridgeServer.broadcast({
			type: 'conversation:list',
			conversations: await this.getConversationSummaries(),
		});
	}

	private async getConversationSummaries(filter?: BridgeConversationFilter): Promise<readonly BridgeConversationSummary[]> {
		const providerSummaries = await this.readProviderBackedSessionSummaries();
		const workspaceSummaries = await this.readWorkspaceChatSessionSummaries();

		if (providerSummaries.length > 0) {
			const canonical = new Map<string, BridgeConversationSummary>();
			for (const summary of providerSummaries) {
				canonical.set(summary.id, summary);
			}

			for (const summary of workspaceSummaries) {
				const existing = canonical.get(summary.id);
				if (!existing) {
					continue;
				}

				canonical.set(summary.id, this.enrichCanonicalSummary(existing, summary));
			}

			for (const summary of await this.readGlobalStorageJsonSummaries()) {
				const existing = canonical.get(summary.id);
				if (!existing) {
					continue;
				}

				canonical.set(summary.id, this.enrichCanonicalSummary(existing, summary));
			}

			for (const summary of await this.readCopilotCliSessionSummaries()) {
				const existing = canonical.get(summary.id);
				if (!existing) {
					continue;
				}

				canonical.set(summary.id, this.enrichCanonicalSummary(existing, summary));
			}

			const summaries = Array.from(canonical.values()).sort((a, b) => b.lastUpdated - a.lastUpdated);
			return this.applyConversationFilters(summaries, filter);
		}

		const merged = new Map<string, BridgeConversationSummary>();
		const upsertSummary = (summary: BridgeConversationSummary) => {
			const existing = merged.get(summary.id);
			if (!existing || summary.lastUpdated > existing.lastUpdated) {
				merged.set(summary.id, summary);
				return;
			}

			const canImproveProvider = (existing.provider === undefined || existing.provider === 'unknown')
				&& summary.provider !== undefined
				&& summary.provider !== 'unknown';
			const canImproveStatus = (existing.status === undefined || existing.status === 'unknown')
				&& summary.status !== undefined
				&& summary.status !== 'unknown';

			if (canImproveProvider || canImproveStatus) {
				merged.set(summary.id, {
					...existing,
					provider: canImproveProvider ? summary.provider : existing.provider,
					status: canImproveStatus ? summary.status : existing.status,
				});
			}
		};

		for (const summary of workspaceSummaries) {
			upsertSummary(summary);
		}

		for (const summary of await this.readGlobalStorageJsonSummaries()) {
			upsertSummary(summary);
		}

		for (const summary of await this.readCopilotCliSessionSummaries()) {
			upsertSummary(summary);
		}

		const summaries = Array.from(merged.values()).sort((a, b) => b.lastUpdated - a.lastUpdated);
		return this.applyConversationFilters(summaries, filter);
	}

	private enrichCanonicalSummary(base: BridgeConversationSummary, enrichment: BridgeConversationSummary): BridgeConversationSummary {
		const hasKnownBaseProvider = base.provider !== undefined && base.provider !== 'unknown';
		const hasKnownBaseStatus = base.status !== undefined && base.status !== 'unknown';
		const hasSpecificBaseTitle = base.title.trim().length > 0 && !this.isGenericConversationTitle(base.title);
		const hasSpecificEnrichmentTitle = enrichment.title.trim().length > 0 && !this.isGenericConversationTitle(enrichment.title);

		return {
			id: base.id,
			title: hasSpecificBaseTitle
				? base.title
				: hasSpecificEnrichmentTitle
					? enrichment.title
					: base.title.trim().length > 0
						? base.title
						: enrichment.title,
			lastUpdated: Math.max(base.lastUpdated, enrichment.lastUpdated),
			provider: hasKnownBaseProvider ? base.provider : enrichment.provider,
			status: hasKnownBaseStatus ? base.status : enrichment.status,
		};
	}

	private isGenericConversationTitle(title: string): boolean {
		const normalized = title.trim().toLowerCase();
		if (normalized.length === 0) {
			return true;
		}

		return normalized === 'conversation'
			|| normalized.startsWith('conversation ')
			|| normalized === 'chat'
			|| normalized === 'new chat';
	}

	private async readProviderBackedSessionSummaries(): Promise<readonly BridgeConversationSummary[]> {
		if (!this.readProviderSessionSummaries) {
			return [];
		}

		try {
			return await this.readProviderSessionSummaries();
		} catch (error) {
			this.logService.warn(`[ConversationBridge] Failed to read provider-backed session summaries: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	private async readWorkspaceChatSessionSummaries(): Promise<readonly BridgeConversationSummary[]> {
		const directories = await this.getWorkspaceChatSessionDirectories();
		if (directories.length === 0) {
			return [];
		}

		const summaries: BridgeConversationSummary[] = [];
		for (const directoryUri of directories) {
			let entries: readonly [string, vscode.FileType][];
			try {
				entries = await this.fileSystemService.readDirectory(directoryUri);
			} catch {
				continue;
			}

			const currentSummaries = await Promise.all(entries
				.filter(([name, type]) => name.endsWith('.jsonl') && type === FILE_TYPE_FILE)
				.map(async ([name]) => {
					const sessionId = name.slice(0, -'.jsonl'.length);
					const fileUri = URI.joinPath(directoryUri, name);
					return this.readWorkspaceChatSessionSummaryFromFile(fileUri, sessionId);
				}));
			summaries.push(...currentSummaries.filter((value): value is BridgeConversationSummary => value !== undefined));
		}

		return summaries;
	}

	private async getWorkspaceChatSessionDirectories(): Promise<readonly URI[]> {
		if (!this.workspaceChatSessionsDirUri) {
			return [];
		}

		return [this.workspaceChatSessionsDirUri];
	}

	private async readWorkspaceChatSessionSummaryFromFile(fileUri: URI, sessionId: string): Promise<BridgeConversationSummary | undefined> {
		try {
			const raw = await this.fileSystemService.readFile(fileUri);
			const text = this.textDecoder.decode(raw);

			let title: string | undefined;
			let provider: BridgeConversationProvider = 'local';
			let status: BridgeConversationStatus = 'read';

			for (const line of text.split('\n')) {
				if (!line.trim()) {
					continue;
				}

				status = this.detectStatusFromLine(line, status);

				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}

				if (!this.isRecord(parsed)) {
					continue;
				}

				const kind = typeof parsed.kind === 'number' ? parsed.kind : undefined;
				const keyPath = Array.isArray(parsed.k) ? parsed.k : undefined;

				if (kind === 0 && this.isRecord(parsed.v)) {
					const sessionState = parsed.v;
					if (!title) {
						title = this.extractTitleFromSessionState(sessionState);
					}

					const inputState = this.isRecord(sessionState.inputState) ? sessionState.inputState : undefined;
					provider = this.providerFromModelIdentifier(this.extractModelIdentifier(inputState?.selectedModel), provider);

					if ((Array.isArray(sessionState.pendingRequests) && sessionState.pendingRequests.length > 0) || sessionState.hasPendingEdits === true) {
						status = 'in-progress';
					}
				}

				if (kind === 1 && keyPath) {
					if (this.keyPathEquals(keyPath, 'customTitle') && typeof parsed.v === 'string' && parsed.v.trim().length > 0) {
						// customTitle is the most authoritative source — always use it.
						title = this.truncateConversationTitle(parsed.v.trim());
					}

					if (!title && this.keyPathEquals(keyPath, 'inputState', 'inputText') && typeof parsed.v === 'string' && parsed.v.trim().length > 0) {
						title = this.truncateConversationTitle(parsed.v.trim());
					}

					if (!title && this.keyPathEquals(keyPath, 'pendingRequests') && Array.isArray(parsed.v)) {
						title = this.extractTitleFromPendingRequests(parsed.v);
					}

					if (this.keyPathEquals(keyPath, 'inputState', 'selectedModel')) {
						provider = this.providerFromModelIdentifier(this.extractModelIdentifier(parsed.v), provider);
					}

					if ((this.keyPathEquals(keyPath, 'pendingRequests') && Array.isArray(parsed.v) && parsed.v.length > 0) || (this.keyPathEquals(keyPath, 'hasPendingEdits') && parsed.v === true)) {
						status = 'in-progress';
					}
				}

				if (kind === 2 && keyPath && Array.isArray(parsed.v)) {
					if (this.keyPathEquals(keyPath, 'requests')) {
						const requestTitle = this.extractTitleFromRequests(parsed.v);
						if (!title && requestTitle) {
							title = requestTitle;
						}
					} else if (this.keyPathStartsWith(keyPath, 'pendingRequests')) {
						const pendingTitle = this.extractTitleFromPendingRequests(parsed.v);
						if (!title && pendingTitle) {
							title = pendingTitle;
						}
					}
				}
			}

			let lastUpdated = 0;
			try {
				lastUpdated = (await this.fileSystemService.stat(fileUri)).mtime;
			} catch {
				lastUpdated = Date.now();
			}

			if (title === undefined) {
				// No extractable title — session has no real content; skip it.
				return undefined;
			}

			return {
				id: sessionId,
				title,
				lastUpdated,
				provider,
				status,
			};
		} catch {
			return undefined;
		}
	}

	private async readGlobalStorageJsonSummaries(): Promise<readonly BridgeConversationSummary[]> {
		if (!ENABLE_LEGACY_GLOBAL_JSON_FALLBACK) {
			return [];
		}

		if (!this.globalStorageRootUri) {
			return [];
		}

		const summaries: BridgeConversationSummary[] = [];
		try {
			const entries = await this.fileSystemService.readDirectory(this.globalStorageRootUri);
			for (const [folderName, folderType] of entries) {
				if (folderType !== FILE_TYPE_DIRECTORY) {
					continue;
				}

				// Avoid stale sidecar artifacts and keep this scan aligned with real session metadata files.
				if (folderName.toLowerCase() === 'sidecar') {
					continue;
				}

				const folderUri = URI.joinPath(this.globalStorageRootUri, folderName);
				let folderEntries: readonly [string, vscode.FileType][];
				try {
					folderEntries = await this.fileSystemService.readDirectory(folderUri);
				} catch {
					continue;
				}

				for (const [fileName, fileType] of folderEntries) {
					if (fileType !== FILE_TYPE_FILE || !fileName.endsWith('.json')) {
						continue;
					}

					if (!this.isLikelySessionMetadataJsonFile(fileName)) {
						continue;
					}

					const fileUri = URI.joinPath(folderUri, fileName);
					const scanned = await this.readGlobalStorageJsonFileSummaries(fileUri, folderName);
					summaries.push(...scanned);
				}
			}
		} catch {
			return [];
		}

		return summaries;
	}

	private isLikelySessionMetadataJsonFile(fileName: string): boolean {
		const normalized = fileName.trim().toLowerCase();
		if (!normalized.endsWith('.json')) {
			return false;
		}

		if (normalized === 'conversations.json') {
			return false;
		}

		if (normalized.includes('embedding')) {
			return false;
		}

		return normalized.includes('session') || normalized.includes('conversation') || normalized.includes('chat');
	}

	private async readGlobalStorageJsonFileSummaries(fileUri: URI, sourceFolder: string): Promise<readonly BridgeConversationSummary[]> {
		let fallbackLastUpdated = Date.now();
		try {
			fallbackLastUpdated = (await this.fileSystemService.stat(fileUri)).mtime;
		} catch {
			// Ignore stat errors; keep fallback timestamp.
		}

		try {
			const raw = await this.fileSystemService.readFile(fileUri);
			const parsed: unknown = JSON.parse(this.textDecoder.decode(raw));
			const fileName = this.basenameFromUri(fileUri);
			const fileStem = fileName.endsWith('.json') ? fileName.slice(0, -'.json'.length) : fileName;
			return this.extractConversationSummariesFromJson(parsed, {
				sourceFolder,
				fileStem,
				filePathLabel: `${sourceFolder}/${fileName}`,
				providerHint: this.providerFromSourceFolder(sourceFolder),
				fallbackLastUpdated,
			});
		} catch {
			return [];
		}
	}

	private extractConversationSummariesFromJson(value: unknown, options: JsonConversationScanOptions): readonly BridgeConversationSummary[] {
		const summariesById = new Map<string, BridgeConversationSummary>();

		const visit = (node: unknown, mapKey: string | undefined, depth: number): void => {
			if (depth > GLOBAL_STORAGE_SCAN_MAX_DEPTH) {
				return;
			}

			if (Array.isArray(node)) {
				for (const item of node) {
					visit(item, undefined, depth + 1);
				}
				return;
			}

			if (!this.isRecord(node)) {
				return;
			}

			const summary = this.tryBuildSummaryFromJsonRecord(node, mapKey, options);
			if (summary) {
				const existing = summariesById.get(summary.id);
				if (!existing || summary.lastUpdated > existing.lastUpdated) {
					summariesById.set(summary.id, summary);
				}
			}

			for (const [childKey, childValue] of Object.entries(node)) {
				visit(childValue, this.isRecord(childValue) ? childKey : undefined, depth + 1);
			}
		};

		visit(value, undefined, 0);
		return Array.from(summariesById.values());
	}

	private tryBuildSummaryFromJsonRecord(record: Record<string, unknown>, mapKey: string | undefined, options: JsonConversationScanOptions): BridgeConversationSummary | undefined {
		const title = this.extractJsonConversationTitle(record);
		const status = this.extractJsonConversationStatus(record);
		if (!this.looksLikeConversationRecord(record, title, status)) {
			return undefined;
		}

		const id = this.resolveJsonConversationId(record, mapKey, options.fileStem);
		if (!id) {
			return undefined;
		}

		const lastUpdated = this.extractJsonConversationTimestamp(record) ?? options.fallbackLastUpdated;
		const provider = this.extractJsonConversationProvider(record, options.providerHint);
		return {
			id,
			title: title ?? 'Conversation',
			lastUpdated,
			provider,
			status: status ?? 'unknown',
		};
	}

	private resolveJsonConversationId(record: Record<string, unknown>, mapKey: string | undefined, fileStem: string): string | undefined {
		const directCandidates = [record.sessionId, record.conversationId, record.chatSessionId, record.id];
		for (const candidate of directCandidates) {
			if (typeof candidate === 'string' && candidate.trim().length > 0) {
				return candidate.trim();
			}
		}

		if (mapKey && this.looksLikeSessionMapKey(mapKey)) {
			return mapKey.trim();
		}

		if (this.looksLikeSessionMapKey(fileStem)) {
			return fileStem.trim();
		}

		return undefined;
	}

	private looksLikeSessionMapKey(value: string): boolean {
		const normalized = value.trim().toLowerCase();
		if (normalized.length < 6) {
			return false;
		}

		if (KNOWN_NON_SESSION_MAP_KEYS.has(normalized)) {
			return false;
		}

		return true;
	}

	private looksLikeConversationRecord(record: Record<string, unknown>, title: string | undefined, status: BridgeConversationStatus | undefined): boolean {
		if (title || status) {
			return true;
		}

		if (typeof record.sessionId === 'string' || typeof record.conversationId === 'string' || typeof record.chatSessionId === 'string') {
			return true;
		}

		if (Array.isArray(record.requests) || Array.isArray(record.turns) || Array.isArray(record.messages)) {
			return true;
		}

		if ((Array.isArray(record.pendingRequests) && record.pendingRequests.length > 0) || record.hasPendingEdits === true) {
			return true;
		}

		const inputState = this.isRecord(record.inputState) ? record.inputState : undefined;
		const selectedModel = inputState?.selectedModel ?? record.selectedModel ?? record.model;
		if (this.extractModelIdentifier(selectedModel) !== undefined) {
			return true;
		}

		return false;
	}

	private extractJsonConversationTitle(record: Record<string, unknown>): string | undefined {
		const directTitleCandidates = [
			record.customTitle,
			record.title,
			record.name,
			record.firstUserMessage,
			record.summary,
		];

		for (const candidate of directTitleCandidates) {
			if (typeof candidate === 'string' && candidate.trim().length > 0) {
				return this.truncateConversationTitle(candidate.trim());
			}
		}

		const inputState = this.isRecord(record.inputState) ? record.inputState : undefined;
		if (inputState && typeof inputState.inputText === 'string' && inputState.inputText.trim().length > 0) {
			return this.truncateConversationTitle(inputState.inputText.trim());
		}

		if (Array.isArray(record.requests)) {
			const requestTitle = this.extractTitleFromRequests(record.requests);
			if (requestTitle) {
				return requestTitle;
			}
		}

		if (Array.isArray(record.turns)) {
			const turnTitle = this.extractTitleFromRequests(record.turns);
			if (turnTitle) {
				return turnTitle;
			}
		}

		if (Array.isArray(record.messages)) {
			for (const message of record.messages) {
				if (!this.isRecord(message)) {
					continue;
				}

				const role = typeof message.role === 'string' ? message.role.toLowerCase() : undefined;
				if (role && role !== 'user') {
					continue;
				}

				const messageText = this.extractTextContent(message.content ?? message.message ?? message.text);
				if (messageText) {
					return this.truncateConversationTitle(messageText);
				}
			}
		}

		return undefined;
	}

	private extractJsonConversationTimestamp(record: Record<string, unknown>): number | undefined {
		const timestampCandidates = [
			record.lastUpdated,
			record.updatedAt,
			record.updateTime,
			record.timestamp,
			record.time,
			record.startTime,
			record.modifiedAt,
			record.createdAt,
			record.mtime,
		];

		for (const candidate of timestampCandidates) {
			const parsed = this.parsePossibleTimestamp(candidate);
			if (parsed !== undefined) {
				return parsed;
			}
		}

		const workspaceFolder = this.isRecord(record.workspaceFolder) ? record.workspaceFolder : undefined;
		const workspaceTimestamp = this.parsePossibleTimestamp(workspaceFolder?.timestamp);
		if (workspaceTimestamp !== undefined) {
			return workspaceTimestamp;
		}

		const metadata = this.isRecord(record.metadata) ? record.metadata : undefined;
		if (metadata) {
			const metadataCandidates = [metadata.lastUpdated, metadata.updatedAt, metadata.timestamp, metadata.time];
			for (const candidate of metadataCandidates) {
				const parsed = this.parsePossibleTimestamp(candidate);
				if (parsed !== undefined) {
					return parsed;
				}
			}
		}

		return undefined;
	}

	private parsePossibleTimestamp(value: unknown): number | undefined {
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			return value < 100000000000 ? Math.floor(value * 1000) : Math.floor(value);
		}

		if (typeof value !== 'string') {
			return undefined;
		}

		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return undefined;
		}

		const numericValue = Number(trimmed);
		if (Number.isFinite(numericValue) && numericValue > 0) {
			return numericValue < 100000000000 ? Math.floor(numericValue * 1000) : Math.floor(numericValue);
		}

		const parsedDate = new Date(trimmed).getTime();
		return Number.isFinite(parsedDate) ? parsedDate : undefined;
	}

	private extractJsonConversationProvider(record: Record<string, unknown>, providerHint: BridgeConversationProvider): BridgeConversationProvider {
		let provider = providerHint;

		if (typeof record.provider === 'string') {
			provider = this.providerFromModelIdentifier(record.provider, provider);
		}

		if (typeof record.vendor === 'string' && typeof record.id === 'string') {
			provider = this.providerFromModelIdentifier(`${record.vendor}/${record.id}`, provider);
		}

		const inputState = this.isRecord(record.inputState) ? record.inputState : undefined;
		const metadata = this.isRecord(record.metadata) ? record.metadata : undefined;
		const modelIdentifier = this.extractModelIdentifier(
			inputState?.selectedModel
			?? record.selectedModel
			?? record.model
			?? metadata?.selectedModel
		);

		return this.providerFromModelIdentifier(modelIdentifier, provider);
	}

	private extractJsonConversationStatus(record: Record<string, unknown>): BridgeConversationStatus | undefined {
		if ((Array.isArray(record.pendingRequests) && record.pendingRequests.length > 0) || record.hasPendingEdits === true) {
			return 'in-progress';
		}

		const metadata = this.isRecord(record.metadata) ? record.metadata : undefined;
		const statusCandidates = [record.status, record.state, record.lifecycle, metadata?.status];
		for (const candidate of statusCandidates) {
			if (typeof candidate !== 'string') {
				continue;
			}

			const normalizedStatus = this.normalizeConversationStatus(candidate);
			if (normalizedStatus) {
				return normalizedStatus;
			}
		}

		return undefined;
	}

	private normalizeConversationStatus(value: string): BridgeConversationStatus | undefined {
		const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-');
		if (normalized.length === 0) {
			return undefined;
		}

		if (normalized.includes('input-needed') || normalized.includes('needsinput') || normalized.includes('awaitinginput') || normalized.includes('awaiting-input') || normalized.includes('inputrequired')) {
			return 'input-needed';
		}

		if (normalized.includes('in-progress') || normalized.includes('inprogress') || normalized.includes('running') || normalized.includes('pending')) {
			return 'in-progress';
		}

		if (normalized.includes('fail') || normalized.includes('error')) {
			return 'failed';
		}

		if (normalized.includes('archive')) {
			return 'archived';
		}

		if (normalized.includes('complete') || normalized.includes('done') || normalized.includes('success')) {
			return 'completed';
		}

		if (normalized.includes('read') || normalized.includes('seen')) {
			return 'read';
		}

		return undefined;
	}

	private providerFromSourceFolder(sourceFolder: string): BridgeConversationProvider {
		const normalized = sourceFolder.trim().toLowerCase();
		if (normalized.includes('chatsession') || normalized.includes('conversation') || normalized.includes('transcript')) {
			return 'local';
		}

		return this.providerFromModelIdentifier(sourceFolder, 'unknown');
	}

	private basenameFromUri(uri: URI): string {
		const lastSlash = uri.path.lastIndexOf('/');
		return lastSlash === -1 ? uri.path : uri.path.slice(lastSlash + 1);
	}

	private async readCopilotCliSessionSummaries(): Promise<readonly BridgeConversationSummary[]> {
		if (!ENABLE_LEGACY_CLI_METADATA_FALLBACK) {
			return [];
		}

		if (!this.copilotCliMetadataUri) {
			return [];
		}

		try {
			const raw = await this.fileSystemService.readFile(this.copilotCliMetadataUri);
			const parsed: unknown = JSON.parse(this.textDecoder.decode(raw));
			if (!this.isRecord(parsed)) {
				return [];
			}

			const summaries: BridgeConversationSummary[] = [];
			for (const [sessionId, metadata] of Object.entries(parsed)) {
				if (!this.isRecord(metadata)) {
					continue;
				}

				let title = typeof metadata.customTitle === 'string' ? metadata.customTitle.trim() : '';
				if (!title && typeof metadata.firstUserMessage === 'string') {
					title = metadata.firstUserMessage.trim();
				}

				let lastUpdated = 0;
				const workspaceFolder = this.isRecord(metadata.workspaceFolder) ? metadata.workspaceFolder : undefined;
				if (workspaceFolder && typeof workspaceFolder.timestamp === 'number') {
					lastUpdated = workspaceFolder.timestamp;
				}

				summaries.push({
					id: sessionId,
					title: title ? this.truncateConversationTitle(title) : 'Copilot CLI Session',
					lastUpdated,
					provider: 'copilot-cli',
					status: 'completed',
				});
			}

			return summaries;
		} catch {
			return [];
		}
	}

	private applyConversationFilters(summaries: readonly BridgeConversationSummary[], filter?: BridgeConversationFilter): readonly BridgeConversationSummary[] {
		if (!filter) {
			return summaries;
		}

		const providerFilter = this.normalizeFilterSet(filter.providers);
		const statusFilter = this.normalizeFilterSet(filter.statuses);
		const search = typeof filter.search === 'string' ? filter.search.trim().toLowerCase() : '';

		return summaries.filter(summary => {
			const provider = (summary.provider ?? 'unknown').toLowerCase();
			if (providerFilter && !providerFilter.has(provider)) {
				return false;
			}

			const status = (summary.status ?? 'unknown').toLowerCase();
			if (statusFilter && !statusFilter.has(status)) {
				return false;
			}

			if (search) {
				const haystack = `${summary.title} ${summary.id}`.toLowerCase();
				if (!haystack.includes(search)) {
					return false;
				}
			}

			return true;
		});
	}

	private normalizeFilterSet(values: readonly string[] | undefined): ReadonlySet<string> | undefined {
		if (!values || values.length === 0) {
			return undefined;
		}

		const normalized = values
			.map(value => value.trim().toLowerCase())
			.filter(value => value.length > 0);

		return normalized.length > 0 ? new Set(normalized) : undefined;
	}

	private async getConversationHistory(conversationId: string): Promise<readonly BridgeTurnHistoryItem[]> {
		const conversation = this.conversationStore.getConversationBySessionId(conversationId);
		if (conversation) {
			return this.extractTurnsFromConversation(conversation);
		}

		const transcriptHistory = await this.readTranscriptHistory(conversationId);
		if (transcriptHistory.length > 0) {
			return transcriptHistory;
		}

		return this.readWorkspaceChatSessionHistory(conversationId);
	}

	private extractTurnsFromConversation(conversation: { sessionId: string; turns: readonly { id: string; request: { message: string }; startTime: number; responseMessage?: { message?: string }; rounds?: readonly { response?: string }[] }[] }): readonly BridgeTurnHistoryItem[] {
		const history: BridgeTurnHistoryItem[] = [];
		for (const turn of conversation.turns) {
			const userMessage = turn.request.message.trim();
			if (userMessage.length > 0) {
				history.push({
					role: 'user',
					content: userMessage,
					timestamp: turn.startTime,
				});
			}

			const assistantMessage = this.extractAssistantMessageFromTurn(turn);
			const artifacts = this.toBridgeTurnArtifacts(this.conversationStore.getAssistantTurnArtifacts(conversation.sessionId, turn.id));
			if (assistantMessage.length > 0 || this.hasBridgeArtifacts(artifacts)) {
				history.push({
					role: 'assistant',
					content: assistantMessage,
					timestamp: turn.startTime,
					artifacts,
				});
			}
		}
		return history;
	}

	private extractAssistantMessageFromTurn(turn: { responseMessage?: { message?: string }; rounds?: readonly { response?: string }[] }): string {
		const directMessage = turn.responseMessage?.message?.trim() ?? '';
		if (directMessage.length > 0) {
			return directMessage;
		}

		if (!Array.isArray(turn.rounds)) {
			return '';
		}

		const roundResponses = turn.rounds
			.map(round => typeof round.response === 'string' ? round.response.trim() : '')
			.filter(response => response.length > 0);
		if (roundResponses.length === 0) {
			return '';
		}

		return roundResponses.join('\n\n');
	}

	private toBridgeTurnArtifacts(artifacts: IConversationTurnArtifacts | undefined): BridgeAssistantTurnArtifacts | undefined {
		if (!artifacts) {
			return undefined;
		}

		const bridgeArtifacts: BridgeAssistantTurnArtifacts = {
			statuses: artifacts.statuses.length > 0 ? [...artifacts.statuses] : undefined,
			tools: artifacts.tools.length > 0 ? [...artifacts.tools] : undefined,
			references: artifacts.references.length > 0 ? [...artifacts.references] : undefined,
			codeCitations: artifacts.codeCitations.length > 0 ? [...artifacts.codeCitations] : undefined,
			confirmations: artifacts.confirmations.length > 0 ? [...artifacts.confirmations] : undefined,
			questionCarousels: artifacts.questionCarousels.length > 0 ? [...artifacts.questionCarousels] : undefined,
			commandButtons: artifacts.commandButtons.length > 0 ? [...artifacts.commandButtons] : undefined,
			extras: artifacts.extras.length > 0 ? [...artifacts.extras] : undefined,
		};

		return this.hasBridgeArtifacts(bridgeArtifacts) ? bridgeArtifacts : undefined;
	}

	private hasBridgeArtifacts(artifacts: BridgeAssistantTurnArtifacts | undefined): boolean {
		if (!artifacts) {
			return false;
		}

		return (artifacts.statuses?.length ?? 0) > 0
			|| (artifacts.tools?.length ?? 0) > 0
			|| (artifacts.references?.length ?? 0) > 0
			|| (artifacts.codeCitations?.length ?? 0) > 0
			|| (artifacts.confirmations?.length ?? 0) > 0
			|| (artifacts.questionCarousels?.length ?? 0) > 0
			|| (artifacts.commandButtons?.length ?? 0) > 0
			|| (artifacts.extras?.length ?? 0) > 0;
	}

	private async readTranscriptHistory(sessionId: string): Promise<readonly BridgeTurnHistoryItem[]> {
		if (!this.transcriptsDirUri) {
			return [];
		}

		const fileUri = URI.joinPath(this.transcriptsDirUri, `${sessionId}.jsonl`);
		try {
			const raw = await this.fileSystemService.readFile(fileUri);
			const text = this.textDecoder.decode(raw);
			const entries = this.parseTranscriptEntries(text);
			const history: BridgeTurnHistoryItem[] = [];

			for (const entry of entries) {
				if (entry.role === 'user' && typeof entry.content === 'string') {
					const content = entry.content.trim();
					if (content.length > 0) {
						history.push({ role: 'user', content, timestamp: entry.timestamp });
					}
				} else if (entry.role === 'assistant' && typeof entry.content === 'string') {
					const content = entry.content.trim();
					if (content.length > 0) {
						history.push({ role: 'assistant', content, timestamp: entry.timestamp });
					}
				}
			}

			return history;
		} catch {
			// Transcript file not found or unreadable — expected for older sessions.
			return [];
		}
	}

	private async readWorkspaceChatSessionHistory(sessionId: string): Promise<readonly BridgeTurnHistoryItem[]> {
		const fileUri = await this.findWorkspaceChatSessionFile(sessionId);
		if (!fileUri) {
			return [];
		}

		try {
			const raw = await this.fileSystemService.readFile(fileUri);
			const text = this.textDecoder.decode(raw);

			// Reconstruct the final session state by applying all patches in order.
			// kind=2 patches with k=["requests", N, "response"] accumulate response items
			// for request N and must not be treated as arrays of request objects.
			const requestsByIndex = new Map<number, Record<string, unknown>>();
			const responseAccumulator = new Map<number, unknown[]>();
			let nextRequestIdx = 0;

			for (const line of text.split('\n')) {
				if (!line.trim()) {
					continue;
				}

				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}

				if (!this.isRecord(parsed) || typeof parsed.kind !== 'number') {
					continue;
				}

				if (parsed.kind === 0 && this.isRecord(parsed.v) && Array.isArray(parsed.v.requests)) {
					for (let i = 0; i < parsed.v.requests.length; i++) {
						if (this.isRecord(parsed.v.requests[i])) {
							requestsByIndex.set(i, { ...(parsed.v.requests[i] as Record<string, unknown>) });
						}
					}
					nextRequestIdx = parsed.v.requests.length;
					continue;
				}

				if (parsed.kind === 1 && Array.isArray(parsed.k) && parsed.k.length === 3
					&& parsed.k[0] === 'requests' && typeof parsed.k[1] === 'number' && parsed.k[2] === 'response'
					&& Array.isArray(parsed.v)) {
					// kind=1 sets the full response array for a specific request index.
					const reqIdx = parsed.k[1] as number;
					responseAccumulator.set(reqIdx, parsed.v as unknown[]);
					continue;
				}

				if (parsed.kind === 2 && Array.isArray(parsed.k) && Array.isArray(parsed.v)) {
					if (this.keyPathEquals(parsed.k, 'requests')) {
						// Each such patch appends one (or more) new request objects.
						for (const item of parsed.v) {
							if (this.isRecord(item)) {
								requestsByIndex.set(nextRequestIdx++, { ...(item as Record<string, unknown>) });
							}
						}
						continue;
					}

					if (parsed.k.length === 3 && parsed.k[0] === 'requests' && typeof parsed.k[1] === 'number' && parsed.k[2] === 'response') {
						// Accumulate response parts for a specific request index.
						const reqIdx = parsed.k[1] as number;
						const existing = responseAccumulator.get(reqIdx) ?? [];
						responseAccumulator.set(reqIdx, existing.concat(parsed.v));
						continue;
					}
				}
			}

			// Merge accumulated response patches into each request's response array.
			for (const [idx, req] of requestsByIndex) {
				const accumulated = responseAccumulator.get(idx);
				if (accumulated && accumulated.length > 0) {
					const existing = Array.isArray(req.response) ? (req.response as unknown[]) : [];
					req.response = [...existing, ...accumulated];
				}
			}

			// Extract conversation turns from the fully-reconstructed requests.
			const history: BridgeTurnHistoryItem[] = [];
			const seenKeys = new Set<string>();
			const sortedRequests = Array.from(requestsByIndex.entries())
				.sort(([a], [b]) => a - b)
				.map(([, req]) => req);

			this.appendTurnsFromRequestArray(sortedRequests, history, seenKeys);
			history.sort((a, b) => a.timestamp - b.timestamp);
			return history;
		} catch {
			return [];
		}
	}

	private async findWorkspaceChatSessionFile(sessionId: string): Promise<URI | undefined> {
		const directories = await this.getWorkspaceChatSessionDirectories();
		for (const directoryUri of directories) {
			const candidate = URI.joinPath(directoryUri, `${sessionId}.jsonl`);
			try {
				const stat = await this.fileSystemService.stat(candidate);
				if (stat.type === FILE_TYPE_FILE) {
					return candidate;
				}
			} catch {
				continue;
			}
		}

		return undefined;
	}

	private appendTurnsFromRequestArray(requests: readonly unknown[], history: BridgeTurnHistoryItem[], seenKeys: Set<string>): void {
		for (const request of requests) {
			if (!this.isRecord(request)) {
				continue;
			}

			const timestamp = this.extractRequestTimestamp(request);
			const userMessage = this.extractRequestMessage(request);
			if (userMessage) {
				const key = `user:${timestamp}:${userMessage}`;
				if (!seenKeys.has(key)) {
					seenKeys.add(key);
					history.push({ role: 'user', content: userMessage, timestamp });
				}
			}

			const { text: assistantMessage, toolLines } = this.extractRequestAssistantContent(request);
			if (assistantMessage || toolLines.length > 0) {
				const key = `assistant:${timestamp}:${assistantMessage}`;
				if (!seenKeys.has(key)) {
					seenKeys.add(key);
					history.push({
						role: 'assistant',
						content: assistantMessage ?? '',
						timestamp,
						toolLines: toolLines.length > 0 ? toolLines : undefined,
					});
				}
			}
		}
	}

	private parseTranscriptEntries(text: string): readonly ParsedTranscriptEntry[] {
		const entries: ParsedTranscriptEntry[] = [];
		const now = Date.now();

		for (const line of text.split('\n')) {
			if (!line.trim()) {
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}

			if (!this.isRecord(parsed)) {
				continue;
			}

			const type = typeof parsed.type === 'string' ? parsed.type : undefined;
			const role = this.extractTranscriptRole(parsed, type);
			const content = this.extractTranscriptContent(parsed, role);
			const rawTimestamp = parsed.timestamp;
			const parsedTimestamp = typeof rawTimestamp === 'string' || typeof rawTimestamp === 'number'
				? new Date(rawTimestamp).getTime()
				: now;

			entries.push({
				type,
				role,
				timestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : now,
				content,
			});
		}

		return entries;
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null;
	}

	private keyPathEquals(path: readonly unknown[] | undefined, ...segments: readonly string[]): boolean {
		if (!path || path.length !== segments.length) {
			return false;
		}

		return segments.every((segment, index) => path[index] === segment);
	}

	private keyPathStartsWith(path: readonly unknown[] | undefined, ...segments: readonly string[]): boolean {
		if (!path || path.length < segments.length) {
			return false;
		}

		return segments.every((segment, index) => path[index] === segment);
	}

	private detectStatusFromLine(line: string, currentStatus: BridgeConversationStatus): BridgeConversationStatus {
		if (currentStatus === 'in-progress') {
			return currentStatus;
		}

		const normalized = line.toLowerCase();
		if (normalized.includes('input needed') || normalized.includes('needsinput') || normalized.includes('status":"inputneeded')) {
			return 'input-needed';
		}

		if (normalized.includes('status":"failed') || normalized.includes('chatsessionstatus.failed')) {
			return 'failed';
		}

		if (normalized.includes('status":"inprogress') || normalized.includes('chatsessionstatus.inprogress')) {
			return 'in-progress';
		}

		if (normalized.includes('archived')) {
			return 'archived';
		}

		return currentStatus;
	}

	private extractTitleFromSessionState(state: Record<string, unknown>): string | undefined {
		if (typeof state.customTitle === 'string' && state.customTitle.trim().length > 0) {
			return this.truncateConversationTitle(state.customTitle.trim());
		}

		const titleFromRequests = this.extractTitleFromRequests(state.requests);
		if (titleFromRequests) {
			return titleFromRequests;
		}

		const titleFromPendingRequests = this.extractTitleFromPendingRequests(state.pendingRequests);
		if (titleFromPendingRequests) {
			return titleFromPendingRequests;
		}

		const inputState = this.isRecord(state.inputState) ? state.inputState : undefined;
		if (inputState && typeof inputState.inputText === 'string' && inputState.inputText.trim().length > 0) {
			return this.truncateConversationTitle(inputState.inputText.trim());
		}

		return undefined;
	}

	private extractTitleFromRequests(value: unknown): string | undefined {
		if (!Array.isArray(value)) {
			return undefined;
		}

		for (const request of value) {
			if (!this.isRecord(request)) {
				continue;
			}

			const message = this.extractRequestMessage(request);
			if (message) {
				return this.truncateConversationTitle(message);
			}
		}

		return undefined;
	}

	private extractTitleFromPendingRequests(value: unknown): string | undefined {
		if (!Array.isArray(value)) {
			return undefined;
		}

		for (const entry of value) {
			if (!this.isRecord(entry)) {
				continue;
			}

			const nestedRequest = this.isRecord(entry.request) ? entry.request : undefined;
			if (!nestedRequest) {
				continue;
			}

			const message = this.extractRequestMessage(nestedRequest);
			if (message) {
				return this.truncateConversationTitle(message);
			}
		}

		return undefined;
	}

	private extractRequestMessage(request: Record<string, unknown>): string | undefined {
		const asTrimmed = (value: unknown): string | undefined => {
			if (typeof value !== 'string') {
				return undefined;
			}
			const trimmed = value.trim();
			return trimmed.length > 0 ? trimmed : undefined;
		};

		const message = request.message;
		const messageText = asTrimmed(message);
		if (messageText) {
			return messageText;
		}

		if (this.isRecord(message)) {
			const fromText = asTrimmed(message.text);
			if (fromText) {
				return fromText;
			}

			const fromMessage = asTrimmed(message.message);
			if (fromMessage) {
				return fromMessage;
			}
		}

		const nestedRequest = this.isRecord(request.request) ? request.request : undefined;
		if (nestedRequest) {
			const nestedMessage = asTrimmed(nestedRequest.message);
			if (nestedMessage) {
				return nestedMessage;
			}

			if (this.isRecord(nestedRequest.message)) {
				const nestedText = asTrimmed(nestedRequest.message.text);
				if (nestedText) {
					return nestedText;
				}
			}
		}

		const prompt = asTrimmed(request.prompt);
		if (prompt) {
			return prompt;
		}

		return undefined;
	}

	/**
	 * Extracts assistant content from a request, separating displayable tool invocation
	 * labels (e.g. "Read file foo.ts") from the main markdown text.
	 */
	private extractRequestAssistantContent(request: Record<string, unknown>): { text: string | undefined; toolLines: string[] } {
		const responseCandidates = [
			request.response,
			request.responseMessage,
			request.result,
			request.responses,
			request.rounds,
		];

		for (const candidate of responseCandidates) {
			const result = this.extractAssistantContentParts(candidate);
			if (result.text || result.toolLines.length > 0) {
				return result;
			}

			if (this.isRecord(candidate)) {
				const nestedCandidates = [
					candidate.message,
					candidate.value,
					candidate.response,
					candidate.responses,
					candidate.rounds,
				];
				for (const nestedCandidate of nestedCandidates) {
					const nested = this.extractAssistantContentParts(nestedCandidate);
					if (nested.text || nested.toolLines.length > 0) {
						return nested;
					}
				}
			}
		}

		return { text: undefined, toolLines: [] };
	}

	/**
	 * Processes an array of response parts (or a single part), returning the main text
	 * and tool invocation labels separately.
	 */
	private extractAssistantContentParts(value: unknown): { text: string | undefined; toolLines: string[] } {
		if (!Array.isArray(value)) {
			const text = this.extractTextContent(value);
			return { text, toolLines: [] };
		}

		const textParts: string[] = [];
		const toolLines: string[] = [];

		for (const item of value) {
			if (!this.isRecord(item)) {
				continue;
			}

			const normalizedKind = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
			if (normalizedKind === 'toolinvocationserialized') {
				// Extract completed past-tense message (e.g. "Read file foo.ts").
				if (item.isComplete !== false) {
					const msgObj = (this.isRecord(item.pastTenseMessage) ? item.pastTenseMessage : undefined)
						?? (this.isRecord(item.invocationMessage) ? item.invocationMessage : undefined);
					if (msgObj && typeof msgObj.value === 'string') {
						const label = this.stripMarkdownLinks(msgObj.value.trim());
						if (label.length > 0) {
							toolLines.push(label);
						}
					}
				}
				continue;
			}

			// All other non-display parts (thinking, progress, etc.) are skipped.
			if (this.isNonDisplayResponsePart(item)) {
				continue;
			}

			// NOKIND items: {value: string, supportThemeIcons, ...} — the actual markdown text.
			if ('value' in item && typeof item.value === 'string') {
				const text = item.value.trim();
				if (text.length > 0) {
					textParts.push(text);
				}
				continue;
			}

			// Fallback: try generic text extraction.
			const text = this.extractTextContent(item);
			if (text) {
				textParts.push(text);
			}
		}

		const joined = textParts.join('').trim();
		return {
			text: joined.length > 0 ? joined : undefined,
			toolLines,
		};
	}

	/**
	 * Strips markdown link syntax, keeping only the label text.
	 * e.g. "Read [foo.ts](file:///path/foo.ts)" → "Read foo.ts"
	 */
	private stripMarkdownLinks(value: string): string {
		return value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
	}

	private extractRequestTimestamp(request: Record<string, unknown>): number {
		const candidates = [
			request.timestamp,
			request.startTime,
			request.requestTimestamp,
			request.time,
		];

		for (const candidate of candidates) {
			if (typeof candidate !== 'string' && typeof candidate !== 'number') {
				continue;
			}

			const parsedTimestamp = new Date(candidate).getTime();
			if (Number.isFinite(parsedTimestamp)) {
				return parsedTimestamp;
			}
		}

		return Date.now();
	}

	private extractModelIdentifier(value: unknown): string | undefined {
		if (typeof value === 'string' && value.trim().length > 0) {
			return value;
		}

		if (!this.isRecord(value)) {
			return undefined;
		}

		if (typeof value.identifier === 'string' && value.identifier.trim().length > 0) {
			return value.identifier;
		}

		if (typeof value.id === 'string' && typeof value.vendor === 'string') {
			return `${value.vendor}/${value.id}`;
		}

		const metadata = this.isRecord(value.metadata) ? value.metadata : undefined;
		if (metadata) {
			if (typeof metadata.identifier === 'string' && metadata.identifier.trim().length > 0) {
				return metadata.identifier;
			}

			if (typeof metadata.id === 'string' && typeof metadata.vendor === 'string') {
				return `${metadata.vendor}/${metadata.id}`;
			}
		}

		return undefined;
	}

	private providerFromModelIdentifier(modelIdentifier: string | undefined, fallback: BridgeConversationProvider): BridgeConversationProvider {
		if (!modelIdentifier) {
			return fallback;
		}

		const normalized = modelIdentifier.toLowerCase();
		if (normalized.includes('codex')) {
			return 'codex';
		}

		if (normalized.includes('claude')) {
			return 'claude';
		}

		if (normalized.includes('copilot-cli') || normalized.includes('copilot_cli') || normalized.includes('copilotcli')) {
			return 'copilot-cli';
		}

		if (normalized.includes('cloud')) {
			return 'cloud';
		}

		return fallback;
	}

	private extractTranscriptRole(entry: Record<string, unknown>, type: string | undefined): 'user' | 'assistant' | undefined {
		if (type === 'user.message' || type === 'user') {
			return 'user';
		}
		if (type === 'assistant.message' || type === 'assistant') {
			return 'assistant';
		}

		const message = this.isRecord(entry.message) ? entry.message : undefined;
		const role = message?.role;
		if (role === 'user' || role === 'assistant') {
			return role;
		}

		return undefined;
	}

	private extractTranscriptContent(entry: Record<string, unknown>, role: 'user' | 'assistant' | undefined): string | undefined {
		const data = this.isRecord(entry.data) ? entry.data : undefined;
		const dataContent = this.extractTextContent(data?.content);
		if (dataContent) {
			return this.sanitizeTranscriptContent(dataContent);
		}

		if (this.isRecord(entry.message)) {
			const message = entry.message;
			if (role === 'user' && this.isToolResultOnlyMessage(message.content)) {
				return undefined;
			}

			const messageContent = this.extractTextContent(message.content);
			if (messageContent) {
				return this.sanitizeTranscriptContent(messageContent);
			}
		}

		const topLevelContent = this.extractTextContent(entry.content);
		if (topLevelContent) {
			return this.sanitizeTranscriptContent(topLevelContent);
		}

		return undefined;
	}

	private isToolResultOnlyMessage(content: unknown): boolean {
		if (!Array.isArray(content) || content.length === 0) {
			return false;
		}

		return content.every(item => this.isRecord(item) && item.type === 'tool_result');
	}

	private extractTextContent(value: unknown): string | undefined {
		if (typeof value === 'string') {
			const text = value.trim();
			return text.length > 0 ? text : undefined;
		}

		if (Array.isArray(value)) {
			const parts: string[] = [];
			for (const item of value) {
				const text = this.extractTextContent(item);
				if (text) {
					parts.push(text);
				}
			}

			const joined = parts.join('\n').trim();
			return joined.length > 0 ? joined : undefined;
		}

		if (this.isRecord(value)) {
			const normalizedKind = typeof value.kind === 'string' ? value.kind.toLowerCase() : '';

			if (normalizedKind === 'toolinvocationserialized') {
				// Tool invocations are handled separately via extractAssistantContentParts.
				return undefined;
			}

			if (this.isNonDisplayResponsePart(value)) {
				return undefined;
			}

			if (typeof value.text === 'string') {
				const text = value.text.trim();
				if (text.length > 0) {
					return text;
				}
			}

			if (value.type === 'thinking') {
				return undefined;
			}

			if (typeof value.content === 'string') {
				const text = value.content.trim();
				if (text.length > 0) {
					return text;
				}
			} else if (this.isRecord(value.content) || Array.isArray(value.content)) {
				const nestedContent = this.extractTextContent(value.content);
				if (nestedContent) {
					return nestedContent;
				}
			}

			if ('value' in value) {
				const nestedValue = this.extractTextContent(value.value);
				if (nestedValue) {
					return nestedValue;
				}
			}

			if ('message' in value) {
				const nestedMessage = this.extractTextContent(value.message);
				if (nestedMessage) {
					return nestedMessage;
				}
			}

			if (Array.isArray(value.responses)) {
				const nestedResponses = this.extractTextContent(value.responses);
				if (nestedResponses) {
					return nestedResponses;
				}
			}

			if (Array.isArray(value.rounds)) {
				const nestedRounds = this.extractTextContent(value.rounds);
				if (nestedRounds) {
					return nestedRounds;
				}
			}
		}

		return undefined;
	}

	private isNonDisplayResponsePart(value: Record<string, unknown>): boolean {
		const normalizedType = typeof value.type === 'string' ? value.type.toLowerCase() : '';
		if (normalizedType.length > 0) {
			if (normalizedType === 'thinking' || normalizedType === 'tool_result' || normalizedType === 'tool_use' || normalizedType === 'tool_invocation') {
				return true;
			}
		}

		const normalizedKind = typeof value.kind === 'string' ? value.kind.toLowerCase() : '';
		if (normalizedKind.length > 0) {
			if (normalizedKind === 'thinking'
				|| normalizedKind === 'progress'
				|| normalizedKind === 'warning'
				|| normalizedKind === 'reference'
				|| normalizedKind === 'inlinereference'
				|| normalizedKind === 'codecitation'
				|| normalizedKind === 'tool'
				|| normalizedKind === 'toolinvocation'
				|| normalizedKind === 'toolinvocationserialized'
				|| normalizedKind === 'progresstaskserialized'
				|| normalizedKind === 'elicitationserialized'
				|| normalizedKind === 'mcpserversstarting'
				|| normalizedKind === 'undostop'
				|| normalizedKind === 'confirmation'
				|| normalizedKind === 'questioncarousel'
				|| normalizedKind === 'commandbutton'
				|| normalizedKind === 'anchor'
				|| normalizedKind === 'filetree'
				|| normalizedKind === 'codeblockuri'
				|| normalizedKind === 'textedit'
				|| normalizedKind === 'textedigroup'
				|| normalizedKind === 'texteditgroup'
				|| normalizedKind === 'notebookedit'
				|| normalizedKind === 'workspaceedit'
				|| normalizedKind === 'move'
				|| normalizedKind === 'extensions'
				|| normalizedKind === 'pullrequest'
				|| normalizedKind === 'externaledit'
				|| normalizedKind === 'multidiff') {
				return true;
			}
		}

		if (typeof value.toolCallId === 'string' || typeof value.toolName === 'string') {
			return true;
		}

		if (Array.isArray(value.questions)
			|| Array.isArray(value.buttons)
			|| Array.isArray(value.edits)
			|| Array.isArray(value.uris)) {
			return true;
		}

		return false;
	}

	private sanitizeTranscriptContent(value: string): string | undefined {
		const sanitized = value
			.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
			.trim();

		return sanitized.length > 0 ? sanitized : undefined;
	}

	private truncateConversationTitle(value: string): string {
		if (value.length <= TITLE_MAX_LENGTH) {
			return value;
		}

		return `${value.slice(0, TITLE_MAX_LENGTH - 3)}...`;
	}

	private async getUiStateMessage(): Promise<BridgeUiStateMessage> {
		if (!UI_MODES.some(mode => mode.id === this.selectedModeId)) {
			this.selectedModeId = DEFAULT_MODE_ID;
		}

		const modelOptions = await this.getModelOptions();
		if (!this.selectedModelId || !this.modelOptionsById.has(this.selectedModelId)) {
			this.selectedModelId = modelOptions[0]?.id;
		}
		const workspaceLabel = await this.getWorkspaceLabel();

		return {
			type: 'ui:state',
			modes: UI_MODES,
			selectedModeId: this.selectedModeId,
			models: modelOptions,
			selectedModelId: this.selectedModelId,
			workspaceLabel,
		};
	}

	private async getWorkspaceLabel(): Promise<string | undefined> {
		const workspaceFolder = vscode.workspace?.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return undefined;
		}

		const repoName = workspaceFolder.name.trim();
		const branchName = await this.getWorkspaceBranchName(workspaceFolder.uri);
		if (!repoName) {
			return branchName;
		}

		return branchName ? `${repoName} (${branchName})` : repoName;
	}

	private async getWorkspaceBranchName(workspaceUri: vscode.Uri): Promise<string | undefined> {
		const gitExtension = vscode.extensions.getExtension<GitExtensionLike>('vscode.git');
		if (!gitExtension) {
			return undefined;
		}

		try {
			const extension = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
			if (!extension.enabled) {
				return undefined;
			}

			const gitApi = extension.getAPI(1);
			const repository = this.resolveWorkspaceRepository(gitApi, workspaceUri);
			const branchName = repository?.state.HEAD?.name?.trim();
			return branchName && branchName.length > 0 ? branchName : undefined;
		} catch (error) {
			this.logService.trace(`[ConversationBridge] Failed to resolve workspace branch label: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	private resolveWorkspaceRepository(gitApi: GitApiLike, workspaceUri: vscode.Uri): GitRepositoryLike | undefined {
		const direct = gitApi.getRepository(workspaceUri);
		if (direct) {
			return direct;
		}

		const exact = gitApi.repositories.find(repository => repository.rootUri.toString() === workspaceUri.toString());
		if (exact) {
			return exact;
		}

		return gitApi.repositories.find(repository => this.isParentUriPath(repository.rootUri.path, workspaceUri.path));
	}

	private isParentUriPath(parentPath: string, childPath: string): boolean {
		const normalizedParent = parentPath.endsWith('/') ? parentPath : `${parentPath}/`;
		const normalizedChild = childPath.endsWith('/') ? childPath : `${childPath}/`;
		return normalizedChild.startsWith(normalizedParent);
	}

	private async getModelOptions(): Promise<readonly BridgeModelOption[]> {
		try {
			const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
			this.modelOptionsById.clear();

			for (const model of models) {
				if (this.modelOptionsById.has(model.id)) {
					continue;
				}

				this.modelOptionsById.set(model.id, {
					id: model.id,
					label: model.name || model.id,
					vendor: model.vendor || 'copilot',
					family: model.family,
				});
			}

			return Array.from(this.modelOptionsById.values())
				.sort((a, b) => a.label.localeCompare(b.label));
		} catch (error) {
			this.logService.warn(`[ConversationBridge] Failed to read chat models for sidecar UI: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	private async changeModel(modelId: string): Promise<void> {
		if (this.modelOptionsById.size === 0) {
			await this.getModelOptions();
		}

		const model = this.modelOptionsById.get(modelId);
		if (!model) {
			return;
		}

		try {
			await vscode.commands.executeCommand('workbench.action.chat.changeModel', {
				vendor: model.vendor,
				id: model.id,
				family: model.family,
			});
			this.selectedModelId = model.id;
			this.bridgeServer.broadcast(await this.getUiStateMessage());
		} catch (error) {
			this.logService.warn(`[ConversationBridge] Failed to change chat model from sidecar: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async changeMode(modeId: string): Promise<void> {
		const normalizedModeId = this.normalizeModeId(modeId);
		if (normalizedModeId === this.selectedModeId) {
			return;
		}

		const commandModeId = this.modeIdForCommand(normalizedModeId);

		try {
			try {
				await vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode', { modeId: commandModeId });
			} catch {
				await vscode.commands.executeCommand('workbench.action.chat.toggleAgentMode');
			}
			this.selectedModeId = normalizedModeId;
			this.bridgeServer.broadcast(await this.getUiStateMessage());
		} catch (error) {
			this.logService.warn(`[ConversationBridge] Failed to change chat mode from sidecar: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private normalizeModeId(modeId: string): string {
		const normalized = modeId.trim().toLowerCase();
		if (normalized === 'ask') {
			return 'ask';
		}
		if (normalized === 'plan') {
			return 'plan';
		}

		return 'agent';
	}

	private modeIdForCommand(modeId: string): string {
		if (modeId === 'ask') {
			return 'Ask';
		}
		if (modeId === 'plan') {
			return 'Plan';
		}

		return 'Agent';
	}

	private async executeUiCommand(commandId: BridgeUiCommandId, args?: readonly unknown[]): Promise<void> {
		try {
			if (args && args.length > 0) {
				await vscode.commands.executeCommand(commandId, ...args);
			} else {
				await vscode.commands.executeCommand(commandId);
			}
		} catch (error) {
			this.logService.warn(`[ConversationBridge] Failed to execute sidecar UI command ${commandId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async submitPrompt(prompt: string, conversationId: string | undefined): Promise<void> {
		const trimmedPrompt = prompt.trim();
		if (!trimmedPrompt) {
			return;
		}

		try {
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: trimmedPrompt,
				isPartialQuery: false,
				sessionId: conversationId,
			});
			return;
		} catch (error) {
			this.logService.warn(`[ConversationBridge] Failed to submit prompt with direct chat.open submission: ${error instanceof Error ? error.message : String(error)}`);
		}

		await vscode.commands.executeCommand('workbench.action.chat.open', {
			query: trimmedPrompt,
			sessionId: conversationId,
		});

		try {
			await vscode.commands.executeCommand('workbench.action.chat.submit');
		} catch {
			// Some VS Code versions may not expose workbench.action.chat.submit.
		}
	}
}
