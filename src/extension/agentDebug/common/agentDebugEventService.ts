/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from 'vscode';
import { createServiceIdentifier } from '../../../util/common/services';
import { IAgentDebugEvent, IAgentDebugEventFilter } from './agentDebugTypes';

export const IAgentDebugEventService = createServiceIdentifier<IAgentDebugEventService>('IAgentDebugEventService');

/**
 * Service for collecting and querying agent debug events.
 *
 * Interface mirrors the future `ChatAgentDebugEventProvider` shape:
 * - `getEvents(filter?)` → `provideDebugEvents(filter?)`
 * - `onDidAddEvent` → `onDidChangeDebugEvents`
 */
export interface IAgentDebugEventService {
	readonly _serviceBrand: undefined;

	addEvent(event: IAgentDebugEvent): void;
	getEvents(filter?: IAgentDebugEventFilter): readonly IAgentDebugEvent[];
	clearEvents(sessionId?: string): void;

	readonly onDidAddEvent: Event<IAgentDebugEvent>;
	readonly onDidClearEvents: Event<void>;
}
