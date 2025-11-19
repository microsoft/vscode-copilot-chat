/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IDisposable } from '../../../../util/vs/base/common/lifecycle';
import { renameSymbolCommandId } from '../../common/renameSymbol';

export class RenameSymbolRecorder implements IDisposable {

	private changeListener: IDisposable;

	private previousRenames: { oldName: string; newName: string }[];

	constructor() {
		this.previousRenames = [];
		this.changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length === 0) {
				return;
			}
			if (event.detailedReason !== undefined && event.detailedReason.source === 'rename') {
				if (this.previousRenames.length > 32) {
					this.previousRenames.shift();
				}
				const oldName = event.detailedReason.metadata.$$$oldName;
				const newName = event.detailedReason.metadata.$$$newName;
				if (this.previousRenames.length === 0) {
					this.previousRenames.push({ oldName, newName });
				} else {
					const lastRename = this.previousRenames[this.previousRenames.length - 1];
					if (lastRename.oldName !== oldName || lastRename.newName !== newName) {
						this.previousRenames.push({ oldName, newName });
					}
				}
			}
		});
	}

	public dispose(): void {
		this.changeListener.dispose();
	}

	public async proposeRenameRefactoring(document: vscode.TextDocument, position: vscode.Position, completionItem: vscode.InlineCompletionItem): Promise<void> {
		const nesRange = completionItem.range;
		if (nesRange === undefined || nesRange.start.line !== nesRange.end.line) {
			return;
		}
		const tokenInfo = await vscode.languages.getTokenInformationAtPosition(document, nesRange.start);
		if (tokenInfo.type !== vscode.StandardTokenType.Other) {
			return;
		}
		const oldName = document.getText(tokenInfo.range);
		const line = document.lineAt(nesRange.start.line);
		const newName = line.text.substring(nesRange.start.character, nesRange.end.character);

		const command: vscode.Command = {
			command: renameSymbolCommandId,
			title: `Rename ${oldName} to ${newName}`,
			arguments: []
		};
		completionItem.command = command;
	}
}