/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IDisposable } from '../../../../util/vs/base/common/lifecycle';
import { renameSymbolCommandId } from '../../common/renameSymbol';
import { NextEditResult, type IRenameSymbolRecorder } from '../../node/nextEditResult';

export class RenameSymbolRecorder implements IDisposable, IRenameSymbolRecorder {

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

	public proposeRenameRefactoring(result: NextEditResult): void {
		if (result.result === undefined) {
			return;
		}
		const command: vscode.Command = {
			command: renameSymbolCommandId,
			title: `Rename A to B`,
			arguments: []
		};
		result.result.action = command;
	}
}