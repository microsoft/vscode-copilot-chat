/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SnippetString } from 'vscode';
import { IDisposable } from '../../../../util/vs/base/common/lifecycle';

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
		if (nesRange === undefined || nesRange.start.line !== nesRange.end.line || completionItem.insertText instanceof SnippetString) {
			return;
		}

		const originalLine = document.lineAt(nesRange.start.line).text;
		const modifiedLine = originalLine.substring(0, nesRange.start.character)
			+ (completionItem.insertText === undefined ? '' : completionItem.insertText)
			+ originalLine.substring(nesRange.end.character);
		const diff = this.computeDiff(originalLine, modifiedLine);
		if (diff === undefined) {
			return;
		}

		const tokenInfo = await vscode.languages.getTokenInformationAtPosition(document, new vscode.Position(nesRange.start.line, diff.offset));
		if (tokenInfo.type !== vscode.StandardTokenType.Other) {
			return;
		}
		const tokenRange = tokenInfo.range;
		if (tokenRange.start.line !== tokenRange.end.line || !nesRange.contains(tokenRange)) {
			return;
		}

		const oldName = originalLine.substring(diff.offset, diff.offset + diff.length);
		const newName = diff.text;
		console.log(`Proposing rename from '${oldName}' to '${newName}'`);
		// const command: vscode.Command = {
		// 	command: renameSymbolCommandId,
		// 	title: `Rename ${oldName} to ${newName}`,
		// 	arguments: []
		// };
		// completionItem.command = command;
	}

	private computeDiff(original: string, modified: string): { offset: number; length: number; text: string } | undefined {
		const len1 = original.length;
		const len2 = modified.length;
		let idx1 = 0;
		let idx2 = 0;
		let firstDiff: { offset: number; length: number; text: string } | undefined = undefined;

		while (idx1 < len1 || idx2 < len2) {
			// 1. Skip common prefix
			while (idx1 < len1 && idx2 < len2 && original.charCodeAt(idx1) === modified.charCodeAt(idx2)) {
				idx1++;
				idx2++;
			}

			if (idx1 === len1 && idx2 === len2) {
				break;
			}

			// 2. Find next sync point
			let syncOffset1 = 0;
			let syncOffset2 = 0;
			let foundSync = false;

			const limit = (len1 - idx1) + (len2 - idx2);

			searchLoop:
			for (let dist = 0; dist <= limit; dist++) {
				// Try all combinations of (o1, o2) such that o1 + o2 = dist
				for (let o1 = 0; o1 <= dist; o1++) {
					const o2 = dist - o1;
					if (idx1 + o1 < len1 && idx2 + o2 < len2) {
						if (original.charCodeAt(idx1 + o1) === modified.charCodeAt(idx2 + o2)) {
							syncOffset1 = o1;
							syncOffset2 = o2;
							foundSync = true;
							break searchLoop;
						}
					} else if (idx1 + o1 === len1 && idx2 + o2 === len2) {
						// Reached end of both simultaneously - valid sync at end
						syncOffset1 = o1;
						syncOffset2 = o2;
						foundSync = true;
						break searchLoop;
					}
				}
			}

			if (!foundSync) {
				// Should not happen given the loop bounds, but as a fallback
				syncOffset1 = len1 - idx1;
				syncOffset2 = len2 - idx2;
			}

			const diffOriginal = original.substring(idx1, idx1 + syncOffset1);
			const diffModified = modified.substring(idx2, idx2 + syncOffset2);

			if (firstDiff === undefined) {
				firstDiff = { offset: idx1, length: syncOffset1, text: diffModified };
			} else {
				// Check if this diff is the same as the first one
				const firstOriginal = original.substring(firstDiff.offset, firstDiff.offset + firstDiff.length);
				if (diffOriginal !== firstOriginal || diffModified !== firstDiff.text) {
					return undefined;
				}
			}

			idx1 += syncOffset1;
			idx2 += syncOffset2;
		}

		return firstDiff;
	}
}