/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';

export const IObservabilityService = createServiceIdentifier<IObservabilityService>('IObservabilityService');

export const enum ChatRequestOutcome {
	Success = 'success',
	Cancelled = 'cancelled',
	Error = 'error',
}

export interface IChatRequestStartedEvent {
	readonly requestId: string;
	// NOTE: The public extension API exposes a mirrored version of this shape in
	// `src/extension/api/vscode/chatRequestApiTypes.d.ts`. We intentionally keep those
	// types separate so external extensions don't need to reference internal module paths.
	/**
	 * Extensible bag for future fields. Must never include prompt/tool arguments,
	 * file paths, or other request content.
	 */
	readonly result: {
		readonly status: 'started';
	};
}

export interface IChatRequestFinishedEvent {
	readonly requestId: string;
	/**
	 * Extensible bag for future fields. Must never include prompt/tool arguments,
	 * file paths, or other request content.
	 */
	readonly result: {
		readonly status: ChatRequestOutcome;
		/**
		 * Optional machine-readable code, e.g. 'rate_limited' | 'network_error'.
		 * Avoid exposing raw error messages.
		 */
		readonly reason?: string;
	};
}

export interface IObservabilityService extends IDisposable {
	readonly _serviceBrand: undefined;

	/**
	 * Fires when a Copilot Chat request starts being handled.
	 */
	readonly onDidStartChatRequest: Event<IChatRequestStartedEvent>;
	/**
	 * Fires when a Copilot Chat request finishes being handled.
	 */
	readonly onDidFinishChatRequest: Event<IChatRequestFinishedEvent>;

	notifyChatRequestStart(requestId: string): void;
	notifyChatRequestFinish(requestId: string, result: IChatRequestFinishedEvent['result']): void;
}

export class ObservabilityService implements IObservabilityService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidStartChatRequest = new Emitter<IChatRequestStartedEvent>();
	public readonly onDidStartChatRequest = this._onDidStartChatRequest.event;

	private readonly _onDidFinishChatRequest = new Emitter<IChatRequestFinishedEvent>();
	public readonly onDidFinishChatRequest = this._onDidFinishChatRequest.event;

	notifyChatRequestStart(requestId: string): void {
		this._onDidStartChatRequest.fire({ requestId, result: { status: 'started' } });
	}

	notifyChatRequestFinish(requestId: string, result: IChatRequestFinishedEvent['result']): void {
		this._onDidFinishChatRequest.fire({ requestId, result });
	}

	dispose(): void {
		this._onDidStartChatRequest.dispose();
		this._onDidFinishChatRequest.dispose();
	}
}
