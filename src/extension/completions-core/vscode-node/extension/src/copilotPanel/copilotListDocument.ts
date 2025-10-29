/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Context } from '../../../lib/src/context';
import { IPosition, ITextDocument } from '../../../lib/src/textDocument';
import { solutionCountTarget } from '../lib/copilotPanel/common';
import { runSolutions } from '../lib/copilotPanel/panel';
import { UnformattedSolution } from '../lib/panelShared/panelTypes';
import { BaseListDocument } from '../panelShared/baseListDocument';
import { BasePanelCompletion, ISuggestionsPanel } from '../panelShared/basePanelTypes';
import { PanelCompletion } from './common';

/**
 * Class representing a Open Copilot list using a ITextDocument as a way of displaying results.
 * Currently only used in the VSCode extension.
 */
export class CopilotListDocument extends BaseListDocument<PanelCompletion> {
	constructor(
		ctx: Context,
		textDocument: ITextDocument,
		position: IPosition,
		panel: ISuggestionsPanel,
		countTarget = solutionCountTarget
	) {
		super(ctx, textDocument, position, panel, countTarget);
	}

	protected createPanelCompletion(
		unformatted: UnformattedSolution,
		baseCompletion: BasePanelCompletion
	): PanelCompletion {
		return {
			insertText: baseCompletion.insertText,
			range: baseCompletion.range,
			copilotAnnotations: baseCompletion.copilotAnnotations,
			postInsertionCallback: baseCompletion.postInsertionCallback,
		};
	}

	protected shouldAddSolution(newItem: PanelCompletion): boolean {
		return !this.findDuplicateSolution(newItem);
	}

	protected runSolutionsImpl(): Promise<void> {
		return runSolutions(this._ctx, this, this);
	}
}
