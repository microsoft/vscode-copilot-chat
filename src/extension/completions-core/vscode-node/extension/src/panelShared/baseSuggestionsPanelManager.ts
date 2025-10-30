/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { TextDocument, Uri, ViewColumn, WebviewPanel, commands, window } from 'vscode';
import type { ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { ICompletionsContextService } from '../../../lib/src/context';
import { IPosition, ITextDocument } from '../../../lib/src/textDocument';
import { basename } from '../../../lib/src/util/uri';
import { Extension } from '../extensionContext';
import { registerCommandWrapper } from '../telemetry';
import { BasePanelCompletion, PanelConfig } from './basePanelTypes';
import { BaseSuggestionsPanel, SuggestionsPanelManagerInterface } from './baseSuggestionsPanel';

export interface ListDocumentInterface {
	runQuery(): Promise<void>;
}

export abstract class BaseSuggestionsPanelManager<TPanelCompletion extends BasePanelCompletion>
	implements SuggestionsPanelManagerInterface {
	activeWebviewPanel: BaseSuggestionsPanel<TPanelCompletion> | undefined;
	private _panelCount: number = 0;

	constructor(
		protected readonly _accessor: ServicesAccessor,
		protected readonly config: PanelConfig
	) { }

	protected abstract createListDocument(
		accessor: ServicesAccessor,
		wrapped: ITextDocument,
		position: IPosition,
		panel: BaseSuggestionsPanel<TPanelCompletion>
	): ListDocumentInterface;

	protected abstract createSuggestionsPanel(
		accessor: ServicesAccessor,
		panel: WebviewPanel,
		document: TextDocument,
		manager: this
	): BaseSuggestionsPanel<TPanelCompletion>;

	renderPanel(
		document: TextDocument,
		position: IPosition,
		wrapped: ITextDocument
	): BaseSuggestionsPanel<TPanelCompletion> {
		const title = `${this.config.panelTitle} for ${basename(document.uri.toString()) || document.uri.toString()}`;
		const panel = window.createWebviewPanel(this.config.webviewId, title, ViewColumn.Two, {
			enableScripts: true,
			localResourceRoots: [Uri.joinPath(this._accessor.get(ICompletionsContextService).get(Extension).context.extensionUri, 'dist')],
			retainContextWhenHidden: true,
		});

		const suggestionPanel = this.createSuggestionsPanel(this._accessor, panel, document, this);

		// Listen for the panel disposal event to clear our reference
		suggestionPanel.onDidDispose(() => {
			if (this.activeWebviewPanel === suggestionPanel) {
				this.activeWebviewPanel = undefined;
			}
		});

		void this.createListDocument(this._accessor, wrapped, position, suggestionPanel).runQuery();

		this.activeWebviewPanel = suggestionPanel;
		this._panelCount = this._panelCount + 1;
		return suggestionPanel;
	}

	registerCommands() {
		registerCommandWrapper(this._accessor, this.config.commands.accept, () => {
			return this.activeWebviewPanel?.acceptFocusedSolution();
		});

		registerCommandWrapper(this._accessor, this.config.commands.navigatePrevious, () => {
			return this.activeWebviewPanel?.postMessage({
				command: 'navigatePreviousSolution',
			});
		});

		registerCommandWrapper(this._accessor, this.config.commands.navigateNext, () => {
			return this.activeWebviewPanel?.postMessage({
				command: 'navigateNextSolution',
			});
		});
	}

	decrementPanelCount() {
		this._panelCount = this._panelCount - 1;
		if (this._panelCount === 0) {
			void commands.executeCommand('setContext', this.config.contextVariable, false);
		}
	}
}
