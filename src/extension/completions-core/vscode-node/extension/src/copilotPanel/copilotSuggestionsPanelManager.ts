/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TextDocument, WebviewPanel } from 'vscode';
import type { ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { IPosition, ITextDocument } from '../../../lib/src/textDocument';
import { BaseSuggestionsPanelManager, ListDocumentInterface } from '../panelShared/baseSuggestionsPanelManager';
import { PanelCompletion } from './common';
import { CopilotListDocument } from './copilotListDocument';
import { CopilotSuggestionsPanel } from './copilotSuggestionsPanel';
import { copilotPanelConfig } from './panelConfig';

export class CopilotSuggestionsPanelManager extends BaseSuggestionsPanelManager<PanelCompletion> {
	constructor(accessor: ServicesAccessor) {
		super(accessor, copilotPanelConfig);
	}

	protected createListDocument(
		accessor: ServicesAccessor,
		wrapped: ITextDocument,
		position: IPosition,
		panel: CopilotSuggestionsPanel
	): ListDocumentInterface {
		return new CopilotListDocument(accessor, wrapped, position, panel);
	}

	protected createSuggestionsPanel(
		accessor: ServicesAccessor,
		panel: WebviewPanel,
		document: TextDocument,
		manager: this
	): CopilotSuggestionsPanel {
		return new CopilotSuggestionsPanel(accessor, panel, document, manager);
	}
}
