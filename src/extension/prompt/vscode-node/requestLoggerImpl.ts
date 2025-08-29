/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestMetadata, RequestType } from '@vscode/copilot-api';
import { HTMLTracer, IChatEndpointInfo, RenderPromptResult } from '@vscode/prompt-tsx';
import { CancellationToken, DocumentLink, DocumentLinkProvider, LanguageModelDataPart, LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult2, languages, Range, TextDocument, Uri, workspace } from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService, XTabProviderId } from '../../../platform/configuration/common/configurationService';
import { IModelAPIResponse } from '../../../platform/endpoint/common/endpointProvider';
import { getAllStatefulMarkersAndIndicies } from '../../../platform/endpoint/common/statefulMarkerContainer';
import { ILogService } from '../../../platform/log/common/logService';
import { messageToMarkdown } from '../../../platform/log/common/messageStringify';
import { IResponseDelta } from '../../../platform/networking/common/fetch';
import { AbstractRequestLogger, ChatRequestScheme, ILoggedElementInfo, ILoggedRequestInfo, ILoggedToolCall, LoggedInfo, LoggedInfoKind, LoggedRequest, LoggedRequestKind } from '../../../platform/requestLogger/node/requestLogger';
import { ThinkingData } from '../../../platform/thinking/common/thinking';
import { createFencedCodeBlock } from '../../../util/common/markdown';
import { assertNever } from '../../../util/vs/base/common/assert';
import { Codicon } from '../../../util/vs/base/common/codicons';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Iterable } from '../../../util/vs/base/common/iterator';
import { safeStringify } from '../../../util/vs/base/common/objects';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequest } from '../../../vscodeTypes';
import { renderDataPartToString, renderToolResultToStringNoBudget } from './requestLoggerToolResult';
import { WorkspaceEditRecorder } from './workspaceEditRecorder';

// Utility function to process deltas into a message string
function processDeltasToMessage(deltas: IResponseDelta[]): string {
	return deltas.map((d, i) => {
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
}

// Implementation classes with toJson methods
class LoggedElementInfo implements ILoggedElementInfo {
	public readonly kind = LoggedInfoKind.Element;

	constructor(
		public readonly id: string,
		public readonly name: string,
		public readonly tokens: number,
		public readonly maxTokens: number,
		public readonly trace: HTMLTracer,
		public readonly chatRequest: ChatRequest | undefined
	) { }

	toJSON(): object {
		return {
			id: this.id,
			kind: 'element',
			name: this.name,
			tokens: this.tokens,
			maxTokens: this.maxTokens
		};
	}
}

class LoggedRequestInfo implements ILoggedRequestInfo {
	public readonly kind = LoggedInfoKind.Request;

	constructor(
		public readonly id: string,
		public readonly entry: LoggedRequest,
		public readonly chatRequest: any | undefined
	) { }

	toJSON(): object {
		const baseInfo = {
			id: this.id,
			kind: 'request',
			type: this.entry.type,
			name: this.entry.debugName
		};

		if (this.entry.type === LoggedRequestKind.MarkdownContentRequest) {
			return {
				...baseInfo,
				startTime: new Date(this.entry.startTimeMs).toISOString(),
				content: this.entry.markdownContent
			};
		}

		// Extract prediction and tools like _renderRequestToMarkdown does
		let prediction: string | undefined;
		let tools;
		const postOptions = this.entry.chatParams.postOptions && { ...this.entry.chatParams.postOptions };
		if (postOptions && 'prediction' in postOptions && typeof postOptions.prediction?.content === 'string') {
			prediction = postOptions.prediction.content;
			postOptions.prediction = undefined;
		}
		if (postOptions && 'tools' in postOptions) {
			tools = postOptions.tools;
			postOptions.tools = undefined;
		}

		// Handle stateful marker like _renderRequestToMarkdown does
		const ignoreStatefulMarker = 'ignoreStatefulMarker' in this.entry.chatParams && this.entry.chatParams.ignoreStatefulMarker;
		let lastResponseId: { marker: string; modelId: string } | undefined;
		if (!ignoreStatefulMarker) {
			let statefulMarker: { statefulMarker: { modelId: string; marker: string }; index: number } | undefined;
			if ('messages' in this.entry.chatParams) {
				statefulMarker = Iterable.first(getAllStatefulMarkersAndIndicies(this.entry.chatParams.messages));
			}
			if (statefulMarker) {
				lastResponseId = {
					marker: statefulMarker.statefulMarker.marker,
					modelId: statefulMarker.statefulMarker.modelId
				};
			}
		}

		// Build response data based on entry type
		let responseData;
		let errorInfo;

		if (this.entry.type === LoggedRequestKind.ChatMLSuccess) {
			responseData = {
				type: 'success',
				message: this.entry.result.value
			};
		} else if (this.entry.type === LoggedRequestKind.CompletionSuccess) {
			responseData = {
				type: 'completion',
				message: this.entry.result.value
			};
		} else if (this.entry.type === LoggedRequestKind.ChatMLFailure) {
			if (this.entry.result.type === ChatFetchResponseType.Length) {
				responseData = {
					type: 'truncated',
					message: this.entry.result.truncatedValue
				};
			} else {
				errorInfo = {
					type: 'failure',
					reason: this.entry.result.reason
				};
			}
		} else if (this.entry.type === LoggedRequestKind.ChatMLCancelation) {
			errorInfo = {
				type: 'canceled'
			};
		} else if (this.entry.type === LoggedRequestKind.CompletionFailure) {
			const error = this.entry.result.type;
			errorInfo = {
				type: 'completion_failure',
				error: error instanceof Error ? error.stack : safeStringify(error)
			};
		}

		const metadata = {
			url: typeof this.entry.chatEndpoint.urlOrRequestMetadata === 'string' ?
				this.entry.chatEndpoint.urlOrRequestMetadata : undefined,
			requestType: typeof this.entry.chatEndpoint.urlOrRequestMetadata === 'object' ?
				this.entry.chatEndpoint.urlOrRequestMetadata?.type : undefined,
			model: this.entry.chatParams.model,
			maxPromptTokens: this.entry.chatEndpoint.modelMaxPromptTokens,
			maxResponseTokens: this.entry.chatParams.postOptions?.max_tokens,
			location: this.entry.chatParams.location,
			postOptions: postOptions,
			reasoning: 'body' in this.entry.chatParams && this.entry.chatParams.body?.reasoning,
			intent: this.entry.chatParams.intent,
			startTime: this.entry.startTime?.toISOString(),
			endTime: this.entry.endTime?.toISOString(),
			duration: this.entry.endTime && this.entry.startTime ?
				this.entry.endTime.getTime() - this.entry.startTime.getTime() : undefined,
			ourRequestId: this.entry.chatParams.ourRequestId,
			lastResponseId: lastResponseId,
			requestId: this.entry.type === LoggedRequestKind.ChatMLSuccess || this.entry.type === LoggedRequestKind.ChatMLFailure ? this.entry.result.requestId : undefined,
			serverRequestId: this.entry.type === LoggedRequestKind.ChatMLSuccess || this.entry.type === LoggedRequestKind.ChatMLFailure ? this.entry.result.serverRequestId : undefined,
			timeToFirstToken: this.entry.type === LoggedRequestKind.ChatMLSuccess ? this.entry.timeToFirstToken : undefined,
			usage: this.entry.type === LoggedRequestKind.ChatMLSuccess ? this.entry.usage : undefined,
			tools: tools,
		};

		const requestMessages = 'messages' in this.entry.chatParams ? {
			messages: this.entry.chatParams.messages,
			prediction: prediction
		} : undefined;

		const response = responseData || errorInfo ? {
			...responseData,
			...errorInfo
		} : undefined;

		return {
			...baseInfo,
			metadata: metadata,
			requestMessages: requestMessages,
			response: response
		};
	}
}

class LoggedToolCall implements ILoggedToolCall {
	public readonly kind = LoggedInfoKind.ToolCall;

	constructor(
		public readonly id: string,
		public readonly name: string,
		public readonly args: unknown,
		public readonly response: LanguageModelToolResult2,
		public readonly chatRequest: any | undefined,
		public readonly time: number,
		public readonly thinking?: ThinkingData,
		public readonly edits?: { path: string; edits: string }[],
	) { }

	async toJSON(): Promise<object> {
		const responseData: string[] = [];
		for (const content of this.response.content as (LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart)[]) {
			if (content && 'value' in content && typeof content.value === 'string') {
				responseData.push(content.value);
			} else if (content && 'data' in content && 'mimeType' in content) {
				responseData.push(renderDataPartToString(content));
			} else if (content) {
				responseData.push(await renderToolResultToStringNoBudget(content));
			}
		}

		const thinking = this.thinking?.text ? {
			id: this.thinking.id,
			text: Array.isArray(this.thinking.text) ? this.thinking.text.join('\n') : this.thinking.text
		} : undefined;

		return {
			id: this.id,
			kind: 'toolCall',
			tool: this.name,
			args: this.args,
			time: new Date(this.time).toISOString(),
			response: responseData,
			thinking: thinking,
			edits: this.edits ? this.edits.map(edit => ({ path: edit.path, edits: JSON.parse(edit.edits) })) : undefined
		};
	}
}

export class RequestLogger extends AbstractRequestLogger {

	private _didRegisterLinkProvider = false;
	private readonly _entries: LoggedInfo[] = [];
	private _workspaceEditRecorder: WorkspaceEditRecorder | undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();


		this._register(workspace.registerTextDocumentContentProvider(ChatRequestScheme.chatRequestScheme, {
			onDidChange: Event.map(this.onDidChangeRequests, () => Uri.parse(ChatRequestScheme.buildUri({ kind: 'latest' }))),
			provideTextDocumentContent: (uri) => {
				const parseResult = ChatRequestScheme.parseUri(uri.toString());
				if (!parseResult) { return `Invalid URI: ${uri}`; }

				const { data: uriData, format } = parseResult;
				const entry = uriData.kind === 'latest' ? this._entries.at(-1) : this._entries.find(e => e.id === uriData.id);
				if (!entry) { return `Request not found`; }

				if (format === 'json') {
					return this._renderToJson(entry);
				} else {
					// Existing markdown logic
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
			}
		}));
	}

	public getRequests(): LoggedInfo[] {
		return [...this._entries];
	}

	private _onDidChangeRequests = new Emitter<void>();
	public readonly onDidChangeRequests = this._onDidChangeRequests.event;

	public override logModelListCall(id: string, requestMetadata: RequestMetadata, models: IModelAPIResponse[]): void {
		this.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: 'modelList',
			startTimeMs: Date.now(),
			icon: Codicon.fileCode,
			markdownContent: this._renderModelListToMarkdown(id, requestMetadata, models)
		});
	}

	public override logToolCall(id: string, name: string, args: unknown, response: LanguageModelToolResult2, thinking?: ThinkingData): void {
		const edits = this._workspaceEditRecorder?.getEditsAndReset();
		this._addEntry(new LoggedToolCall(
			id,
			name,
			args,
			response,
			this.currentRequest,
			Date.now(),
			thinking,
			edits
		));
	}

	/** Start tracking edits made to the workspace for every tool call. */
	public override enableWorkspaceEditTracing(): void {
		if (!this._workspaceEditRecorder) {
			this._workspaceEditRecorder = this._instantiationService.createInstance(WorkspaceEditRecorder);
		}
	}

	public override disableWorkspaceEditTracing(): void {
		if (this._workspaceEditRecorder) {
			this._workspaceEditRecorder.dispose();
			this._workspaceEditRecorder = undefined;
		}
	}

	public override addPromptTrace(elementName: string, endpoint: IChatEndpointInfo, result: RenderPromptResult, trace: HTMLTracer): void {
		const id = generateUuid().substring(0, 8);
		this._addEntry(new LoggedElementInfo(id, elementName, result.tokenCount, endpoint.modelMaxPromptTokens, trace, this.currentRequest))
			.catch(e => this._logService.error(e));
	}

	public addEntry(entry: LoggedRequest): void {
		const id = generateUuid().substring(0, 8);
		if (!this._shouldLog(entry)) {
			return;
		}
		this._addEntry(new LoggedRequestInfo(id, entry, this.currentRequest))
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
		if (this._isFirst) {
			this._isFirst = false;
			this._logService.info(`Latest entry: ${ChatRequestScheme.buildUri({ kind: 'latest' })}`);
		}


		this._entries.push(entry);
		// keep at most 100 entries
		if (this._entries.length > 100) {
			this._entries.shift();
		}
		this._onDidChangeRequests.fire();
		return true;
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

	private async _renderToJson(entry: LoggedInfo) {
		try {
			const jsonObject = await entry.toJSON();
			return JSON.stringify(jsonObject, null, 2);
		} catch (error) {
			return JSON.stringify({
				id: entry.id,
				kind: 'error',
				error: error?.toString() || 'Unknown error',
				timestamp: new Date().toISOString()
			}, null, 2);
		}
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

		for (const content of entry.response.content as (LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart)[]) {
			result.push(`~~~`);
			if (content && 'value' in content && typeof content.value === 'string') {
				result.push(content.value);
			} else if (content && 'data' in content && 'mimeType' in content) {
				result.push(renderDataPartToString(content));
			} else if (content) {
				result.push(await renderToolResultToStringNoBudget(content));
			}
			result.push(`~~~`);
		}

		if (entry.thinking?.text) {
			result.push(`## Thinking`);
			if (entry.thinking.id) {
				result.push(`thinkingId: ${entry.thinking.id}`);
			}
			result.push(`~~~`);
			result.push(Array.isArray(entry.thinking.text) ? entry.thinking.text.join('\n') : entry.thinking.text);
			result.push(`~~~`);
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
		if ('body' in entry.chatParams && entry.chatParams.body?.reasoning) {
			result.push(`reasoning        : ${JSON.stringify(entry.chatParams.body.reasoning)}`);
		}
		result.push(`intent           : ${entry.chatParams.intent}`);
		result.push(`startTime        : ${entry.startTime.toJSON()}`);
		result.push(`endTime          : ${entry.endTime.toJSON()}`);
		result.push(`duration         : ${entry.endTime.getTime() - entry.startTime.getTime()}ms`);
		result.push(`ourRequestId     : ${entry.chatParams.ourRequestId}`);

		const ignoreStatefulMarker = 'ignoreStatefulMarker' in entry.chatParams && entry.chatParams.ignoreStatefulMarker;
		if (!ignoreStatefulMarker) {
			let statefulMarker: { statefulMarker: { modelId: string; marker: string }; index: number } | undefined;
			if ('messages' in entry.chatParams) {
				statefulMarker = Iterable.first(getAllStatefulMarkersAndIndicies(entry.chatParams.messages));
			}
			if (statefulMarker) {
				result.push(`lastResponseId   : ${statefulMarker.statefulMarker.marker} using ${statefulMarker.statefulMarker.modelId}`);
			}
		}

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
				result.push(messageToMarkdown(message, ignoreStatefulMarker));
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
		const message = processDeltasToMessage(deltas);
		return `### ${capitalizedRole}\n~~~md\n${message}\n~~~\n`;
	}

	private _renderModelListToMarkdown(requestId: string, requestMetadata: RequestMetadata, models: IModelAPIResponse[]): string {
		const result: string[] = [];
		result.push(`# Model List Request`);
		result.push(``);

		result.push(`## Metadata`);
		result.push(`~~~`);
		result.push(`requestId       : ${requestId}`);
		result.push(`requestType      : ${requestMetadata?.type || 'unknown'}`);
		result.push(`isModelLab      : ${(requestMetadata as { type: string; isModelLab?: boolean }) ? 'yes' : 'no'}`);
		if (requestMetadata.type === RequestType.ListModel) {
			result.push(`requestedModel   : ${(requestMetadata as { type: string; modelId: string })?.modelId || 'unknown'}`);
		}
		result.push(`modelsCount      : ${models.length}`);
		result.push(`~~~`);

		if (models.length > 0) {
			result.push(`## Available Models (Raw API Response)`);
			result.push(``);
			result.push(`\`\`\`json`);
			result.push(JSON.stringify(models, null, 2));
			result.push(`\`\`\``);
			result.push(``);

			// Keep a brief summary for quick reference
			result.push(`## Summary`);
			result.push(`~~~`);
			result.push(`Total models     : ${models.length}`);
			result.push(`Chat models      : ${models.filter(m => m.capabilities.type === 'chat').length}`);
			result.push(`Completion models: ${models.filter(m => m.capabilities.type === 'completion').length}`);
			result.push(`Premium models   : ${models.filter(m => m.billing?.is_premium).length}`);
			result.push(`Preview models   : ${models.filter(m => m.preview).length}`);
			result.push(`Default chat     : ${models.find(m => m.is_chat_default)?.id || 'none'}`);
			result.push(`Fallback chat    : ${models.find(m => m.is_chat_fallback)?.id || 'none'}`);
			result.push(`~~~`);
		}

		result.push(this._renderMarkdownStyles());

		return result.join('\n');
	}
}
