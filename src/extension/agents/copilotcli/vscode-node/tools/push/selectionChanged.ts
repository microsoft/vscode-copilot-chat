/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { broadcastNotification } from '../../inProcHttpServer';
import { getSelectionInfo, updateLatestSelection } from '../getSelection';
import { ILogger } from '../../../../../../platform/log/common/logService';

export function registerSelectionChangedNotification(logger: ILogger): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const handleSelectionChange = (event: vscode.TextEditorSelectionChangeEvent) => {
		if (debounceTimer !== undefined) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			const selectionInfo = getSelectionInfo(event.textEditor);
			updateLatestSelection(selectionInfo);
			logger.trace(`Selection changed in: ${selectionInfo.filePath}`);
			broadcastNotification('selection_changed', selectionInfo as unknown as Record<string, unknown>);
		}, 200);
	};

	disposables.push(vscode.window.onDidChangeTextEditorSelection(handleSelectionChange));

	// Initialize with current selection if there's an active editor
	if (vscode.window.activeTextEditor) {
		updateLatestSelection(getSelectionInfo(vscode.window.activeTextEditor));
	}

	logger.debug('Registered selection change notification');
	return disposables;
}
