/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { raceCancellation } from '../../../util/vs/base/common/async';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { Range, Uri, WorkspaceEdit } from '../../../vscodeTypes';
import { Intent } from '../../common/constants';
import { Conversation } from '../../prompt/common/conversation';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent, IIntentInvocation, IIntentInvocationContext } from '../../prompt/node/intents';
import { ChatReplayResponses, ChatStep, FileEdits, Replacement } from '../../replay/common/chatReplayResponses';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';

export class ChatReplayIntent implements IIntent {

	static readonly ID: Intent = Intent.ChatReplay;

	readonly id: string = ChatReplayIntent.ID;

	readonly description = l10n.t('Replay a previous conversation');

	readonly locations = [ChatLocation.Panel];

	isListedCapability = false;

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IToolsService private readonly toolsService: IToolsService
	) { }

	invoke(invocationContext: IIntentInvocationContext): Promise<IIntentInvocation> {
		// implement handleRequest ourselves so we can skip implementing this.
		throw new Error('Method not implemented.');
	}

	async handleRequest(conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext | undefined, agentName: string, location: ChatLocation, chatTelemetry: ChatTelemetryBuilder, onPaused: Event<boolean>): Promise<vscode.ChatResult> {
		const replay = ChatReplayResponses.getInstance();
		let res = await raceCancellation(replay.getResponse(), token);

		while (res && res !== 'finished') {
			// Stop processing if cancelled
			await raceCancellation(this.processStep(res, replay, stream, request.toolInvocationToken), token);
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
		const uri = Uri.file(edits.path);
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

