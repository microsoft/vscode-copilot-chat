/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'zeromq' {
	export class Socket {
		constructor(options?: Record<string, unknown>);
		bind(address: string): Promise<void>;
		close(): void;
		connect(address: string): void;
		disconnect(address: string): void;
		[Symbol.asyncIterator](): AsyncIterableIterator<Buffer[]>;
		receive(): Promise<Buffer[]>;
		send(frames: Array<string | Buffer | Uint8Array | ArrayBufferView>): Promise<void>;
		send(...frames: Array<string | Buffer | Uint8Array | ArrayBufferView>): Promise<void>;
	}

	export class Dealer extends Socket {
		constructor(options?: { routingId?: string });
		routingId?: string;
	}

	export class Push extends Socket {
		constructor(options?: Record<string, unknown>);
	}

	export class Subscriber extends Socket {
		constructor(options?: Record<string, unknown>);
		subscribe(topic?: string | Buffer): void;
		unsubscribe(topic?: string | Buffer): void;
	}
}
