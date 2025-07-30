/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HTMLTracer, IChatEndpointInfo, RenderPromptResult } from '@vscode/prompt-tsx';
import { CancellationToken, DocumentLink, DocumentLinkProvider, LanguageModelPromptTsxPart, LanguageModelTextPart, LanguageModelToolResult2, languages, Range, TextDocument, Uri, workspace } from 'vscode';
import { ChatFetchResponseType } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService, XTabProviderId } from '../../../platform/configuration/common/configurationService';
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
import { renderToolResultToStringNoBudget } from './requestLoggerToolResult';

export class RequestLogger extends AbstractRequestLogger {

	private _didRegisterLinkProvider = false;
	private readonly _entries: LoggedInfo[] = [];

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configService: IConfigurationService,
	) {
		super();

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
