/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeTextResult } from './utils';
import { ILogger } from '../../../../../platform/log/common/logService';

interface SelectionInfo {
	text: string;
	filePath: string;
	fileUrl: string;
	selection: {
		start: { line: number; character: number };
		end: { line: number; character: number };
		isEmpty: boolean;
	};
}

let latestSelection: SelectionInfo | null = null;

export function getSelectionInfo(editor: vscode.TextEditor): SelectionInfo {
	const document = editor.document;
	const selection = editor.selection;
	const text = document.getText(selection);

	return {
		text,
		filePath: document.uri.fsPath,
		fileUrl: document.uri.toString(),
		selection: {
			start: { line: selection.start.line, character: selection.start.character },
			end: { line: selection.end.line, character: selection.end.character },
			isEmpty: selection.isEmpty,
		},
	};
}

export function updateLatestSelection(selection: SelectionInfo | null): void {
	latestSelection = selection;
}

export function getLatestSelection(): SelectionInfo | null {
	return latestSelection;
}

export function registerGetSelectionTool(server: McpServer, logger: ILogger): void {
	server.tool('get_selection', 'Get text selection. Returns current selection if an editor is active, otherwise returns the latest cached selection. The "current" field indicates if this is from the active editor (true) or cached (false).', async () => {
		logger.debug('Getting text selection');
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const selectionInfo = getSelectionInfo(editor);
			logger.trace(`Returning current selection from: ${selectionInfo.filePath}`);
			return makeTextResult({ ...selectionInfo, current: true });
		}
		if (latestSelection) {
			logger.trace(`Returning cached selection from: ${latestSelection.filePath}`);
			return makeTextResult({ ...latestSelection, current: false });
		}
		logger.trace('No selection available');
		return makeTextResult(null);
	});
}
