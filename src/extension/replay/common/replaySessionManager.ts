/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../util/vs/base/common/async';
import { ChatStep } from './chatReplayResponses';
import { parseReplayFromSessionId } from './replayParser';

export class ReplaySession implements AsyncIterable<ChatStep> {
	private _allSteps: ChatStep[];
	private _currentIndex = 0;
	private _pendingRequests: DeferredPromise<ChatStep | undefined>[] = [];

	constructor(
		readonly sessionId: string,
		readonly filePath: string,
		allSteps: ChatStep[]
	) {
		this._allSteps = allSteps;
	}

	get allSteps(): ChatStep[] {
		return this._allSteps;
	}

	get currentStep(): ChatStep | undefined {
		if (this._currentIndex >= 0 && this._currentIndex < this._allSteps.length) {
			return this._allSteps[this._currentIndex];
		}
		return undefined;
	}

	get totalSteps(): number {
		return this._allSteps.length;
	}

	/**
	 * Creates an async iterable for the chat steps
	 */
	async *iterateSteps(): AsyncIterableIterator<ChatStep> {
		// Yield all already-processed steps
		for (let i = 0; i < this._currentIndex; i++) {
			yield this._allSteps[i];
		}

		// Yield future steps as they become available
		while (this._currentIndex < this._allSteps.length) {
			const step = await this.waitForNextStep();
			if (step) {
				yield step;
			} else {
				break; // Session terminated
			}
		}
	}

	/**
	 * Implements AsyncIterable interface
	 */
	[Symbol.asyncIterator](): AsyncIterableIterator<ChatStep> {
		return this.iterateSteps();
	}

	private async waitForNextStep(): Promise<ChatStep | undefined> {
		if (this._currentIndex < this._allSteps.length) {
			// Create a deferred promise that will be resolved when stepNext is called
			const deferred = new DeferredPromise<ChatStep | undefined>();
			this._pendingRequests.push(deferred);
			return deferred.p;
		}
		return undefined;
	}

	stepNext(): ChatStep | undefined {
		if (this._currentIndex >= this._allSteps.length) {
			// Resolve all pending requests with undefined
			while (this._pendingRequests.length > 0) {
				const deferred = this._pendingRequests.shift();
				deferred?.complete(undefined);
			}
			return undefined;
		}

		const step = this._allSteps[this._currentIndex];
		this._currentIndex++;

		// Resolve the oldest pending request with this step
		const deferred = this._pendingRequests.shift();
		if (deferred) {
			deferred.complete(step);
		}

		return step;
	}

	stepTo(index: number): void {
		while (this._currentIndex < index && this._currentIndex < this._allSteps.length) {
			this.stepNext();
		}
	}

	reset(): void {
		this._currentIndex = 0;
		// Cancel all pending requests
		while (this._pendingRequests.length > 0) {
			const deferred = this._pendingRequests.shift();
			deferred?.complete(undefined);
		}
	}

	stepToEnd(): void {
		this.stepTo(this._allSteps.length);
	}

	dispose(): void {
		// Cancel all pending requests
		while (this._pendingRequests.length > 0) {
			const deferred = this._pendingRequests.shift();
			deferred?.complete(undefined);
		}
	}
}

export class ReplaySessionManager {
	private _sessions = new Map<string, ReplaySession>();

	getOrCreateSession(sessionId: string): ReplaySession {
		let session = this._sessions.get(sessionId);
		if (!session) {
			// Parse the session ID to get the replay data
			const replayData = parseReplayFromSessionId(sessionId);
			session = new ReplaySession(sessionId, replayData.filePath, replayData.chatSteps);
			this._sessions.set(sessionId, session);
		}
		return session;
	}

	CreateNewSession(sessionId: string): ReplaySession {
		let session = this._sessions.get(sessionId);
		if (session) {
			session.dispose();
			this._sessions.delete(sessionId);
		}

		// Parse the session ID to get the replay data
		const replayData = parseReplayFromSessionId(sessionId);
		session = new ReplaySession(sessionId, replayData.filePath, replayData.chatSteps);
		this._sessions.set(sessionId, session);
		return session;
	}

	getSession(sessionId: string): ReplaySession | undefined {
		return this._sessions.get(sessionId);
	}

	hasSession(sessionId: string): boolean {
		return this._sessions.has(sessionId);
	}

	removeSession(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.dispose();
			this._sessions.delete(sessionId);
		}
	}

	dispose(): void {
		for (const session of this._sessions.values()) {
			session.dispose();
		}
		this._sessions.clear();
	}
}
