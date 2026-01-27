/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../util/vs/base/common/event';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IActiveLoopInfo, IMidSessionSteeringService, ISteeringMessage } from '../common/midSessionSteeringService';

interface InternalLoopState extends IActiveLoopInfo {
	pendingMessages: ISteeringMessage[];
}

export class MidSessionSteeringService implements IMidSessionSteeringService {
	readonly _serviceBrand: undefined;

	private readonly _activeLoops = new Map<string, InternalLoopState>();

	private readonly _onDidQueueSteeringMessage = new Emitter<{ sessionId: string; message: ISteeringMessage }>();
	readonly onDidQueueSteeringMessage = this._onDidQueueSteeringMessage.event;

	private readonly _onDidChangeActiveLoops = new Emitter<void>();
	readonly onDidChangeActiveLoops = this._onDidChangeActiveLoops.event;

	registerLoop(sessionId: string, turnId: string): void {
		this._activeLoops.set(sessionId, {
			sessionId,
			turnId,
			iterationNumber: 0,
			isProcessing: false,
			startTime: Date.now(),
			pendingMessages: [],
		});
		this._onDidChangeActiveLoops.fire();
	}

	unregisterLoop(sessionId: string): void {
		this._activeLoops.delete(sessionId);
		this._onDidChangeActiveLoops.fire();
	}

	updateLoopStatus(sessionId: string, update: Partial<Pick<IActiveLoopInfo, 'iterationNumber' | 'isProcessing'>>): void {
		const loop = this._activeLoops.get(sessionId);
		if (loop) {
			Object.assign(loop, update);
		}
	}

	queueSteeringMessage(sessionId: string, content: string, metadata?: Record<string, unknown>): string | undefined {
		const loop = this._activeLoops.get(sessionId);
		if (!loop) {
			return undefined;
		}

		const message: ISteeringMessage = {
			id: generateUuid(),
			content,
			metadata,
			timestamp: Date.now(),
		};

		loop.pendingMessages.push(message);
		this._onDidQueueSteeringMessage.fire({ sessionId, message });
		return message.id;
	}

	consumeSteeringMessages(sessionId: string): readonly ISteeringMessage[] {
		const loop = this._activeLoops.get(sessionId);
		if (!loop) {
			return [];
		}
		const messages = [...loop.pendingMessages];
		loop.pendingMessages = [];
		return messages;
	}

	hasPendingSteeringMessages(sessionId: string): boolean {
		return (this._activeLoops.get(sessionId)?.pendingMessages.length ?? 0) > 0;
	}

	getActiveLoop(sessionId: string): IActiveLoopInfo | undefined {
		const loop = this._activeLoops.get(sessionId);
		if (!loop) {
			return undefined;
		}
		const { pendingMessages: _, ...info } = loop;
		return info;
	}

	getAllActiveLoops(): readonly IActiveLoopInfo[] {
		return Array.from(this._activeLoops.values()).map(({ pendingMessages: _, ...info }) => info);
	}
}
