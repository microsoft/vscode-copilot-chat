/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LineReplacement } from '../../../util/vs/editor/common/core/edits/lineEdit';
import { InlineEditRequestLogContext } from './inlineEditLogContext';
import { IStatelessNextEditProvider, PushEdit, StatelessNextEditDocument, StatelessNextEditRequest, StatelessNextEditResult } from './statelessNextEditProvider';

export function chainStatelessNextEditProviders(base: IStatelessNextEditProvider, ...decorators: ((provider: IStatelessNextEditProvider) => IStatelessNextEditProvider)[]): IStatelessNextEditProvider {
	let result: IStatelessNextEditProvider = base;
	for (const decorator of decorators) {
		result = decorator(result);
	}
	return result;
}

export abstract class ChainedStatelessNextEditProvider implements IStatelessNextEditProvider {
	private _impl: IStatelessNextEditProvider;

	constructor(
		public readonly ID: string,
		private readonly _providers: ((next: IStatelessNextEditProvider) => IStatelessNextEditProvider)[],
	) {
		const self: IStatelessNextEditProvider = {
			ID: this.ID,
			provideNextEdit: (request: StatelessNextEditRequest, pushEdit: PushEdit, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken): Promise<StatelessNextEditResult> => {
				return this.provideNextEditBase(request, pushEdit, logContext, cancellationToken);
			}
		};
		this._impl = chainStatelessNextEditProviders(self, ...this._providers);

	}

	public provideNextEdit(request: StatelessNextEditRequest, pushEdit: PushEdit, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken): Promise<StatelessNextEditResult> {
		return this._impl.provideNextEdit(request, pushEdit, logContext, cancellationToken);
	}

	abstract provideNextEditBase(request: StatelessNextEditRequest, pushEdit: PushEdit, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken): Promise<StatelessNextEditResult>;
}

export abstract class EditFilterAspect implements IStatelessNextEditProvider {
	get ID(): string { return this._baseProvider.ID; }

	constructor(
		private readonly _baseProvider: IStatelessNextEditProvider,
	) {
	}

	async provideNextEdit(request: StatelessNextEditRequest, pushEdit: PushEdit, logContext: InlineEditRequestLogContext, cancellationToken: CancellationToken): Promise<StatelessNextEditResult> {
		const filteringPushEdit: PushEdit = (result) => {
			if (result.isError()) {
				pushEdit(result);
				return;
			}
			const { edit } = result.val;
			const filteredEdits = this.filterEdit(request.getActiveDocument(), [edit]);
			if (filteredEdits.length === 0) { // do not invoke pushEdit
				return;
			}
			pushEdit(result);
		};

		return this._baseProvider.provideNextEdit(request, filteringPushEdit, logContext, cancellationToken);
	}

	abstract filterEdit(resultDocument: StatelessNextEditDocument, singleEdits: readonly LineReplacement[]): readonly LineReplacement[];
}

export class IgnoreTriviaWhitespaceChangesAspect extends EditFilterAspect {
	override filterEdit(resultDocument: StatelessNextEditDocument, singleEdits: readonly LineReplacement[]): readonly LineReplacement[] {
		const filteredEdits = singleEdits.filter(e => !this._isWhitespaceOnlyChange(e, resultDocument.documentAfterEditsLines));
		return filteredEdits;
	}

	private _isWhitespaceOnlyChange(edit: LineReplacement, baseLines: string[]): boolean {
		const originalLines = edit.lineRange.toOffsetRange().slice(baseLines);
		const newLines = edit.newLines;

		const isRemoval = newLines.length === 0;

		// is removing empty lines
		if (isRemoval && originalLines.every(line => line.trim() === '')) {
			return true;
		}

		// is adding empty lines
		if (!isRemoval && newLines.every(line => line.trim() === '')) {
			return true;
		}

		if (originalLines.length !== newLines.length) {
			return false;
		}

		for (let i = 0; i < originalLines.length; i++) {
			const originalLine = originalLines[i];
			const newLine = newLines[i];
			if (originalLine.trim() !== newLine.trim()) {
				return false;
			}
		}
		return true;
	}
}
