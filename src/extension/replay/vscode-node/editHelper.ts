/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChatResponseStream, Range, Uri, WorkspaceEdit } from 'vscode';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { FileEdits, Replacement } from '../common/chatReplayResponses';

export class EditHelper {
	constructor(private readonly workspaceService: IWorkspaceService) { }

	public async makeEdit(edits: FileEdits, stream: ChatResponseStream) {
		let uri: Uri;
		if (!edits.path.startsWith('/') && !edits.path.match(/^[a-zA-Z]:/)) {
			// Relative path - join with first workspace folder
			const workspaceFolders = this.workspaceService.getWorkspaceFolders();
			if (workspaceFolders.length > 0) {
				uri = Uri.joinPath(workspaceFolders[0], edits.path);
			} else {
				throw new Error('No workspace folder available to resolve relative path: ' + edits.path);
			}
		} else {
			// Absolute path
			uri = Uri.file(edits.path);
		}

		await this.ensureFileExists(uri);

		stream.markdown('\n```\n');
		stream.codeblockUri(uri, true);
		await Promise.all(edits.edits.replacements.map(r => this.performReplacement(uri, r, stream)));
		stream.textEdit(uri, true);
		stream.markdown('\n' + '```\n');
	}

	private async ensureFileExists(uri: Uri): Promise<void> {
		try {
			await this.workspaceService.fs.stat(uri);
			return; // Exists
		} catch {
			// Create parent directory and empty file
			const parent = Uri.joinPath(uri, '..');
			await this.workspaceService.fs.createDirectory(parent);
			await this.workspaceService.fs.writeFile(uri, new Uint8Array());
		}
	}

	private async performReplacement(uri: Uri, replacement: Replacement, stream: ChatResponseStream) {
		const doc = await this.workspaceService.openTextDocument(uri);
		const workspaceEdit = new WorkspaceEdit();
		const range = new Range(
			doc.positionAt(replacement.replaceRange.start),
			doc.positionAt(replacement.replaceRange.endExclusive)
		);

		workspaceEdit.replace(uri, range, replacement.newText);

		for (const textEdit of workspaceEdit.entries()) {
			const edits = Array.isArray(textEdit[1]) ? textEdit[1] : [textEdit[1]];
			for (const textEdit of edits) {
				try {
					stream.textEdit(uri, textEdit);
				} catch (error) {
					stream.markdown(`Failed to apply text edit: ${error.message}`);
				}
			}
		}
	}
}