/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CompletionState } from './completionState';
import { Context } from './context';
import { GetGhostTextOptions } from './ghostText/ghostText';
import { telemetryCatch, TelemetryWithExp } from './telemetry';
import { CancellationToken, Disposable } from '../../types/src';
import EventEmitter from 'events';

type CompletionRequestedEvent = {
	completionId: string;
	completionState: CompletionState;
	telemetryData: TelemetryWithExp;
	cancellationToken?: CancellationToken;
	options?: Partial<GetGhostTextOptions>;
};

const requestEventName = 'CompletionRequested';

export class CompletionNotifier {
	#emitter = new EventEmitter();
	constructor(protected ctx: Context) { }

	notifyRequest(
		completionState: CompletionState,
		completionId: string,
		telemetryData: TelemetryWithExp,
		cancellationToken?: CancellationToken,
		options?: Partial<GetGhostTextOptions>
	) {
		return this.#emitter.emit(requestEventName, {
			completionId,
			completionState,
			telemetryData,
			cancellationToken,
			options,
		});
	}

	onRequest(listener: (event: CompletionRequestedEvent) => void): Disposable {
		const wrapper = telemetryCatch(this.ctx, listener, `event.${requestEventName}`);
		this.#emitter.on(requestEventName, wrapper);
		return Disposable.create(() => this.#emitter.off(requestEventName, wrapper));
	}
}
