/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, ChatContext, ChatRequestTurn2 } from 'vscode';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../../platform/log/common/logService';
import { SequencerByKey } from '../../../../util/vs/base/common/async';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ChatTitleProvider } from '../../../prompt/node/title';
import { ICustomSessionTitleService } from '../common/customSessionTitleService';

const CUSTOM_SESSION_TITLE_MEMENTO_KEY = 'github.copilot.cli.customSessionTitles';
const SESSION_TITLE_MAX_AGE_DAYS = 7;

export class CustomSessionTitleService implements ICustomSessionTitleService {
	declare readonly _serviceBrand: undefined;
	private readonly _keyedSessionGenerator = new SequencerByKey<string>();

	constructor(
		@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) { }

	private _getCustomSessionTitles(): { [sessionId: string]: { title: string; updatedAt: number } | undefined } {
		return this.context.globalState.get<{ [sessionId: string]: { title: string; updatedAt: number } | undefined }>(CUSTOM_SESSION_TITLE_MEMENTO_KEY, {});
	}

	private _pruneStaleEntries(entries: { [sessionId: string]: { title: string; updatedAt: number } | undefined }): Record<string, { title: string; updatedAt: number }> {
		const maxAgeMs = SESSION_TITLE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
		const now = Date.now();
		const pruned: Record<string, { title: string; updatedAt: number }> = {};
		for (const [id, entry] of Object.entries(entries)) {
			if (entry && now - entry.updatedAt < maxAgeMs) {
				pruned[id] = entry;
			}
		}
		return pruned;
	}

	public getCustomSessionTitle(sessionId: string): string | undefined {
		const entries = this._getCustomSessionTitles();
		const entry = entries[sessionId];
		if (!entry) {
			return undefined;
		}
		const maxAgeMs = SESSION_TITLE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
		if (Date.now() - entry.updatedAt >= maxAgeMs) {
			return undefined;
		}
		return entry.title;
	}

	public async setCustomSessionTitle(sessionId: string, title: string): Promise<void> {
		const entries = this._pruneStaleEntries(this._getCustomSessionTitles());
		entries[sessionId] = { title, updatedAt: Date.now() };
		await this.context.globalState.update(CUSTOM_SESSION_TITLE_MEMENTO_KEY, entries);
	}

	public async removeCustomSessionTitle(sessionId: string): Promise<void> {
		const entries = this._pruneStaleEntries(this._getCustomSessionTitles());
		if (sessionId in entries) {
			delete entries[sessionId];
			await this.context.globalState.update(CUSTOM_SESSION_TITLE_MEMENTO_KEY, entries);
		}
	}

	public async generateSessionTitle(sessionId: string, request: { prompt?: string; command?: string }, token: CancellationToken): Promise<string | undefined> {
		const title = this.getCustomSessionTitle(sessionId);
		if (title) {
			return title;
		}

		return this._keyedSessionGenerator.queue(sessionId, () => this.generateSessionTitleImpl(sessionId, request, token));
	}

	private async generateSessionTitleImpl(sessionId: string, request: { prompt?: string; command?: string }, token: CancellationToken): Promise<string | undefined> {
		if (!request.prompt && !request.command) {
			return undefined;
		}
		try {
			const titleProvider = this.instantiationService.createInstance(ChatTitleProvider);
			// Construct a minimal ChatContext with the current request as a history entry so provideChatTitle can find it
			const requestTurn = new ChatRequestTurn2(request.prompt ?? '', request.command, [], '', [], [], undefined, undefined);
			const fakeContext: ChatContext = {
				history: [requestTurn],
				yieldRequested: false,
			};
			const title = await titleProvider.provideChatTitle(fakeContext, token);
			if (title) {
				await this.setCustomSessionTitle(sessionId, title);
				return title;
			}
		} catch (error) {
			this.logService.error('Failed to generate session title', error);
		}
	}

}
