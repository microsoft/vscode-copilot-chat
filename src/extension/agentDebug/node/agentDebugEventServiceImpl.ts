/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAgentDebugEventService } from '../common/agentDebugEventService';
import { AgentDebugEventCategory, IAgentDebugEvent, IAgentDebugEventFilter, ILLMRequestEvent, IToolCallEvent } from '../common/agentDebugTypes';

const DEFAULT_MAX_EVENTS = 5000;

/**
 * Fixed-capacity ring buffer that overwrites the oldest entry on overflow.
 * Provides O(1) insertion and eviction, and O(n) ordered iteration.
 */
class RingBuffer<T> {
	private readonly _buffer: (T | undefined)[];
	private _head = 0;
	private _size = 0;

	constructor(readonly capacity: number) {
		this._buffer = new Array<T | undefined>(capacity);
	}

	get size(): number {
		return this._size;
	}

	/** Appends an item, evicting and returning the oldest if at capacity. */
	push(item: T): T | undefined {
		let evicted: T | undefined;
		if (this._size === this.capacity) {
			evicted = this._buffer[this._head];
			this._buffer[this._head] = item;
			this._head = (this._head + 1) % this.capacity;
		} else {
			this._buffer[(this._head + this._size) % this.capacity] = item;
			this._size++;
		}
		return evicted;
	}

	/** Iterates items from oldest to newest. */
	*[Symbol.iterator](): IterableIterator<T> {
		for (let i = 0; i < this._size; i++) {
			yield this._buffer[(this._head + i) % this.capacity] as T;
		}
	}

	/** Returns items in insertion order as a new array. */
	toArray(): T[] {
		const result: T[] = [];
		for (const item of this) {
			result.push(item);
		}
		return result;
	}

	clear(): void {
		this._buffer.fill(undefined);
		this._head = 0;
		this._size = 0;
	}

	/**
	 * Removes all items matching the predicate in a single pass, compacting
	 * the buffer. O(n) — intended for infrequent operations like
	 * single-session clear.
	 */
	removeWhere(predicate: (item: T) => boolean): void {
		const kept = this.toArray().filter(item => !predicate(item));
		this.clear();
		for (const item of kept) {
			this.push(item);
		}
	}
}

export class AgentDebugEventServiceImpl extends Disposable implements IAgentDebugEventService {
	declare readonly _serviceBrand: undefined;

	/** All events in insertion order, oldest automatically evicted at capacity. */
	private readonly _events: RingBuffer<IAgentDebugEvent>;
	/** Per-session index for fast lookups and session-awareness. */
	private readonly _sessionEvents = new Map<string, IAgentDebugEvent[]>();
	/** Per-ID index for O(1) lookups. */
	private readonly _eventById = new Map<string, IAgentDebugEvent>();

	private readonly _onDidAddEvent = this._register(new Emitter<IAgentDebugEvent>());
	readonly onDidAddEvent = this._onDidAddEvent.event;

	private readonly _onDidClearEvents = this._register(new Emitter<void>());
	readonly onDidClearEvents = this._onDidClearEvents.event;

	constructor() {
		super();
		this._events = new RingBuffer(DEFAULT_MAX_EVENTS);
	}

	addEvent(event: IAgentDebugEvent): void {
		const evicted = this._events.push(event);
		this._eventById.set(event.id, event);
		// Maintain per-session index
		let sessionList = this._sessionEvents.get(event.sessionId);
		if (!sessionList) {
			sessionList = [];
			this._sessionEvents.set(event.sessionId, sessionList);
		}
		sessionList.push(event);
		// Clean up evicted entry from secondary indexes
		if (evicted) {
			this._eventById.delete(evicted.id);
			const list = this._sessionEvents.get(evicted.sessionId);
			if (list) {
				const idx = list.indexOf(evicted);
				if (idx >= 0) {
					list.splice(idx, 1);
				}
				if (list.length === 0) {
					this._sessionEvents.delete(evicted.sessionId);
				}
			}
		}
		this._onDidAddEvent.fire(event);
	}

	getEventById(id: string): IAgentDebugEvent | undefined {
		return this._eventById.get(id);
	}

	getEvents(filter?: IAgentDebugEventFilter): readonly IAgentDebugEvent[] {
		if (!filter) {
			return this._events.toArray();
		}

		const result: IAgentDebugEvent[] = [];
		for (const e of this._events) {
			if (filter.categories && filter.categories.length > 0) {
				if (!filter.categories.includes(e.category as AgentDebugEventCategory)) {
					continue;
				}
			}
			if (filter.sessionId && e.sessionId !== filter.sessionId) {
				continue;
			}
			if (filter.timeRange) {
				if (e.timestamp < filter.timeRange.start || e.timestamp > filter.timeRange.end) {
					continue;
				}
			}
			if (filter.statusFilter) {
				let status: string | undefined;
				if (e.category === AgentDebugEventCategory.ToolCall) {
					status = (e as IToolCallEvent).status;
				} else if (e.category === AgentDebugEventCategory.LLMRequest) {
					status = (e as ILLMRequestEvent).status;
				}
				if (status !== undefined && status !== filter.statusFilter) {
					continue;
				}
			}
			result.push(e);
		}
		return result;
	}

	hasSessionData(sessionId: string): boolean {
		const list = this._sessionEvents.get(sessionId);
		return !!list && list.length > 0;
	}

	getSessionIds(): readonly string[] {
		return [...this._sessionEvents.keys()];
	}

	clearEvents(sessionId?: string): void {
		if (sessionId) {
			// Remove from ID index
			const sessionList = this._sessionEvents.get(sessionId);
			if (sessionList) {
				for (const e of sessionList) {
					this._eventById.delete(e.id);
				}
			}
			this._events.removeWhere(e => e.sessionId === sessionId);
			this._sessionEvents.delete(sessionId);
		} else {
			this._events.clear();
			this._sessionEvents.clear();
			this._eventById.clear();
		}
		this._onDidClearEvents.fire();
	}
}
