/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import path from 'node:path';
import type * as vscode from 'vscode';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IWorkspaceService } from '../../../platform/workspace/common/workspaceService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { Position, Range, Uri, WorkspaceEdit } from '../../../vscodeTypes';
import { Intent } from '../../common/constants';
import { Conversation } from '../../prompt/common/conversation';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent, IIntentInvocation, IIntentInvocationContext } from '../../prompt/node/intents';
import { ChatStep, getResponse, setToolResult } from '../../replay/common/responseQueue';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';

export class ChatReplayIntent implements IIntent {

	static readonly ID: Intent = Intent.ChatReplay;

	readonly id: string = ChatReplayIntent.ID;

	readonly description = l10n.t('Replay a previous conversation');

	readonly locations = [ChatLocation.Panel];

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
		@IToolsService private readonly toolsService: IToolsService
	) { }

	invoke(invocationContext: IIntentInvocationContext): Promise<IIntentInvocation> {
		// implement handleRequest ourselves so we can skip implementing this.
		throw new Error('Method not implemented.');
	}

	async handleRequest(conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext | undefined, agentName: string, location: ChatLocation, chatTelemetry: ChatTelemetryBuilder, onPaused: Event<boolean>): Promise<vscode.ChatResult> {

		let res = await getResponse();
		while (res !== 'finished') {
			await this.processStep(res, stream, request.toolInvocationToken);
			res = await getResponse();
		}

		return {};
	}

	private async processStep(step: ChatStep, stream: vscode.ChatResponseStream, toolToken: vscode.ChatParticipantToolToken): Promise<void> {
		switch (step.kind) {
			case 'userQuery':
				stream.markdown(`**User Query:**\n\n${step.query}\n\n`);
				stream.markdown(`**Response:**\n\n`);
				break;
			case 'request':
				stream.markdown(`\n\n${step.result}`);
				break;
			case 'toolCall':
				{
					setToolResult(step.id, step.results);
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
					if (step.fileUpdates && step.fileUpdates.length > 0) {
						step.fileUpdates.forEach(update => {
							const targetPath = path.join(this.workspaceService.getWorkspaceFolders()[0].fsPath, update.path);
							const newContent = update.newContent!;
							makeEdit(targetPath, newContent, stream);
						});
					}
					break;
				}
		}
	}
}

function makeEdit(path: string, newContent: string, stream: vscode.ChatResponseStream) {
	const workspaceEdit = new WorkspaceEdit();
	const uri = Uri.file(path);
	const lineCount = newContent.split('\n').length;
	workspaceEdit.replace(uri, new Range(
		new Position(0, 0),
		new Position(lineCount, 0)
	), newContent);

	for (const textEdit of workspaceEdit.entries()) {
		stream.markdown('\n```\n');
		stream.codeblockUri(textEdit[0], true);

		const edits = Array.isArray(textEdit[1]) ? textEdit[1] : [textEdit[1]];
		for (const textEdit of edits) {
			stream.textEdit(uri, textEdit);
		}

		stream.textEdit(uri, true);
		stream.markdown('\n' + '```\n');
	}
}

