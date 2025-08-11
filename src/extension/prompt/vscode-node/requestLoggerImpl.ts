/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HTMLTracer, IChatEndpointInfo, RenderPromptResult } from '@vscode/prompt-tsx';
import { CancellationToken, DocumentLink, DocumentLinkProvider, FileType, LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult2, languages, Range, TextDocument, Uri, workspace } from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService, XTabProviderId } from '../../../platform/configuration/common/configurationService';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { messageToMarkdown } from '../../../platform/log/common/messageStringify';
import { IResponseDelta } from '../../../platform/networking/common/fetch';
import { AbstractRequestLogger, ChatRequestScheme, ILoggedToolCall, LoggedInfo, LoggedInfoKind, LoggedRequest, LoggedRequestKind } from '../../../platform/requestLogger/node/requestLogger';
import { ThinkingData } from '../../../platform/thinking/common/thinking';
import { createFencedCodeBlock } from '../../../util/common/markdown';
import { assertNever } from '../../../util/vs/base/common/assert';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { safeStringify } from '../../../util/vs/base/common/objects';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { ChatRequest } from '../../../vscodeTypes';
import { renderToolResultToStringNoBudget } from './requestLoggerToolResult';

// Persistence record types written to disk
type PersistedLogEntry =
	| { kind: 'request'; id: string; time: number; data: any & { prompt?: string } }
	| { kind: 'tool'; id: string; time: number; data: { name: string; args: unknown; response: LanguageModelToolResult2; thinking?: ThinkingData; requestId?: string } }
	| { kind: 'element'; id: string; time: number; data: { name: string; tokens: number; maxTokens: number; requestId?: string } };

export class RequestLogger extends AbstractRequestLogger {

	private _didRegisterLinkProvider = false;
	private readonly _entries: LoggedInfo[] = [];
	private readonly _requestIdByChatRequest = new WeakMap<ChatRequest, string>();
	private readonly _knownIds = new Set<string>();
	private readonly _persistDir: Uri;
	private readonly _retentionMs = 7 * 24 * 60 * 60 * 1000; // 7 days
	private _hasLoadedPersisted = false;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IVSCodeExtensionContext private readonly _vscodeExtensionContext: IVSCodeExtensionContext,
	) {
		super();

		this._persistDir = Uri.joinPath(this._vscodeExtensionContext.globalStorageUri, 'chat-logs');

		this._register(workspace.registerTextDocumentContentProvider(ChatRequestScheme.chatRequestScheme, {
			onDidChange: Event.map(this.onDidChangeRequests, () => Uri.parse(ChatRequestScheme.buildUri({ kind: 'latest' }))),
			provideTextDocumentContent: (uri) => {
				const uriData = ChatRequestScheme.parseUri(uri.toString());
				if (!uriData) { return `Invalid URI: ${uri}`; }

				const entry = uriData.kind === 'latest' ? this._entries.at(-1) : this._entries.find(e => e.id === uriData.id);
				if (!entry) { return `Request not found`; }

				switch (entry.kind) {
					case LoggedInfoKind.Element:
						return 'Not available';
					case LoggedInfoKind.ToolCall:
						return this._renderToolCallToMarkdown(entry);
					case LoggedInfoKind.Request:
						return this._renderRequestToMarkdown(entry.id, entry.entry);
					default:
						assertNever(entry);
				}
			}
		}));

		// Initialize persistence (create dir, cleanup old, load recent)
		void this._initPersistence();
		// And schedule a best-effort deferred init to avoid early-race issues
		this._scheduleDeferredInit();

		// Also react to config changes to avoid startup race: load when toggled on
		this._register(this._configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.PersistDebugLogs.fullyQualifiedId) && this._isPersistenceEnabled()) {
				void this._initPersistence();
			}
		}));
	}

	public getRequests(): LoggedInfo[] {
		return [...this._entries];
	}

	private _onDidChangeRequests = new Emitter<void>();
	public readonly onDidChangeRequests = this._onDidChangeRequests.event;

	public override logToolCall(id: string, name: string, args: unknown, response: LanguageModelToolResult2, thinking?: ThinkingData): void {
		this._addEntry({
			kind: LoggedInfoKind.ToolCall,
			id,
			chatRequest: this.currentRequest,
			name,
			args,
			response,
			time: Date.now(),
			thinking
		});
	}

	public override addPromptTrace(elementName: string, endpoint: IChatEndpointInfo, result: RenderPromptResult, trace: HTMLTracer): void {
		const id = generateUuid().substring(0, 8);
		this._addEntry({ kind: LoggedInfoKind.Element, id, name: elementName, tokens: result.tokenCount, maxTokens: endpoint.modelMaxPromptTokens, trace, chatRequest: this.currentRequest })
			.catch(e => this._logService.error(e));
	}

	public addEntry(entry: LoggedRequest): void {
		const id = generateUuid().substring(0, 8);
		if (!this._shouldLog(entry)) {
			return;
		}
		this._addEntry({ kind: LoggedInfoKind.Request, id, entry, chatRequest: this.currentRequest })
			.then(ok => {
				if (ok) {
					this._ensureLinkProvider();
					const extraData =
						entry.type === LoggedRequestKind.MarkdownContentRequest ? 'markdown' :
							`${entry.type === LoggedRequestKind.ChatMLCancelation ? 'cancelled' : entry.result.type} | ${entry.chatEndpoint.model} | ${entry.endTime.getTime() - entry.startTime.getTime()}ms | [${entry.debugName}]`;

					this._logService.info(`${ChatRequestScheme.buildUri({ kind: 'request', id: id })} | ${extraData}`);
				}
			})
			.catch(e => this._logService.error(e));
	}

	private _shouldLog(entry: LoggedRequest) {
		// don't log cancelled requests by XTabProviderId (because it triggers and cancels lots of requests)
		if (entry.debugName === XTabProviderId &&
			!this._configService.getConfig(ConfigKey.Internal.InlineEditsLogCancelledRequests) &&
			entry.type === LoggedRequestKind.ChatMLCancelation
		) {
			return false;
		}

		return true;
	}

	private _isFirst = true;

	private async _addEntry(entry: LoggedInfo): Promise<boolean> {
		const key = this._entryKey(entry);
		if (this._knownIds.has(key)) {
			return false; // duplicate; skip
		}
		this._knownIds.add(key);
		if (this._isFirst) {
			this._isFirst = false;
			this._logService.info(`Latest entry: ${ChatRequestScheme.buildUri({ kind: 'latest' })}`);
		}

		this._entries.push(entry);
		// keep at most 100 entries
		if (this._entries.length > 100) {
			this._entries.shift();
		}

		// Track mapping from ChatRequest -> last request id for grouping
		if (entry.kind === LoggedInfoKind.Request && entry.chatRequest) {
			this._requestIdByChatRequest.set(entry.chatRequest, entry.id);
		}
		this._onDidChangeRequests.fire();

		// Persist to disk if enabled and entry type is supported
		if (this._isPersistenceEnabled() && (entry.kind === LoggedInfoKind.Request || entry.kind === LoggedInfoKind.ToolCall)) {
			try {
				await this._ensurePersistDir();
				const raw = this._serializeEntry(entry);
				const safe = this._toSerializableRecord(raw ?? { kind: 'request', id: entry.id, time: Date.now(), data: {} });
				const timestamp = Date.now();
				const fileName = `${timestamp}_${entry.kind}_${entry.id}.json`;
				const fileUri = Uri.joinPath(this._persistDir, fileName);
				// Use safeStringify to break any unexpected cycles
				const payload = safeStringify(safe);
				await workspace.fs.writeFile(fileUri, Buffer.from(payload, 'utf8'));
				this._logService.info(`[requestLogger] persisted ${entry.kind === LoggedInfoKind.Request ? 'request' : 'tool'} -> ${fileUri.fsPath}`);
				// ensure listeners refresh promptly
				this._onDidChangeRequests.fire();
				// Cleanup in background
				void this._cleanupOldFiles();
			} catch (e) {
				this._logService.warn(`[requestLogger] Failed to persist entry: ${e}`);
			}
		}
		return true;
	}

	private _entryKey(entry: LoggedInfo): string {
		if (entry.kind === LoggedInfoKind.ToolCall) {
			return `tool:${entry.id}:${entry.time}`;
		}
		return `${entry.kind}:${entry.id}`;
	}

	private _toSerializableRecord(record: PersistedLogEntry): PersistedLogEntry {
		if (record.kind === 'tool') {
			// Strip complex content to simple text values
			const content = Array.isArray((record as any).data?.response?.content)
				? (record as any).data.response.content.map((p: any) => {
					if (p && typeof p === 'object' && 'value' in p && typeof p.value === 'string') {
						return { value: p.value };
					}
					return { value: String(p) };
				})
				: [];

			// Sanitize args and thinking which may carry circular graphs
			const rawArgs = (record as any).data?.args;
			const args = typeof rawArgs === 'string' ? rawArgs : safeStringify(rawArgs);
			const rawThinking = (record as any).data?.thinking;
			const thinking = rawThinking && typeof rawThinking === 'object' ? safeStringify(rawThinking) : rawThinking;
			return {
				kind: 'tool',
				id: (record as any).id,
				time: (record as any).time,
				data: {
					name: (record as any).data?.name,
					args,
					response: { content },
					thinking,
					requestId: (record as any).data?.requestId
				}
			} as any;
		} else if (record.kind === 'element') {
			// Persist element metadata and link to its request if known
			return {
				kind: 'element',
				id: (record as any).id,
				time: (record as any).time,
				data: {
					name: (record as any).data?.name,
					tokens: (record as any).data?.tokens,
					maxTokens: (record as any).data?.maxTokens,
					requestId: (record as any).data?.requestId
				}
			} as any;
		}

		// For requests, create a compact, cycle-free projection
		const data = (record as any).data ?? {};
		const chatEndpoint = data.chatEndpoint ? {
			model: data.chatEndpoint.model,
			modelMaxPromptTokens: data.chatEndpoint.modelMaxPromptTokens,
			urlOrRequestMetadata: typeof data.chatEndpoint.urlOrRequestMetadata === 'string'
				? data.chatEndpoint.urlOrRequestMetadata
				: data.chatEndpoint.urlOrRequestMetadata?.type
		} : undefined;

		const po = data.chatParams?.postOptions;
		const safePostOptions = po ? {
			max_tokens: po.max_tokens,
			temperature: po.temperature,
			top_p: po.top_p
		} : undefined;

		let safeResult: any = undefined;
		try {
			if (data?.result && typeof data.result === 'object') {
				const type = (data.result as any).type;
				const requestId = (data.result as any).requestId;
				const serverRequestId = (data.result as any).serverRequestId;
				if ('value' in data.result) {
					safeResult = { type, value: (data.result as any).value, requestId, serverRequestId };
				} else if ('message' in data.result) {
					safeResult = { type, message: String((data.result as any).message), requestId, serverRequestId };
				} else {
					safeResult = { type, requestId, serverRequestId };
				}
			}
		} catch {
			// ignore, keep undefined
		}

		const safe: any = {
			type: data?.type,
			debugName: data?.debugName,
			chatEndpoint,
			chatParams: data?.chatParams && {
				model: data.chatParams.model,
				postOptions: safePostOptions,
				location: data.chatParams.location,
				intent: data.chatParams.intent,
				ourRequestId: data.chatParams.ourRequestId
			},
			startTime: data?.startTime,
			endTime: data?.endTime,
			timeToFirstToken: data?.timeToFirstToken,
			usage: data?.usage,
			result: safeResult,
			// Drop deltas entirely to avoid large cyclic structures
			deltas: undefined
		};

		// Preserve prompt if present so we can label conversations after reload
		const prompt: unknown = (record as any).data?.prompt;
		const dataOut: any = { ...safe };
		if (typeof prompt === 'string' && prompt.length > 0) {
			dataOut.prompt = prompt;
		}

		return { kind: 'request', id: (record as any).id, time: (record as any).time, data: dataOut } as any;
	}

	private _isPersistenceEnabled(): boolean {
		try {
			return !!this._configService.getConfig(ConfigKey.PersistDebugLogs);
		} catch {
			return false;
		}
	}

	private async _initPersistence(): Promise<void> {
		if (!this._isPersistenceEnabled()) {
			return;
		}
		try {
			this._logService.info(`[requestLogger] init persistence at ${this._persistDir.fsPath}`);
			await this._ensurePersistDir();
			await this._cleanupOldFiles();
			if (!this._hasLoadedPersisted) {
				await this._loadPersistedEntries();
				this._hasLoadedPersisted = true;
			}
		} catch (e) {
			this._logService.warn(`[requestLogger] Failed initializing persistence: ${e}`);
		}
	}

	// As a fallback, attempt a best-effort load shortly after activation as VS Code settles.
	private _scheduleDeferredInit(): void {
		setTimeout(() => {
			if (this._isPersistenceEnabled()) {
				void this._initPersistence();
			}
		}, 2500);
	}

	private async _ensurePersistDir(): Promise<void> {
		// Create directory if it doesn't exist
		try {
			await workspace.fs.createDirectory(this._persistDir);
		} catch {
			// ignore
		}
	}

	private _serializeEntry(entry: LoggedInfo): PersistedLogEntry | undefined {
		if (entry.kind === LoggedInfoKind.Request) {
			// Convert Dates to ISO strings for serialization where present
			const req: any = entry.entry as any;
			const data: any = { ...req };
			if ('startTime' in req && req.startTime instanceof Date) {
				data.startTime = req.startTime.toJSON();
			}
			if ('endTime' in req && req.endTime instanceof Date) {
				data.endTime = req.endTime.toJSON();
			}
			// Include prompt text when available for grouping on reload
			const prompt = entry.chatRequest && typeof (entry.chatRequest as any).prompt === 'string' ? (entry.chatRequest as any).prompt : undefined;
			return { kind: 'request', id: entry.id, time: Date.now(), data: { ...data, prompt } };
		} else if (entry.kind === LoggedInfoKind.ToolCall) {
			const requestId = entry.chatRequest ? this._requestIdByChatRequest.get(entry.chatRequest) : undefined;
			return { kind: 'tool', id: entry.id, time: entry.time, data: { name: entry.name, args: entry.args, response: entry.response, thinking: entry.thinking, requestId } };
		} else if (entry.kind === LoggedInfoKind.Element) {
			const requestId = entry.chatRequest ? this._requestIdByChatRequest.get(entry.chatRequest) : undefined;
			return { kind: 'element', id: entry.id, time: Date.now(), data: { name: entry.name, tokens: entry.tokens, maxTokens: entry.maxTokens, requestId } } as any;
		}
		// Skip Element entries (non-serializable HTML tracer)
		return undefined;
	}

	private _reviveLoggedRequest(obj: any): LoggedRequest | undefined {
		// Revive Dates
		if (!obj || typeof obj !== 'object' || !obj.type) {
			return undefined;
		}
		if ('startTime' in obj) {
			obj.startTime = new Date(obj.startTime);
		}
		if ('endTime' in obj) {
			obj.endTime = new Date(obj.endTime);
		}
		return obj as LoggedRequest;
	}

	private async _loadPersistedEntries(): Promise<void> {
		try {
			const dirItems = await workspace.fs.readDirectory(this._persistDir);
			const files = dirItems
				.filter(([, type]) => type === FileType.File)
				.map(([name]) => name)
				.filter(name => name.endsWith('.json'));

			this._logService.info(`[requestLogger] found ${files.length} persisted files`);

			// Sort by timestamp parsed from filename descending
			const sorted = files.sort((a, b) => {
				const ta = Number(a.split('_')[0]);
				const tb = Number(b.split('_')[0]);
				return tb - ta;
			});

			const now = Date.now();
			const entriesToLoad: LoggedInfo[] = [];
			// First pass: create synthetic ChatRequest handles for requests
			const syntheticRequests = new Map<string, any>();
			for (const name of sorted) {
				const timestamp = Number(name.split('_')[0]);
				if (isNaN(timestamp) || (now - timestamp) > this._retentionMs) {
					continue; // older than retention or invalid
				}
				const fileUri = Uri.joinPath(this._persistDir, name);
				try {
					const buf = await workspace.fs.readFile(fileUri);
					const rec = JSON.parse(Buffer.from(buf).toString('utf8')) as PersistedLogEntry;
					if (rec.kind === 'request') {
						const revived = this._reviveLoggedRequest(rec.data);
						const prompt = (rec.data as any).prompt as (string | undefined);
						const fakeChatRequest = { prompt } as any; // minimal shape for grouping/label
						syntheticRequests.set(rec.id, fakeChatRequest);
						if (revived) {
							entriesToLoad.push({ kind: LoggedInfoKind.Request, id: rec.id, entry: revived, chatRequest: fakeChatRequest });
						}
					} else if (rec.kind === 'tool') {
						const chatRequest = rec.data.requestId ? syntheticRequests.get(rec.data.requestId) : undefined;
						entriesToLoad.push({ kind: LoggedInfoKind.ToolCall, id: rec.id, name: rec.data.name, args: rec.data.args, response: rec.data.response, time: rec.time, thinking: rec.data.thinking, chatRequest });
					} else if (rec.kind === 'element') {
						const chatRequest = rec.data.requestId ? syntheticRequests.get(rec.data.requestId) : undefined;
						entriesToLoad.push({ kind: LoggedInfoKind.Element, id: rec.id, name: rec.data.name, tokens: rec.data.tokens, maxTokens: rec.data.maxTokens, trace: new HTMLTracer(), chatRequest });
					}
				} catch (e) {
					this._logService.warn(`[requestLogger] Failed to load persisted log ${name}: ${e}`);
				}
				if (entriesToLoad.length >= 100) {
					break; // respect in-memory cap
				}
			}

			// Load in reverse (oldest first) so UI order is consistent
			for (const e of entriesToLoad.reverse()) {
				const key = this._entryKey(e);
				if (this._knownIds.has(key)) { continue; }
				this._knownIds.add(key);
				this._entries.push(e);
			}
			if (entriesToLoad.length) {
				this._logService.info(`[requestLogger] loaded ${entriesToLoad.length} persisted entries`);
				this._onDidChangeRequests.fire();
			}
		} catch (e) {
			// ignore if directory missing
		}
	}

	private async _cleanupOldFiles(): Promise<void> {
		const now = Date.now();
		try {
			const dirItems = await workspace.fs.readDirectory(this._persistDir);
			const deletions: Promise<void>[] = [];
			for (const [name, type] of dirItems) {
				if (type !== FileType.File || !name.endsWith('.json')) { continue; }
				const ts = Number(name.split('_')[0]);
				if (!isNaN(ts) && (now - ts) > this._retentionMs) {
					const fileUri = Uri.joinPath(this._persistDir, name);
					deletions.push(Promise.resolve(workspace.fs.delete(fileUri)).then(() => { }, () => { }));
				}
			}
			await Promise.allSettled(deletions);
		} catch {
			// ignore
		}
	}

	public override async clearLogs(): Promise<void> {
		// Clear in-memory
		this._entries.length = 0;
		this._knownIds.clear();
		this._onDidChangeRequests.fire();

		// Clear persisted files
		try {
			await this._ensurePersistDir();
			const dirItems = await workspace.fs.readDirectory(this._persistDir);
			const deletions: Promise<void>[] = [];
			for (const [name, type] of dirItems) {
				if (type === FileType.File && name.endsWith('.json')) {
					const fileUri = Uri.joinPath(this._persistDir, name);
					deletions.push(Promise.resolve(workspace.fs.delete(fileUri)).then(() => { }, () => { }));
				}
			}
			await Promise.allSettled(deletions);
			this._logService.info('[requestLogger] cleared persisted logs');
		} catch (e) {
			this._logService.warn(`[requestLogger] failed to clear persisted logs: ${e}`);
		}
	}

	private _ensureLinkProvider(): void {
		if (this._didRegisterLinkProvider) {
			return;
		}
		this._didRegisterLinkProvider = true;

		const docLinkProvider = new (class implements DocumentLinkProvider {
			provideDocumentLinks(
				td: TextDocument,
				ct: CancellationToken
			): DocumentLink[] {
				return ChatRequestScheme.findAllUris(td.getText()).map(u => new DocumentLink(
					new Range(td.positionAt(u.range.start), td.positionAt(u.range.endExclusive)),
					Uri.parse(u.uri)
				));
			}
		})();

		this._register(languages.registerDocumentLinkProvider(
			{ scheme: 'output' },
			docLinkProvider
		));
	}

	private _renderMarkdownStyles(): string {
		return `
<style>
[id^="system"], [id^="user"], [id^="assistant"] {
		margin: 4px 0 4px 0;
}

.markdown-body > pre {
		padding: 4px 16px;
}
</style>
`;
	}

	private async _renderToolCallToMarkdown(entry: ILoggedToolCall) {
		const result: string[] = [];
		result.push(`# Tool Call - ${entry.id}`);
		result.push(``);

		result.push(`## Request`);
		result.push(`~~~`);

		let args: string;
		if (typeof entry.args === 'string') {
			try {
				args = JSON.stringify(JSON.parse(entry.args), undefined, 2)
					.replace(/\\n/g, '\n')
					.replace(/(?!=\\)\\t/g, '\t');
			} catch {
				args = entry.args;
			}
		} else {
			args = JSON.stringify(entry.args, undefined, 2);
		}

		result.push(`id   : ${entry.id}`);
		result.push(`tool : ${entry.name}`);
		result.push(`args : ${args}`);
		result.push(`~~~`);

		result.push(`## Response`);

		for (const content of entry.response.content as (LanguageModelTextPart | LanguageModelPromptTsxPart)[]) {
			result.push(`~~~`);
			if (content && typeof content.value === 'string') {
				result.push(content.value);
			} else if (content) {
				result.push(await renderToolResultToStringNoBudget(content));
			}
			result.push(`~~~`);
		}

		if (entry.thinking) {
			result.push(`## Thinking`);
			if (entry.thinking.id) {
				result.push(`thinkingId: ${entry.thinking.id}`);
			}
			if (entry.thinking.text) {
				result.push(`~~~`);
				result.push(entry.thinking.text);
				result.push(`~~~`);
			}
		}

		return result.join('\n');
	}

	private _renderRequestToMarkdown(id: string, entry: LoggedRequest): string {
		if (entry.type === LoggedRequestKind.MarkdownContentRequest) {
			return entry.markdownContent;
		}

		const result: string[] = [];
		result.push(`> 🚨 Note: This log may contain personal information such as the contents of your files or terminal output. Please review the contents carefully before sharing.`);
		result.push(`# ${entry.debugName} - ${id}`);
		result.push(``);

		result.push(`## Metadata`);
		result.push(`~~~`);

		let prediction: string | undefined;
		let tools;
		const postOptions = entry.chatParams.postOptions && { ...entry.chatParams.postOptions };
		if (postOptions && 'prediction' in postOptions && typeof postOptions.prediction?.content === 'string') {
			prediction = postOptions.prediction.content;
			postOptions.prediction = undefined;
		}
		if (postOptions && 'tools' in postOptions) {
			tools = postOptions.tools;
			postOptions.tools = undefined;
		}

		if (typeof entry.chatEndpoint.urlOrRequestMetadata === 'string') {
			result.push(`url              : ${entry.chatEndpoint.urlOrRequestMetadata}`);
		} else if (entry.chatEndpoint.urlOrRequestMetadata) {
			result.push(`requestType      : ${entry.chatEndpoint.urlOrRequestMetadata?.type}`);
		}
		result.push(`model            : ${entry.chatParams.model}`);
		result.push(`maxPromptTokens  : ${entry.chatEndpoint.modelMaxPromptTokens}`);
		result.push(`maxResponseTokens: ${entry.chatParams.postOptions?.max_tokens}`);
		result.push(`location         : ${entry.chatParams.location}`);
		result.push(`postOptions      : ${JSON.stringify(postOptions)}`);
		result.push(`intent           : ${entry.chatParams.intent}`);
		result.push(`startTime        : ${entry.startTime.toJSON()}`);
		result.push(`endTime          : ${entry.endTime.toJSON()}`);
		result.push(`duration         : ${entry.endTime.getTime() - entry.startTime.getTime()}ms`);
		result.push(`ourRequestId     : ${entry.chatParams.ourRequestId}`);
		if (entry.type === LoggedRequestKind.ChatMLSuccess) {
			result.push(`requestId        : ${entry.result.requestId}`);
			result.push(`serverRequestId  : ${entry.result.serverRequestId}`);
			result.push(`timeToFirstToken : ${entry.timeToFirstToken}ms`);
			result.push(`usage            : ${JSON.stringify(entry.usage)}`);
		} else if (entry.type === LoggedRequestKind.ChatMLFailure) {
			result.push(`requestId        : ${entry.result.requestId}`);
			result.push(`serverRequestId  : ${entry.result.serverRequestId}`);
		}
		if (tools) {
			result.push(`tools           : ${JSON.stringify(tools, undefined, 4)}`);
		}
		result.push(`~~~`);

		if ('messages' in entry.chatParams) {
			result.push(`## Request Messages`);
			for (const message of entry.chatParams.messages) {
				result.push(messageToMarkdown(message));
			}
			if (prediction) {
				result.push(`## Prediction`);
				result.push(createFencedCodeBlock('markdown', prediction, false));
			}
		}
		result.push(``);

		if (entry.type === LoggedRequestKind.ChatMLSuccess) {
			result.push(``);
			result.push(`## Response`);
			if (entry.deltas?.length) {
				result.push(this._renderDeltasToMarkdown('assistant', entry.deltas));
			} else {
				const messages = entry.result.value;
				let message: string = '';
				if (Array.isArray(messages)) {
					if (messages.length === 1) {
						message = messages[0];
					} else {
						message = `${messages.map(v => `<<${v}>>`).join(', ')}`;
					}
				}
				result.push(this._renderStringMessageToMarkdown('assistant', message));
			}
		} else if (entry.type === LoggedRequestKind.CompletionSuccess) {
			result.push(``);
			result.push(`## Response`);
			result.push(this._renderStringMessageToMarkdown('assistant', entry.result.value));
		} else if (entry.type === LoggedRequestKind.ChatMLFailure) {
			result.push(``);
			if (entry.result.type === ChatFetchResponseType.Length) {
				result.push(`## Response (truncated)`);
				result.push(this._renderStringMessageToMarkdown('assistant', entry.result.truncatedValue));
			} else {
				result.push(`## FAILED: ${entry.result.reason}`);
			}
		} else if (entry.type === LoggedRequestKind.ChatMLCancelation) {
			result.push(``);
			result.push(`## CANCELED`);
		} else if (entry.type === LoggedRequestKind.CompletionFailure) {
			result.push(``);
			const error = entry.result.type;
			result.push(`## FAILED: ${error instanceof Error ? error.stack : safeStringify(error)}`);
		}

		result.push(this._renderMarkdownStyles());

		return result.join('\n');
	}

	private _renderStringMessageToMarkdown(role: string, message: string): string {
		const capitalizedRole = role.charAt(0).toUpperCase() + role.slice(1);
		return `### ${capitalizedRole}\n${createFencedCodeBlock('markdown', message)}\n`;
	}

	private _renderDeltasToMarkdown(role: string, deltas: IResponseDelta[]): string {
		const capitalizedRole = role.charAt(0).toUpperCase() + role.slice(1);

		const message = deltas.map((d, i) => {
			let text: string = '';
			if (d.text) {
				text += d.text;
			}

			// Can include other parts as needed
			if (d.copilotToolCalls) {
				if (i > 0) {
					text += '\n';
				}

				text += d.copilotToolCalls.map(c => {
					let argsStr = c.arguments;
					try {
						const parsedArgs = JSON.parse(c.arguments);
						argsStr = JSON.stringify(parsedArgs, undefined, 2)
							.replace(/(?<!\\)\\n/g, '\n')
							.replace(/(?<!\\)\\t/g, '\t');
					} catch (e) { }
					return `🛠️ ${c.name} (${c.id}) ${argsStr}`;
				}).join('\n');
			}

			return text;
		}).join('');

		return `### ${capitalizedRole}\n~~~md\n${message}\n~~~\n`;
	}
}
