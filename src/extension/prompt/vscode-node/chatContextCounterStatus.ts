/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { t } from '@vscode/l10n';
import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

import { IChatContextCounterStatus } from '../common/chatContextCounterStatus';

interface IChatStatusItemLike {
	title: string | { label: string; link: string };
	description: string;
	detail: string | undefined;
	show(): void;
	hide(): void;
	dispose(): void;
}

export class ChatContextCounterStatus extends Disposable implements IChatContextCounterStatus {
	declare readonly _serviceBrand: undefined;

	private readonly _statusItemId = 'copilot.contextCounterStatus';
	private readonly _createChatStatusItem: (id: string) => IChatStatusItemLike;

	private _statusItem: IChatStatusItemLike | undefined;
	private _last: { usage: number; limit: number | undefined } | undefined;

	constructor(
		createChatStatusItem: ((id: string) => IChatStatusItemLike) | undefined,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		this._createChatStatusItem = createChatStatusItem ?? (id => vscode.window.createChatStatusItem(id));

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(ConfigKey.ContextCounterEnabled.fullyQualifiedId)) {
				this._refresh();
			}
		}));

		this._refresh();
	}

	public clear(): void {
		this._last = undefined;
		this._statusItem?.hide();
	}

	public update(usage: number, limit: number | undefined): void {
		this._last = { usage, limit };
		this._refresh();
	}

	private _refresh(): void {
		if (!this._configurationService.getConfig(ConfigKey.ContextCounterEnabled)) {
			this._statusItem?.hide();
			return;
		}

		const statusItem = this._getOrCreateStatusItem();
		if (!statusItem) {
			return;
		}

		statusItem.show();

		if (!this._last) {
			statusItem.description = t('No prompt yet');
			statusItem.detail = undefined;
			return;
		}

		const { usage, limit } = this._last;
		statusItem.description = this._formatUsage(usage, limit);
		statusItem.detail = undefined;
	}

	private _getOrCreateStatusItem(): IChatStatusItemLike | undefined {
		if (this._statusItem) {
			return this._statusItem;
		}

		try {
			this._statusItem = this._register(this._createChatStatusItem(this._statusItemId));
			this._statusItem.title = t('Context Usage');
			return this._statusItem;
		} catch {
			// If the proposed API isn't available, just no-op.
			return undefined;
		}
	}

	private _formatUsage(usage: number, limit: number | undefined): string {
		const prompt = this._formatCount(usage);
		if (!limit || limit <= 0) {
			return prompt;
		}

		const max = this._formatCount(limit);
		const ratio = Math.min(1, usage / limit);
		const percentage = Math.round(ratio * 100);
		return t('{0}/{1} ({2}%)', prompt, max, percentage);
	}

	private _formatCount(value: number): string {
		if (value < 1000) {
			return String(value);
		}

		if (value < 10_000) {
			return `${(value / 1000).toFixed(1)}k`;
		}

		return `${Math.round(value / 1000)}k`;
	}
}
