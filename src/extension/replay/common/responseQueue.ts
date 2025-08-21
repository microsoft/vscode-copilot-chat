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

const pendingRequests: Deferred<ChatStep | 'finished'>[] = [];
const responses: (ChatStep | 'finished')[] = [];

export function replayResponse(response: ChatStep): void {
	const waiter = pendingRequests.shift();
	if (waiter) {
		waiter.resolve(response);
	} else {
		responses.push(response);
	}
}

export function markDone(): void {
	const waiter = pendingRequests.shift();
	if (waiter) {
		waiter.resolve('finished');
	} else {
		responses.push('finished');
	}
}

export function getResponse(): Promise<ChatStep | 'finished'> {
	const next = responses.shift();
	if (next) {
		return Promise.resolve(next);
	}
	const deferred = createDeferred<ChatStep | 'finished'>();
	pendingRequests.push(deferred);
	return deferred.promise;
}

const toolResults: Map<string, string[]> = new Map();

export function setToolResult(id: string, result: string[]): void {
	toolResults.set(id, result);
}

export function getToolResult(id: string): string[] | undefined {
	return toolResults.get(id);
}
