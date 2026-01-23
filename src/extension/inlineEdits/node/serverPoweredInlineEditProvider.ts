/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { Permutation } from '../../../platform/inlineEdits/common/dataTypes/permutation';
import { InlineEditRequestLogContext } from '../../../platform/inlineEdits/common/inlineEditLogContext';
import { ISerializedNextEditRequest, IStatelessNextEditProvider, NoNextEditReason, PushEdit, StatelessNextEditRequest, StatelessNextEditResult, StatelessNextEditTelemetryBuilder } from '../../../platform/inlineEdits/common/statelessNextEditProvider';
import { fromUnknown } from '../../../util/common/errors';
import { Result } from '../../../util/common/result';
import { ITracer } from '../../../util/common/tracing';
import { assert } from '../../../util/vs/base/common/assert';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LineEdit, LineReplacement, SerializedLineReplacement } from '../../../util/vs/editor/common/core/edits/lineEdit';

type SerializedRequest = ISerializedNextEditRequest;

type SerializedResponse = {
	edits: SerializedLineReplacement[];
	/**
	 * The prompt sent to the LLM.
	 */
	user_prompt: string;
	/**
	 * The response of LLM reported by the server.
	 */
	model_response: string;
};

export namespace SerializedServerResponse {
	export function isSerializedServerResponse(thing: unknown): thing is SerializedResponse {
		return !!(thing && typeof thing === 'object' &&
			'edits' in thing && Array.isArray(thing.edits) && thing.edits.every((e: unknown) => SerializedLineReplacement.is(e)) &&
			'user_prompt' in thing && typeof thing.user_prompt === 'string' &&
			'model_response' in thing && typeof thing.model_response === 'string'
		);
	}
}

export class ServerPoweredInlineEditProvider implements IStatelessNextEditProvider {
	public static readonly ID = 'ServerPoweredInlineEditProvider';

	public readonly ID: string = ServerPoweredInlineEditProvider.ID;

	constructor(
		@IChatMLFetcher private readonly fetcher: IChatMLFetcher,
	) {
	}

	async provideNextEdit(request: StatelessNextEditRequest, pushEdit: PushEdit, _tracer: ITracer, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken): Promise<StatelessNextEditResult> {

		const telemetryBuilder = new StatelessNextEditTelemetryBuilder(request);

		const serializedRequest: SerializedRequest = request.serialize();

		const requestAsJson = JSON.stringify(serializedRequest, null, 2);

		this.logContextRequest(JSON.stringify(requestAsJson), logContext);

		const abortCtrl = new AbortController();
		const fetchDisposable = cancellationToken.onCancellationRequested(() => abortCtrl.abort());

		let r: Response;
		try {
			r = await fetch('http://localhost:8001', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: requestAsJson,
				signal: abortCtrl.signal,
			});
		} catch (e: unknown) {
			logContext.setError(e);
			if (e instanceof Error) {
				if (e.message === 'AbortError') {
					return StatelessNextEditResult.noEdit(new NoNextEditReason.GotCancelled('afterFetchCall'), telemetryBuilder);
				}
				return StatelessNextEditResult.noEdit(new NoNextEditReason.FetchFailure(e), telemetryBuilder);
			}
			return StatelessNextEditResult.noEdit(new NoNextEditReason.FetchFailure(fromUnknown(e)), telemetryBuilder);
		} finally {
			fetchDisposable.dispose();
		}

		if (r.status === 200) {
			const response: unknown = await r.json();
			assert(SerializedServerResponse.isSerializedServerResponse(response), 'Invalid server response format: ' + JSON.stringify(response, null, 2));
			this.spyOnPromptAndResponse(this.fetcher, { user_prompt: response.user_prompt, model_response: response.model_response });
			this.logContextResponse(response, logContext);
			const edits = response.edits.map(e => LineReplacement.deserialize(e));
			const sortingPermutation = Permutation.createSortPermutation(edits, (a, b) => a.lineRange.startLineNumber - b.lineRange.startLineNumber);
			const lineEdit = new LineEdit(sortingPermutation.apply(edits));
			lineEdit.replacements.forEach(edit => pushEdit(Result.ok({ edit, isFromCursorJump: false })));
			pushEdit(Result.error(new NoNextEditReason.NoSuggestions(request.documentBeforeEdits, undefined)));
			return StatelessNextEditResult.streaming(telemetryBuilder);
		} else {
			const errorPayload = {
				code: r.status,
				message: r.statusText,
				response: await r.text(),
			};
			const errMsg = `Fetch errored: ${JSON.stringify(errorPayload, null, 2)}`;
			const error = new Error(errMsg);
			logContext.setError(error);
			return StatelessNextEditResult.noEdit(new NoNextEditReason.FetchFailure(error), telemetryBuilder);
		}
	}

	protected spyOnPromptAndResponse(fetcher: IChatMLFetcher, { user_prompt, model_response }: { user_prompt: string; model_response: string }) {
		// no-op
	}

	private logContextRequest(request: string, logContext: InlineEditRequestLogContext) {
		logContext.addLog('<details>');
		logContext.addLog('<summary>Request</summary>');
		logContext.addLog('~~~');
		logContext.addLog(request);
		logContext.addLog('~~~');
		logContext.addLog('</details>');
	}

	private logContextResponse(response: SerializedResponse, logContext: InlineEditRequestLogContext) {
		logContext.addLog('<details>');
		logContext.addLog('<summary>Response</summary>');
		logContext.addLog('~~~');
		logContext.addLog(JSON.stringify(response, null, 2));
		logContext.addLog('~~~');
		logContext.addLog('</details>');
	}
}
