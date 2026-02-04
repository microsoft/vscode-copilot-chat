/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

/**
 * Chat session item provider for product growth and user education.
 * This provider shows educational messages to teach users how to use Copilot.
 */
export class GrowthChatSessionItemProvider extends Disposable implements vscode.ChatSessionItemProvider {

	public static readonly sessionType = 'copilot-growth';

	private readonly _onDidChangeChatSessionItems = this._register(new Emitter<void>());
	public readonly onDidChangeChatSessionItems: Event<void> = this._onDidChangeChatSessionItems.event;

	private readonly _onDidCommitChatSessionItem = this._register(new Emitter<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }>());
	public readonly onDidCommitChatSessionItem: Event<{ original: vscode.ChatSessionItem; modified: vscode.ChatSessionItem }> = this._onDidCommitChatSessionItem.event;

	constructor() {
		super();
	}

	public refresh(): void {
		this._onDidChangeChatSessionItems.fire();
	}

	public async provideChatSessionItems(token: vscode.CancellationToken): Promise<vscode.ChatSessionItem[]> {
		// For now, return empty array. Items will be dynamically created when needed.
		return [];
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
