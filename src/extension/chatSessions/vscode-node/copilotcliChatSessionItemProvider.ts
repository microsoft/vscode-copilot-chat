/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { ICopilotCLISessionService } from '../../agents/copilotcli/node/copilotcliSessionService';

export class CopilotCLIChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {
	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;

	constructor(
		@ICopilotCLISessionService private readonly copilotcliSessionService: ICopilotCLISessionService
	) {
		super();
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	public swap(original: vscode.ChatSessionItem, modified: vscode.ChatSessionItem): void {
		this._onDidCommitChatSessionItem.fire({ original, modified });
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const sessions = await this.copilotcliSessionService.getAllSessions(token);
		const diskSessions = sessions.map(session => ({
			id: session.id,
			label: session.label,
			tooltip: `CopilotCLI session: ${session.label}`,
			timing: {
				startTime: session.timestamp.getTime()
			},
			iconPath: new vscode.ThemeIcon('terminal')
		} satisfies vscode.ChatSessionItem));

		return diskSessions;
	}
}
