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
 * Provides a single session that shows a NeedsInput attention badge
 * until the user opens it, at which point it transitions to Completed.
 */
export class GrowthChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {

	public static readonly sessionType = 'copilot-growth';
	public static readonly sessionId = 'growth-tip';

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;

	private readonly _created = Date.now();
	private _seen = false;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * Mark the session as seen (opened by the user). Clears the NeedsInput
	 * attention badge without requiring any confirmation click.
	 */
	public markSeen(): void {
		if (!this._seen) {
			this._logService.info('[GrowthItemProvider] markSeen() — clearing attention');
			this._seen = true;
			this.refresh();
		}
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	public async provideChatSessionItems(_token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		return [{
			resource: GrowthSessionUri.forSessionId(GrowthChatSessionItemProvider.sessionId),
			label: 'Try Copilot',
			description: 'GitHub Copilot is now enabled. Try for free?',
			status: this._seen ? vscode.ChatSessionStatus.Completed : vscode.ChatSessionStatus.NeedsInput,
			timing: {
				created: this._created,
				lastRequestStarted: this._created,
			},
			iconPath: new vscode.ThemeIcon('lightbulb'),
		}];
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
