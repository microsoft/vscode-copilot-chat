/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../util/vs/base/common/event';
import { createServiceIdentifier } from '../../../util/common/services';

export const IMidSessionSteeringService = createServiceIdentifier<IMidSessionSteeringService>('IMidSessionSteeringService');

export interface ISteeringMessage {
	readonly id: string;
	readonly content: string;
	readonly metadata?: Record<string, unknown>;
	readonly timestamp: number;
}

export interface IActiveLoopInfo {
	readonly sessionId: string;
	readonly turnId: string;
	readonly iterationNumber: number;
	readonly isProcessing: boolean;
	readonly startTime: number;
}

export interface IMidSessionSteeringService {
	readonly _serviceBrand: undefined;

	// Loop lifecycle
	registerLoop(sessionId: string, turnId: string): void;
	unregisterLoop(sessionId: string): void;
	updateLoopStatus(sessionId: string, update: Partial<Pick<IActiveLoopInfo, 'iterationNumber' | 'isProcessing'>>): void;

	// Steering message queue
	queueSteeringMessage(sessionId: string, content: string, metadata?: Record<string, unknown>): string | undefined;
	consumeSteeringMessages(sessionId: string): readonly ISteeringMessage[];
	hasPendingSteeringMessages(sessionId: string): boolean;

	// Query
	getActiveLoop(sessionId: string): IActiveLoopInfo | undefined;
	getAllActiveLoops(): readonly IActiveLoopInfo[];

	// Events
	readonly onDidQueueSteeringMessage: Event<{ sessionId: string; message: ISteeringMessage }>;
	readonly onDidChangeActiveLoops: Event<void>;
}
