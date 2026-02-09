/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

/**
 * Chat session item provider for product growth and user education.
 * Immediately provides a single active session on every reload.
 *
 * The session initially appears without a special status. When the user opens
 * the session, the chat model loads the confirmation part from history, which
 * sets the model state to `NeedsInput`. The content provider then triggers a
 * refresh so the sidebar re-queries items and the `handleSessionModelOverrides`
 * override in VS Code kicks in, setting the visible status to `NeedsInput`.
 */
export class GrowthChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {

	public static readonly sessionType = 'copilot-growth';
	public static readonly sessionId = 'growth-tip';

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;

	private readonly _created = Date.now();

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._logService.info('[GrowthItemProvider] constructor');
	}

	public refresh(): void {
		this._logService.info('[GrowthItemProvider] refresh() — firing onDidChangeChatSessionItems');
		this._onDidChangeChatSessionItems.fire();
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		const item: vscode.ChatSessionItem = {
			resource: GrowthSessionUri.forSessionId(GrowthChatSessionItemProvider.sessionId),
			label: 'Try Copilot',
			description: 'GitHub Copilot is now enabled. Try for free?',
			status: vscode.ChatSessionStatus.NeedsInput,
			timing: {
				created: this._created,
				lastRequestStarted: this._created,
			},
			iconPath: new vscode.ThemeIcon('lightbulb'),
		};
		this._logService.info(`[GrowthItemProvider] provideChatSessionItems() — returning 1 item, resource=${item.resource.toString()}, status=${item.status}`);
		return [item];
	}
}

export namespace GrowthSessionUri {
	export function forSessionId(sessionId: string): vscode.Uri {
		return vscode.Uri.from({ scheme: GrowthChatSessionItemProvider.sessionType, path: '/' + sessionId });
	}

	export function getId(resource: vscode.Uri): string {
		if (resource.scheme !== GrowthChatSessionItemProvider.sessionType) {
			throw new Error('Invalid resource scheme for Growth session');
		}

		return resource.path.slice(1);
	}
}
