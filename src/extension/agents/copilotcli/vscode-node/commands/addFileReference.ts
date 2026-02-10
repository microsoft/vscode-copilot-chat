/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as l10n from '@vscode/l10n';
import { ILogger } from '../../../../../platform/log/common/logService';
import { ICopilotCLISessionTracker } from '../copilotCLISessionTracker';
import { InProcHttpServer } from '../inProcHttpServer';
import { getSelectionInfo } from '../tools';
import { pickSession } from './pickSession';

export interface FileReferenceInfo {
	filePath: string;
	fileUrl: string;
	selection: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	} | null;
	selectedText: string | null;
}

export const ADD_FILE_REFERENCE_COMMAND = 'github.copilot.chat.copilotCLI.addFileReference';
export const ADD_FILE_REFERENCE_NOTIFICATION = 'add_file_reference';

export function registerAddFileReferenceCommand(logger: ILogger, httpServer: InProcHttpServer, sessionTracker: ICopilotCLISessionTracker): vscode.Disposable {
	return vscode.commands.registerCommand(ADD_FILE_REFERENCE_COMMAND, async (uri?: vscode.Uri) => {
		logger.debug('Add file reference command executed');

		const sessionId = await pickSession(logger, httpServer, sessionTracker);
		if (!sessionId) {
			return;
		}

		// If URI is provided (from explorer context menu), use it directly
		if (uri) {
			const fileReferenceInfo: FileReferenceInfo = {
				filePath: uri.fsPath,
				fileUrl: uri.toString(),
				selection: null,
				selectedText: null,
			};

			logger.info(`Sending file reference from explorer to session ${sessionId}: ${uri.fsPath}`);
			httpServer.sendNotification(
				sessionId,
				ADD_FILE_REFERENCE_NOTIFICATION,
				fileReferenceInfo as unknown as Record<string, unknown>,
			);
			return;
		}

		// Otherwise, use the active editor
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			logger.debug('No active editor for file reference');
			vscode.window.showWarningMessage(l10n.t('No active editor. Open a file to add a reference.'));
			return;
		}

		const selectionInfo = getSelectionInfo(editor);

		const fileReferenceInfo: FileReferenceInfo = {
			filePath: selectionInfo.filePath,
			fileUrl: selectionInfo.fileUrl,
			selection: selectionInfo.selection.isEmpty
				? null
				: {
					start: selectionInfo.selection.start,
					end: selectionInfo.selection.end,
				},
			selectedText: selectionInfo.selection.isEmpty ? null : selectionInfo.text,
		};

		logger.info(`Sending file reference to session ${sessionId}: ${selectionInfo.filePath}`);
		httpServer.sendNotification(sessionId, ADD_FILE_REFERENCE_NOTIFICATION, fileReferenceInfo as unknown as Record<string, unknown>);
	});
}
