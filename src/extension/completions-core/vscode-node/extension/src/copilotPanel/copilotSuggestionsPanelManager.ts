/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TextDocument, WebviewPanel } from 'vscode';
import { Context } from '../../../lib/src/context';
import { IPosition, ITextDocument } from '../../../lib/src/textDocument';
import { BaseSuggestionsPanelManager, ListDocumentInterface } from '../panelShared/baseSuggestionsPanelManager';
import { PanelCompletion } from './common';
import { CopilotListDocument } from './copilotListDocument';
import { CopilotSuggestionsPanel } from './copilotSuggestionsPanel';
import { copilotPanelConfig } from './panelConfig';

export class CopilotSuggestionsPanelManager extends BaseSuggestionsPanelManager<PanelCompletion> {
	constructor(ctx: Context) {
		super(ctx, copilotPanelConfig);
	}

	protected createListDocument(
		ctx: Context,
		wrapped: ITextDocument,
		position: IPosition,
		panel: CopilotSuggestionsPanel
	): ListDocumentInterface {
		return new CopilotListDocument(ctx, wrapped, position, panel);
	}

	protected createSuggestionsPanel(
		ctx: Context,
		panel: WebviewPanel,
		document: TextDocument,
		manager: this
	): CopilotSuggestionsPanel {
		return new CopilotSuggestionsPanel(ctx, panel, document, manager);
	}
}
