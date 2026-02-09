/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../util/vs/base/common/async';

export type Replacement = {
	replaceRange: {
		start: number;
		endExclusive: number;
	};
	newText: string;
};

export type FileEdits = {
	path: string;
	edits: {
		replacements: Replacement[];
	};
}

export type ToolStep = {
	kind: 'toolCall';
	id: string;
	line: number;
	args: { [key: string]: unknown };
	toolName: string;
	edits: FileEdits[];
	results: string[];
};

export type UserQuery = {
	kind: 'userQuery';
	line: number;
	query: string;
};

export type ModelRequest = {
	kind: 'request';
	id: string;
	line: number;
	prompt: string;
	result: string;
}

export type ChatStep = UserQuery | ModelRequest | ToolStep;

export class ChatReplayResponses {
	private pendingRequests: DeferredPromise<ChatStep | 'finished'>[] = [];
	private responses: (ChatStep | 'finished')[] = [];
	private toolResults: Map<string, string[]> = new Map();

	public static instance: ChatReplayResponses;

	public static getInstance(): ChatReplayResponses {
		if (!ChatReplayResponses.instance) {
			// if no one created an instance yet, return one that is already marked done
			ChatReplayResponses.instance = new ChatReplayResponses();
			ChatReplayResponses.instance.markDone();
		}
		return ChatReplayResponses.instance;
	}

	public static create(onCancel: () => void): ChatReplayResponses {
		ChatReplayResponses.instance = new ChatReplayResponses(onCancel);
		return ChatReplayResponses.instance;
	}

	private constructor(private onCancel?: () => void) { }

	public replayResponse(response: ChatStep): void {
		const waiter = this.pendingRequests.shift();
		if (waiter) {
			waiter.settleWith(Promise.resolve(response));
		} else {
			this.responses.push(response);
		}
	}

	public getResponse(): Promise<ChatStep | 'finished'> {
		const next = this.responses.shift();
		if (next) {
			return Promise.resolve(next);
		}
		const deferred = new DeferredPromise<ChatStep | 'finished'>();
		this.pendingRequests.push(deferred);
		return deferred.p;
	}

	public setToolResult(id: string, result: string[]): void {
		this.toolResults.set(id, result);
	}

	public getToolResult(id: string): string[] | undefined {
		return this.toolResults.get(id);
	}

	public markDone(): void {
		while (this.pendingRequests.length > 0) {
			const waiter = this.pendingRequests.shift();
			if (waiter) {
				waiter.settleWith(Promise.resolve('finished'));
			}
		}
		this.responses.push('finished');
	}

	public cancelReplay(): void {
		this.onCancel?.();
		this.markDone();
	}
}
