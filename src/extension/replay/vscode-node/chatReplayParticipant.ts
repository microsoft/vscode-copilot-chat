/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { raceCancellation } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Range, Uri, WorkspaceEdit } from '../../../vscodeTypes';
import { ChatReplayResponses, ChatStep, FileEdits, Replacement } from '../../replay/common/chatReplayResponses';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';

export class ChatReplayParticipant {

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IToolsService private readonly toolsService: IToolsService
	) { }

	async handleRequest(request: vscode.ChatRequest, context: vscode.ChatContext, response: vscode.ChatResponseStream, token: CancellationToken): Promise<vscode.ChatResult> {
		const replay = ChatReplayResponses.getInstance();
		let res = await raceCancellation(replay.getResponse(), token);

		while (res && res !== 'finished') {
			// Stop processing if cancelled
			await raceCancellation(this.processStep(res, replay, response, request.toolInvocationToken), token);
			res = await raceCancellation(replay.getResponse(), token);
		}

		if (token.isCancellationRequested) {
			replay.cancelReplay();
		}

		return {};
	}

	private async processStep(step: ChatStep, replay: ChatReplayResponses, stream: vscode.ChatResponseStream, toolToken: vscode.ChatParticipantToolToken): Promise<void> {
		switch (step.kind) {
			case 'userQuery':
				stream.markdown(`\n\n---\n\n## User Query:\n\n${step.query}\n\n`);
				stream.markdown(`## Response:\n\n---\n`);
				break;
			case 'request':
				stream.markdown(`\n\n${step.result}`);
				break;
			case 'toolCall':
				{
					replay.setToolResult(step.id, step.results);
					const result = await this.toolsService.invokeTool(ToolName.ToolReplay,
						{
							toolInvocationToken: toolToken,
							input: {
								toolCallId: step.id,
								toolName: step.toolName,
								toolCallArgs: step.args
							}
						}, CancellationToken.None);
					if (result.content.length === 0) {
						stream.markdown(l10n.t('No result from tool'));
					}

					if (step.edits) {
						await Promise.all(step.edits.map(edit => this.makeEdit(edit, stream)));
					}
					break;
				}
		}
	}

	private async makeEdit(edits: FileEdits, stream: vscode.ChatResponseStream) {
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

	private async performReplacement(uri: Uri, replacement: Replacement, stream: vscode.ChatResponseStream) {
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
				stream.textEdit(uri, textEdit);
			}
		}
	}

}

