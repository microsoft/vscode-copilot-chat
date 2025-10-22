/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken } from '../../types/src';
import { apiVersion, EditorSession, editorVersionHeaders } from './config';
import { Context } from './context';
import { telemetry, TelemetryData } from './telemetry';

/**
 * CIRCULAR DEPENDENCY FIX - PROGRESSIVE REFACTORING
 *
 * This module was refactored to resolve a circular dependency that caused runtime errors:
 *
 * Previous circular dependency chain:
 * networking.ts â†’ config.ts â†’ features.ts â†’ copilotTokenManager.ts â†’ copilotToken.ts â†’ github.ts â†’ networking.ts
 *
 * The issue:
 * - networking.ts defined FetchResponseError and other error classes
 * - network/github.ts needed FetchResponseError, so imported from networking.ts
 * - But networking.ts indirectly depended on github.ts through the config chain
 * - This caused "Cannot access 'FetchResponseError' before initialization" runtime error
 *
 * Solution - Module Separation:
 * 1. Extracted all error classes and types to '#lib/networking/networkingTypes'
 * 2. github.ts now imports FetchResponseError directly from the types module
 * 3. This breaks the circular dependency while preserving functionality
 * 4. No more dynamic imports needed since errors and types are in the same module
 *
 * Progressive Refactoring Strategy:
 * - Re-export everything from the new module to maintain API compatibility
 * - 22+ files across the codebase import from './networking' and expect these exports
 * - This approach allows internal restructuring without breaking existing imports
 * - Future: Could gradually migrate files to import directly from networkingTypes module
 */

// Re-export everything from networking types module for backward compatibility
export * from './networkingTypes';

// Import what we need locally for this module's implementation
import { FetchOptions, ReqHeaders, Response } from './networkingTypes';

/**
 * Encapsulates all the functionality related to making GET/POST/DELETE requests using
 * different libraries (and in the future, different environments like web vs
 * node).
 */
export abstract class Fetcher {
	abstract readonly name: string;
	/**
	 * Returns the real implementation, not a delegator.  Used by diagnostics to ensure the fetcher name and all
	 * reachability checks are aligned.
	 */
	getImplementation(): Fetcher | Promise<Fetcher> {
		return this;
	}
	abstract fetch(url: string, options: FetchOptions): Promise<Response>;
	abstract disconnectAll(): Promise<unknown>;
}

export function postRequest(
	ctx: Context,
	url: string,
	secretKey: string,
	intent: string | undefined, // Must be passed in, even if explicitly `undefined`
	requestId: string,
	body?: Record<string, unknown>,
	cancelToken?: CancellationToken,
	extraHeaders?: Record<string, string>,
	timeout?: number,
	modelProviderName?: string
): Promise<Response> {
	const headers: ReqHeaders = {
		...extraHeaders,
		Authorization: `Bearer ${secretKey}`,
		...editorVersionHeaders(ctx),
	};

	// If we call byok endpoint, no need to add these headers
	if (modelProviderName === undefined) {
		headers['Openai-Organization'] = 'github-copilot';
		headers['X-Request-Id'] = requestId;
		headers['VScode-SessionId'] = ctx.get(EditorSession).sessionId;
		headers['VScode-MachineId'] = ctx.get(EditorSession).machineId;
		headers['X-GitHub-Api-Version'] = apiVersion;
	}

	if (intent) {
		headers['OpenAI-Intent'] = intent;
	}

	const request: FetchOptions = {
		method: 'POST',
		headers: headers,
		json: body,
		timeout,
	};

	const fetcher = ctx.get(Fetcher);
	if (cancelToken) {
		const abort = new AbortController();
		cancelToken.onCancellationRequested(() => {
			// abort the request when the token is canceled
			telemetry(
				ctx,
				'networking.cancelRequest',
				TelemetryData.createAndMarkAsIssued({ headerRequestId: requestId })
			);
			abort.abort();
		});
		// pass the controller abort signal to the request
		request.signal = abort.signal;
	}

	const requestPromise = fetcher.fetch(url, request).catch((reason: unknown) => {
		if (isInterruptedNetworkError(reason)) {
			// disconnect and retry the request once if the connection was reset
			telemetry(ctx, 'networking.disconnectAll');
			return fetcher.disconnectAll().then(() => {
				return fetcher.fetch(url, request);
			});
		} else {
			throw reason;
		}
	});
	return requestPromise;
}

function isInterruptedNetworkError(error: unknown): boolean {
	if (!(error instanceof Error)) { return false; }
	if (error.message === 'ERR_HTTP2_GOAWAY_SESSION') { return true; }
	if (!('code' in error)) { return false; }
	return error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ERR_HTTP2_INVALID_SESSION';
}
