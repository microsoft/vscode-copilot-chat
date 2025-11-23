/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Position, Range, SnippetString, TextEdit, type TextDocument } from 'vscode';
import { CharSequence, LcsDiff } from '../../../../util/common/diff';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { renameSymbolCommandId } from '../../common/renameSymbol';

type PrepareResult = Range | { range: Range; placeholder: string };

type SingleEdits = {
	renames: { edits: TextEdit[]; position: Position; oldName: string; newName: string };
	others: { edits: TextEdit[] };
}

export class RenameSymbolRecorder extends Disposable {

	private previousRenames: { oldName: string; newName: string }[];

	constructor() {
		super();
		this.previousRenames = [];
		this._register(vscode.workspace.onDidChangeTextDocument((event) => {
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
		}));
		this._register(vscode.commands.registerCommand(renameSymbolCommandId, async (document: TextDocument, position: Position, oldName: string, newName: string) => {
			try {
				// This code has to move to core. When the InlineCompletionItem hints to a refactoring then the core should execute
				// the prepare rename. If it fails it should execute the normal proposed edit. If it succeeds it can present a UI
				// to let the user choose between the normal completion item or the refactoring rename.
				const prepare = await vscode.commands.executeCommand<PrepareResult>(`vscode.prepareRename`, document.uri, position);
				if (prepare === undefined || prepare === null) {
					return;
				}
				if (!(prepare instanceof Range) && prepare.placeholder !== oldName) {
					return;
				}
			} catch (error) {
				// The prepare rename can fail if the position is not valid for renaming.
				return;
			}

			try {
				const result = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined | null>('vscode.executeDocumentRenameProvider', document.uri, position, newName);
				if (result === undefined || result === null) {
					return;
				}
				vscode.workspace.applyEdit(result as vscode.WorkspaceEdit);
			} catch (error) {
				// The actual rename failed we should log this.
			}
		}));
	}

	public async proposeRenameRefactoring(document: TextDocument, nesPosition: Position, completionItem: vscode.InlineCompletionItem): Promise<void> {
		const nesRange = completionItem.range;
		if (nesRange === undefined || completionItem.insertText instanceof SnippetString) {
			return;
		}

		const edits = await this.createSingleEdits(document, nesRange, completionItem.insertText === undefined ? '' : completionItem.insertText);
		if (edits === undefined || edits.renames.edits.length === 0) {
			console.log('No renames detected');
			return;
		}
		const { oldName, newName, position } = edits.renames;
		console.log(`Proposing rename from ${oldName} to ${newName} at ${position.line}:${position.character}`);

		const command: vscode.Command = {
			command: renameSymbolCommandId,
			title: `Rename ${oldName} to ${newName}`,
			arguments: [document, position, oldName, newName],
		};
		completionItem.command = command;
		const pos = new Position(nesRange.start.line, document.lineAt(nesRange.start.line).text.length);
		completionItem.range = new Range(pos, pos);
		completionItem.insertText = ' ';
	}

	private async createSingleEdits(document: vscode.TextDocument, nesRange: vscode.Range, modifiedText: string): Promise<SingleEdits | undefined> {
		const others: TextEdit[] = [];
		const renames: TextEdit[] = [];
		let oldName: string | undefined = undefined;
		let newName: string | undefined = undefined;
		let position: Position | undefined = undefined;

		const originalText = document.getText(nesRange);
		const nesOffset = document.offsetAt(nesRange.start);

		const changes = (new LcsDiff(new CharSequence(originalText), new CharSequence(modifiedText))).ComputeDiff();
		if (changes.length === 0) {
			return undefined;
		}

		let tokenDiff: number = 0;
		for (const change of changes) {
			const startOffset = nesOffset + change.originalStart;
			const startPos = document.positionAt(startOffset);
			const wordRange = document.getWordRangeAtPosition(startPos);
			// If we don't have a word range at the start position of the current document then we
			// don't treat it as as rename assuming that the rename refactoring will fail as well since
			// there can't be an identifier at that position.
			if (wordRange === undefined) {
				return undefined;
			}
			const endOffset = startOffset + change.originalLength;
			const endPos = document.positionAt(endOffset);
			const range = new Range(startPos, endPos);
			const text = modifiedText.substring(change.modifiedStart, change.getModifiedEnd());
			const tokenInfo = await vscode.languages.getTokenInformationAtPosition(document, startPos);
			if (tokenInfo.type === vscode.StandardTokenType.Other) {
				let identifier = document.getText(tokenInfo.range);
				if (oldName === undefined) {
					oldName = identifier;
				} else if (oldName !== identifier) {
					return undefined;
				}
				// We assume that the new name starts at the same position as the old name from a token range perspective.
				const diff = text.length - change.originalLength;
				const tokenStartPos = document.offsetAt(tokenInfo.range.start) - nesOffset + tokenDiff;
				const tokenEndPos = document.offsetAt(tokenInfo.range.end) - nesOffset + tokenDiff;
				identifier = modifiedText.substring(tokenStartPos, tokenEndPos + diff);
				if (newName === undefined) {
					newName = identifier;
				} else if (newName !== identifier) {
					return undefined;
				}
				if (position === undefined) {
					position = tokenInfo.range.start;
				}
				renames.push(new TextEdit(range, text));
				tokenDiff += diff;
			} else {
				others.push(new TextEdit(range, text));
			}
		}
		if (oldName === undefined || newName === undefined || position === undefined) {
			return undefined;
		}
		return {
			renames: { edits: renames, position, oldName, newName }, others: { edits: others }
		};
	}
}