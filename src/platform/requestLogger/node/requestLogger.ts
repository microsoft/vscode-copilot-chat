/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HTMLTracer, IChatEndpointInfo, RenderPromptResult } from '@vscode/prompt-tsx';
import { AsyncLocalStorage } from 'async_hooks';
import type { Event } from 'vscode';
import { ChatFetchError, ChatFetchResponseType, ChatLocation, ChatResponses, FetchSuccess } from '../../../platform/chat/common/commonTypes';
import { IResponseDelta } from '../../../platform/networking/common/fetch';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { Result } from '../../../util/common/result';
import { createServiceIdentifier } from '../../../util/common/services';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ThemeIcon } from '../../../util/vs/base/common/themables';
import { assertType } from '../../../util/vs/base/common/types';
import { OffsetRange } from '../../../util/vs/editor/common/core/ranges/offsetRange';
import { ChatRequest, LanguageModelToolResult2 } from '../../../vscodeTypes';
import { Completion } from '../../nesFetch/common/completionsAPI';
import { CompletionsFetchFailure, ModelParams } from '../../nesFetch/common/completionsFetchService';
import { IFetchRequestParams } from '../../nesFetch/node/completionsFetchServiceImpl';
import { APIUsage } from '../../networking/common/openai';
import { ChatParams } from '../../openai/node/fetch';
import { ThinkingData } from '../../thinking/common/thinking';

export type UriData = { kind: 'request'; id: string } | { kind: 'latest' };

export class ChatRequestScheme {
	public static readonly chatRequestScheme = 'ccreq';

	public static buildUri(data: UriData): string {
		if (data.kind === 'latest') {
			return `${ChatRequestScheme.chatRequestScheme}:latestrequest.copilotmd`;
		} else {
			return `${ChatRequestScheme.chatRequestScheme}:${data.id}.copilotmd`;
		}
	}

	public static parseUri(uri: string): UriData | undefined {
		if (uri === ChatRequestScheme.buildUri({ kind: 'latest' })) {
			return { kind: 'latest' };
		} else {
			const match = uri.match(/ccreq:([^\s]+)\.copilotmd/);
			if (match) {
				return { kind: 'request', id: match[1] };
			}
		}
		return undefined;
	}

	public static findAllUris(text: string): { uri: string; range: OffsetRange }[] {
		const linkRE = /(ccreq:[^\s]+\.copilotmd)/g;
		return [...text.matchAll(linkRE)].map(
			(m) => {
				const identifier = m[1];
				return {
					uri: identifier,
					range: new OffsetRange(m.index!, m.index! + identifier.length)
				};
			}
		);
	}
}

export const enum LoggedInfoKind {
	Element,
	Request,
	ToolCall,
}

export interface ILoggedElementInfo {
	kind: LoggedInfoKind.Element;
	id: string;
	name: string;
	tokens: number;
	maxTokens: number;
	trace: HTMLTracer;
	chatRequest: ChatRequest | undefined;
}

export interface ILoggedRequestInfo {
	kind: LoggedInfoKind.Request;
	id: string;
	entry: LoggedRequest;
	chatRequest: ChatRequest | undefined;
}

export interface ILoggedToolCall {
	kind: LoggedInfoKind.ToolCall;
	id: string;
	name: string;
	args: unknown;
	response: LanguageModelToolResult2;
	chatRequest: ChatRequest | undefined;
	time: number;
	thinking?: ThinkingData;
}

export type LoggedInfo = ILoggedElementInfo | ILoggedRequestInfo | ILoggedToolCall;

export const IRequestLogger = createServiceIdentifier<IRequestLogger>('IRequestLogger');
export interface IRequestLogger {

	readonly _serviceBrand: undefined;

	promptRendererTracing: boolean;

	captureInvocation<T>(request: ChatRequest, fn: () => Promise<T>): Promise<T>;

	logToolCall(id: string, name: string, args: unknown, response: LanguageModelToolResult2, thinking?: ThinkingData): void;

	logChatRequest(debugName: string, chatEndpoint: IChatEndpointLogInfo, chatParams: ChatParams): PendingLoggedChatRequest;

	logCompletionRequest(debugName: string, chatEndpoint: IChatEndpointLogInfo, chatParams: ICompletionFetchRequestLogParams, requestId: string): PendingLoggedCompletionRequest;

	addPromptTrace(elementName: string, endpoint: IChatEndpointInfo, result: RenderPromptResult, trace: HTMLTracer): void;
	addEntry(entry: LoggedRequest): void;

	onDidChangeRequests: Event<void>;
	getRequests(): LoggedInfo[];
}

export const enum LoggedRequestKind {
	ChatMLSuccess = 'ChatMLSuccess',
	ChatMLFailure = 'ChatMLFailure',
	ChatMLCancelation = 'ChatMLCancelation',
	CompletionSuccess = 'CompletionSuccess',
	CompletionFailure = 'CompletionFailure',
	MarkdownContentRequest = 'MarkdownContentRequest',
}

export type IChatEndpointLogInfo = Partial<Pick<IChatEndpoint, 'model' | 'modelMaxPromptTokens' | 'urlOrRequestMetadata'>>;

export interface ICompletionFetchRequestLogParams extends IFetchRequestParams {
	ourRequestId: string;
	postOptions?: ModelParams;
	location: ChatLocation;
	intent?: false;
}

export interface ILoggedChatMLRequest {
	debugName: string;
	chatEndpoint: IChatEndpointLogInfo;
	chatParams: ChatParams | ICompletionFetchRequestLogParams;
	startTime: Date;
	endTime: Date;
}

export interface ILoggedChatMLSuccessRequest extends ILoggedChatMLRequest {
	type: LoggedRequestKind.ChatMLSuccess;
	timeToFirstToken: number | undefined;
	usage: APIUsage | undefined;
	result: FetchSuccess<string[]>;
	deltas?: IResponseDelta[];
}

export interface ILoggedChatMLFailureRequest extends ILoggedChatMLRequest {
	type: LoggedRequestKind.ChatMLFailure;
	timeToFirstToken: number | undefined;
	result: ChatFetchError;
}

export interface ILoggedChatMLCancelationRequest extends ILoggedChatMLRequest {
	type: LoggedRequestKind.ChatMLCancelation;
}

export interface IMarkdownContentRequest {
	type: LoggedRequestKind.MarkdownContentRequest;
	startTimeMs: number;
	icon: ThemeIcon | undefined;
	debugName: string;
	markdownContent: string;
}

export interface ILoggedCompletionSuccessRequest extends ILoggedChatMLRequest {
	type: LoggedRequestKind.CompletionSuccess;
	timeToFirstToken: number | undefined;
	result: { type: ChatFetchResponseType.Success; value: string; requestId: string };
	deltas?: undefined;
}

export interface ILoggedCompletionFailureRequest extends ILoggedChatMLRequest {
	type: LoggedRequestKind.CompletionFailure;
	timeToFirstToken: number | undefined;
	result: { type: CompletionsFetchFailure | Error; requestId: string };
}

export type LoggedRequest = (
	ILoggedChatMLSuccessRequest
	| ILoggedChatMLFailureRequest
	| ILoggedChatMLCancelationRequest
	| IMarkdownContentRequest
	| ILoggedCompletionSuccessRequest
	| ILoggedCompletionFailureRequest
);

const requestLogStorage = new AsyncLocalStorage<ChatRequest>();

export abstract class AbstractRequestLogger extends Disposable implements IRequestLogger {
	declare _serviceBrand: undefined;

	public get promptRendererTracing() {
		return false;
	}

	public captureInvocation<T>(request: ChatRequest, fn: () => Promise<T>): Promise<T> {
		return requestLogStorage.run(request, () => fn());
	}

	public abstract logToolCall(id: string, name: string | undefined, args: unknown, response: LanguageModelToolResult2): void;

	public logChatRequest(debugName: string, chatEndpoint: IChatEndpoint, chatParams: ChatParams): PendingLoggedChatRequest {
		return new PendingLoggedChatRequest(this, debugName, chatEndpoint, chatParams);
	}

	public logCompletionRequest(debugName: string, chatEndpoint: IChatEndpointLogInfo, chatParams: ICompletionFetchRequestLogParams, requestId: string): PendingLoggedCompletionRequest {
		return new PendingLoggedCompletionRequest(this, debugName, chatEndpoint, chatParams, requestId);
	}

	public abstract addPromptTrace(elementName: string, endpoint: IChatEndpointInfo, result: RenderPromptResult, trace: HTMLTracer): void;
	public abstract addEntry(entry: LoggedRequest): void;
	public abstract getRequests(): LoggedInfo[];
	abstract onDidChangeRequests: Event<void>;

	/** Current request being made to the LM. */
	protected get currentRequest() {
		return requestLogStorage.getStore();
	}
}

class AbstractPendingLoggedRequest {
	protected _time: Date;
	protected _timeToFirstToken: number | undefined = undefined;

	constructor(
		protected _logbook: IRequestLogger,
		protected _debugName: string,
		protected _chatEndpoint: IChatEndpointLogInfo,
		protected _chatParams: ChatParams | ICompletionFetchRequestLogParams
	) {
		this._time = new Date();
	}

	markTimeToFirstToken(timeToFirstToken: number): void {
		this._timeToFirstToken = timeToFirstToken;
	}

	resolveWithCancelation() {
		this._logbook.addEntry({
			type: LoggedRequestKind.ChatMLCancelation,
			debugName: this._debugName,
			chatEndpoint: this._chatEndpoint,
			chatParams: this._chatParams,
			startTime: this._time,
			endTime: new Date()
		});
	}
}

export class PendingLoggedCompletionRequest extends AbstractPendingLoggedRequest {

	constructor(
		logbook: IRequestLogger,
		debugName: string,
		chatEndpoint: IChatEndpointLogInfo,
		chatParams: ICompletionFetchRequestLogParams,
		private requestId: string
	) {
		super(logbook, debugName, chatEndpoint, chatParams);
	}

	resolve(result: Result<Completion, CompletionsFetchFailure | Error>): void {
		if (result.isOk()) {
			const completionText = result.val.choices.at(0)?.text;
			assertType(completionText !== undefined, 'Completion with empty choices');

			this._logbook.addEntry({
				type: LoggedRequestKind.CompletionSuccess,
				debugName: this._debugName,
				chatEndpoint: this._chatEndpoint,
				chatParams: this._chatParams,
				startTime: this._time,
				endTime: new Date(),
				timeToFirstToken: this._timeToFirstToken,
				result: { type: ChatFetchResponseType.Success, value: completionText, requestId: this.requestId },
			});
		} else {
			this._logbook.addEntry({
				type: LoggedRequestKind.CompletionFailure,
				debugName: this._debugName,
				chatEndpoint: this._chatEndpoint,
				chatParams: this._chatParams,
				startTime: this._time,
				endTime: new Date(),
				timeToFirstToken: this._timeToFirstToken,
				result: { type: result.err, requestId: this.requestId },
			});
		}
	}
}

export class PendingLoggedChatRequest extends AbstractPendingLoggedRequest {
	constructor(
		logbook: IRequestLogger,
		debugName: string,
		chatEndpoint: IChatEndpoint,
		chatParams: ChatParams
	) {
		super(logbook, debugName, chatEndpoint, chatParams);
	}

	resolve(result: ChatResponses, deltas?: IResponseDelta[]): void {
		if (result.type === ChatFetchResponseType.Success) {
			this._logbook.addEntry({
				type: LoggedRequestKind.ChatMLSuccess,
				debugName: this._debugName,
				usage: result.usage,
				chatEndpoint: this._chatEndpoint,
				chatParams: this._chatParams,
				startTime: this._time,
				endTime: new Date(),
				timeToFirstToken: this._timeToFirstToken,
				result,
				deltas
			});
		} else {
			this._logbook.addEntry({
				type: result.type === ChatFetchResponseType.Canceled ? LoggedRequestKind.ChatMLCancelation : LoggedRequestKind.ChatMLFailure,
				debugName: this._debugName,
				chatEndpoint: this._chatEndpoint,
				chatParams: this._chatParams,
				startTime: this._time,
				endTime: new Date(),
				timeToFirstToken: this._timeToFirstToken,
				result,
			});
		}
	}
}
