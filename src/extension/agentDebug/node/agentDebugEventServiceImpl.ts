/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAgentDebugEventService } from '../common/agentDebugEventService';
import { AgentDebugEventCategory, IAgentDebugEvent, IAgentDebugEventFilter } from '../common/agentDebugTypes';

const DEFAULT_MAX_EVENTS = 5000;

export class AgentDebugEventServiceImpl extends Disposable implements IAgentDebugEventService {
	declare readonly _serviceBrand: undefined;

	private readonly _events: IAgentDebugEvent[] = [];
	private readonly _maxEvents: number;

	private readonly _onDidAddEvent = this._register(new Emitter<IAgentDebugEvent>());
	readonly onDidAddEvent = this._onDidAddEvent.event;

	private readonly _onDidClearEvents = this._register(new Emitter<void>());
	readonly onDidClearEvents = this._onDidClearEvents.event;

	constructor() {
		super();
		this._maxEvents = DEFAULT_MAX_EVENTS;
	}

	addEvent(event: IAgentDebugEvent): void {
		this._events.push(event);
		// Evict oldest when exceeding buffer size
		if (this._events.length > this._maxEvents) {
			this._events.splice(0, this._events.length - this._maxEvents);
		}
		this._onDidAddEvent.fire(event);
	}

	getEvents(filter?: IAgentDebugEventFilter): readonly IAgentDebugEvent[] {
		if (!filter) {
			return this._events;
		}

		return this._events.filter(e => {
			if (filter.categories && filter.categories.length > 0) {
				if (!filter.categories.includes(e.category as AgentDebugEventCategory)) {
					return false;
				}
			}
			if (filter.sessionId && e.sessionId !== filter.sessionId) {
				return false;
			}
			if (filter.timeRange) {
				if (e.timestamp < filter.timeRange.start || e.timestamp > filter.timeRange.end) {
					return false;
				}
			}
			if (filter.statusFilter) {
				const status = (e.details as Record<string, unknown>)['status'];
				if (status !== undefined && status !== filter.statusFilter) {
					return false;
				}
			}
			return true;
		});
	}

	clearEvents(sessionId?: string): void {
		if (sessionId) {
			for (let i = this._events.length - 1; i >= 0; i--) {
				if (this._events[i].sessionId === sessionId) {
					this._events.splice(i, 1);
				}
			}
		} else {
			this._events.length = 0;
		}
		this._onDidClearEvents.fire();
	}
}
