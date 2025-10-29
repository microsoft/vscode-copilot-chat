/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Range, commands, window, type Disposable } from 'vscode';
import type { ServicesAccessor } from '../../../../../../util/vs/platform/instantiation/common/instantiation';
import { ICompletionsContextService } from '../../../lib/src/context';
import { CopilotNamedAnnotationList } from '../../../lib/src/openai/stream';
import * as constants from '../constants';
import { CopilotPanelVisible } from '../constants';
import { registerCommand } from '../telemetry';
import { wrapDoc } from '../textDocumentManager';
import { CopilotSuggestionsPanelManager } from './copilotSuggestionsPanelManager';

// Exported for testing
export enum PanelNavigationType {
	Previous = 'previous',
	Next = 'next',
}

/**
 * This interface contains data associated to a completion displayed in the panel.
 */
export interface PanelCompletion {
	insertText: string;
	range: Range;
	copilotAnnotations?: CopilotNamedAnnotationList;
	postInsertionCallback: () => PromiseLike<void> | void;
}

export function registerPanelSupport(serviceAccessor: ServicesAccessor): Disposable {
	const ctx = serviceAccessor.get<ICompletionsContextService>(ICompletionsContextService);
	const suggestionsPanelManager = new CopilotSuggestionsPanelManager(ctx);

	const result = registerCommand(ctx, constants.CMDOpenPanel, async () => {
		// hide ghost text while opening the generation ui
		await commands.executeCommand('editor.action.inlineSuggest.hide');
		await commandOpenPanel(ctx, suggestionsPanelManager);
	});

	suggestionsPanelManager.registerCommands();
	return result;
}

function commandOpenPanel(ctx: ICompletionsContextService, suggestionsPanelManager: CopilotSuggestionsPanelManager) {
	const editor = window.activeTextEditor;
	if (!editor) { return; }
	const wrapped = wrapDoc(ctx, editor.document);
	if (!wrapped) { return; }

	const { line, character } = editor.selection.active;

	suggestionsPanelManager.renderPanel(editor.document, { line, character }, wrapped);
	return commands.executeCommand('setContext', CopilotPanelVisible, true);
}
