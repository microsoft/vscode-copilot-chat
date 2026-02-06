/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { InProcHttpServer } from '../../inProcHttpServer';
import { getSelectionInfo, SelectionState } from '../getSelection';
import { ILogger } from '../../../../../../platform/log/common/logService';

export function registerSelectionChangedNotification(logger: ILogger, httpServer: InProcHttpServer, selectionState: SelectionState): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];

	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const handleSelectionChange = (event: vscode.TextEditorSelectionChangeEvent) => {
		if (debounceTimer !== undefined) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			const selectionInfo = getSelectionInfo(event.textEditor);
			selectionState.update(selectionInfo);
			logger.trace(`Selection changed in: ${selectionInfo.filePath}`);
			httpServer.broadcastNotification('selection_changed', selectionInfo as unknown as Record<string, unknown>);
		}, 200);
	};

	disposables.push(vscode.window.onDidChangeTextEditorSelection(handleSelectionChange));
	disposables.push(new vscode.Disposable(() => {
		if (debounceTimer !== undefined) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
	}));

	// Initialize with current selection if there's an active editor
	if (vscode.window.activeTextEditor) {
		selectionState.update(getSelectionInfo(vscode.window.activeTextEditor));
	}

	logger.debug('Registered selection change notification');
	return disposables;
}
