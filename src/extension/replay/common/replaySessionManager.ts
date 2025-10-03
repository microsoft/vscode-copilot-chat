/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../util/vs/base/common/async';
import { ChatStep } from './chatReplayResponses';
import { parseReplayFromSessionId } from './replayParser';

/**
 * Manages a single replay session with async iteration support.
 *
 * The ReplaySession allows both synchronous access to all steps and asynchronous iteration
 * where steps are provided one at a time as the user steps through them in debug mode.
 *
 * Example usage:
 * ```typescript
 * // In debug mode, iterate steps as they become available:
 * const session = sessionManager.getOrCreateSession(sessionId);
 * for await (const step of session) {
 *   console.log('Processing step:', step);
 *   // In another context, call session.stepNext() to advance
 * }
 *
 * // Or manually control stepping:
 * session.stepNext(); // Advances to next step
 * const current = session.currentStep; // Get current step
 *
 * // For non-debug mode, process all steps immediately:
 * session.stepToEnd();
 * const allSteps = session.allSteps;
 * ```
 */
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

	/**
	 * Gets all steps that have been loaded (for backward compatibility)
	 */
	get allSteps(): ChatStep[] {
		return this._allSteps;
	}

	/**
	 * Gets the current step
	 */
	get currentStep(): ChatStep | undefined {
		if (this._currentIndex >= 0 && this._currentIndex < this._allSteps.length) {
			return this._allSteps[this._currentIndex];
		}
		return undefined;
	}

	/**
	 * Gets the total number of steps
	 */
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

	/**
	 * Waits for the next step to be available
	 */
	private async waitForNextStep(): Promise<ChatStep | undefined> {
		if (this._currentIndex < this._allSteps.length) {
			// Create a deferred promise that will be resolved when stepNext is called
			const deferred = new DeferredPromise<ChatStep | undefined>();
			this._pendingRequests.push(deferred);
			return deferred.p;
		}
		return undefined;
	}

	/**
	 * Advances to the next step (called by debug session)
	 */
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

	/**
	 * Advances to a specific step index
	 */
	stepTo(index: number): void {
		while (this._currentIndex < index && this._currentIndex < this._allSteps.length) {
			this.stepNext();
		}
	}

	/**
	 * Resets the session to the beginning
	 */
	reset(): void {
		this._currentIndex = 0;
		// Cancel all pending requests
		while (this._pendingRequests.length > 0) {
			const deferred = this._pendingRequests.shift();
			deferred?.complete(undefined);
		}
	}

	/**
	 * Processes all remaining steps immediately (for non-debug mode)
	 */
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

/**
 * Manages all replay sessions
 */
export class ReplaySessionManager {
	private _sessions = new Map<string, ReplaySession>();

	/**
	 * Gets or creates a replay session
	 */
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

	/**
	 * Creates a new session (disposing any existing session with the same ID)
	 */
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

	/**
	 * Gets an existing session
	 */
	getSession(sessionId: string): ReplaySession | undefined {
		return this._sessions.get(sessionId);
	}

	/**
	 * Checks if a session exists
	 */
	hasSession(sessionId: string): boolean {
		return this._sessions.has(sessionId);
	}

	/**
	 * Removes a session
	 */
	removeSession(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (session) {
			session.dispose();
			this._sessions.delete(sessionId);
		}
	}

	/**
	 * Disposes all sessions
	 */
	dispose(): void {
		for (const session of this._sessions.values()) {
			session.dispose();
		}
		this._sessions.clear();
	}
}
