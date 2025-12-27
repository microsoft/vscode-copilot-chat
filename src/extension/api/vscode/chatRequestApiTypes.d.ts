/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type ChatRequestStartStatus = 'started';
export type ChatRequestFinishStatus = 'success' | 'cancelled' | 'error';

/**
 * NOTE: These types intentionally mirror the internal observability event shapes
 * (`IObservabilityService` in `src/platform/observability/common/observabilityService.ts`).
 *
 * They are duplicated here so the *public* extension API can:
 *  - avoid exposing internal module paths/types to external extensions
 *  - remain stable even if internal service types evolve
 *
 * Keep the payload surface minimal to prevent leaking user/request content.
 */

export interface ChatRequestStartedEvent {
	readonly requestId: string;
	readonly result: {
		readonly status: ChatRequestStartStatus;
	};
}

export interface ChatRequestFinishedEvent {
	readonly requestId: string;
	readonly result: {
		readonly status: ChatRequestFinishStatus;
		readonly reason?: string;
	};
}
