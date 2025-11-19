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
			if (this.previousRenames.length > 32) {
				this.previousRenames.shift();
			}
		});
	}

	public dispose(): void {
		this.changeListener.dispose();
	}

	public proposeRenameRefactoring(document: vscode.TextDocument, position: vscode.Position, completionItem: vscode.InlineCompletionItem): void {
		const wordRange = document.getWordRangeAtPosition(position);
		if (wordRange === undefined) {
			return;
		}
		const oldName = document.getText(wordRange);
		const range = completionItem.range;
		if (range === undefined || range.start.line !== range.end.line) {
			return;
		}
		const line = document.lineAt(range.start.line);
		const newName = line.text.substring(range.start.character, range.end.character);

		const command: vscode.Command = {
			command: renameSymbolCommandId,
			title: `Rename ${oldName} to ${newName}`,
			arguments: []
		};
		completionItem.command = command;
	}
}