/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InlineEditRequestLogContext } from '../../../../platform/inlineEdits/common/inlineEditLogContext';
import { IRequestLogger, LoggedRequestKind } from '../../../../platform/requestLogger/node/requestLogger';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';

export class InlineEditLogger extends Disposable {
	private readonly _requests: InlineEditRequestLogContext[] = [];

	constructor(
		@IRequestLogger private readonly _requestLogger: IRequestLogger,
	) {
		super();
	}

	add(request: InlineEditRequestLogContext): void {
		if (!request.includeInLogTree) {
			return;
		}

		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: request.getDebugName(),
			icon: request.getIcon(),
			startTimeMs: request.time,
			markdownContent: request.toLogDocument(),
		});
		this._requests.push(request);

		if (this._requests.length > 100) {
			this._requests.shift();
		}
	}

	public getRequestById(requestId: number): InlineEditRequestLogContext | undefined {
		return this._requests.find(request => request.requestId === requestId);
	}
}
