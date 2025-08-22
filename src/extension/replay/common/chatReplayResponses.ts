/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

type FileUpdate = {
	path: string;
	newContentPath?: string;
	newContent?: string;
};

type ToolStep = {
	kind: 'toolCall';
	id: string;
	line: number;
	args: { [key: string]: any };
	toolName: string;
	fileUpdates: FileUpdate[];
	results: string[];
};

type UserQuery = {
	kind: 'userQuery';
	line: number;
	query: string;
};

type Request = {
	kind: 'request';
	id: string;
	line: number;
	prompt: string;
	result: string;
}

export type ChatStep = UserQuery | Request | ToolStep;

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: any) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: any) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export class ChatReplayResponses {
	private pendingRequests: Deferred<ChatStep | 'finished'>[] = [];
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
			waiter.resolve(response);
		} else {
			this.responses.push(response);
		}
	}

	public getResponse(): Promise<ChatStep | 'finished'> {
		const next = this.responses.shift();
		if (next) {
			return Promise.resolve(next);
		}
		const deferred = createDeferred<ChatStep | 'finished'>();
		this.pendingRequests.push(deferred);
		return deferred.promise;
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
				waiter.resolve('finished');
			}
		}
		this.responses.push('finished');
	}

	public cancelReplay(): void {
		this.onCancel?.();
		this.markDone();
	}
}
