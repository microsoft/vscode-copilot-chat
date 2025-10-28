/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { isMacintosh, isWindows } from '../../../util/vs/base/common/platform';
import { URI } from '../../../util/vs/base/common/uri';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { ISystemContextService } from '../node/systemContextService';

interface SystemContextQuickPickItem extends vscode.QuickPickItem {
	readonly uri?: URI;
	readonly isBrowse?: boolean;
}

const COMMAND_ID = 'github.copilot.chat.addSystemContext';

export class SystemContextContribution extends Disposable implements IExtensionContribution {
	readonly id = 'systemContext.contribution';

	constructor(
		@ISystemContextService private readonly systemContextService: ISystemContextService,
	) {
		super();

		this._register(vscode.commands.registerCommand(COMMAND_ID, async () => {
			const selected = await this.pickSystemPaths();
			if (!selected || selected.length === 0) {
				return;
			}

			this.systemContextService.addSystemPaths(selected);

			const label = selected.length === 1 ? selected[0].fsPath : vscode.l10n.t('{0} system locations', selected.length.toString());
			const statusMessage = vscode.l10n.t('Added {0} to Copilot context', label);
			void vscode.window.setStatusBarMessage(statusMessage, 3000);
		}));
	}

	private async pickSystemPaths(): Promise<URI[] | undefined> {
		const items = await this.getQuickPickItems();

		const picked = await vscode.window.showQuickPick<SystemContextQuickPickItem>(items, {
			placeHolder: vscode.l10n.t('Select system locations to include in Copilot context'),
			ignoreFocusOut: true,
			canPickMany: true,
		});

		if (!picked) {
			return undefined;
		}

		const selectedUris: URI[] = [];
		for (const item of picked) {
			if (item.uri) {
				selectedUris.push(item.uri);
			}
		}

		if (picked.some(item => item.isBrowse)) {
			const browseUris = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: true,
				openLabel: vscode.l10n.t('Add to Copilot System Context')
			});

			if (browseUris) {
				for (const uri of browseUris) {
					selectedUris.push(URI.revive(uri));
				}
			}
		}

		if (selectedUris.length === 0) {
			return undefined;
		}

		return this.normalizeAndDeduplicate(selectedUris);
	}

	private async getQuickPickItems(): Promise<SystemContextQuickPickItem[]> {
		const items: SystemContextQuickPickItem[] = [];
		const defaults = this.getDefaultSystemPaths();

		for (const uri of defaults) {
			items.push({
				label: uri.fsPath,
				description: vscode.l10n.t('Suggested system location'),
				uri
			});
		}

		const envPaths = this.getEnvConfiguredPaths();
		for (const uri of envPaths) {
			if (!defaults.some(def => def.toString() === uri.toString())) {
				items.push({
					label: uri.fsPath,
					description: vscode.l10n.t('From SYSTEM_CONTEXT_PATHS setting'),
					uri
				});
			}
		}

		items.sort((a, b) => a.label.localeCompare(b.label));

		items.push({
			label: vscode.l10n.t('Browse for folder…'),
			description: vscode.l10n.t('Select a custom system folder'),
			isBrowse: true
		});

		return items;
	}

	private getDefaultSystemPaths(): URI[] {
		const defaults: string[] = [];

		if (isWindows) {
			defaults.push('C:\\Windows\\System32', 'C:\\ProgramData');
		} else if (isMacintosh) {
			defaults.push('/System/Library', '/etc');
		} else {
			defaults.push('/etc', '/var/log');
		}

		return defaults
			.filter(p => !!p)
			.map(p => URI.file(p));
	}

	private getEnvConfiguredPaths(): URI[] {
		const envValue = process.env.SYSTEM_CONTEXT_PATHS;
		if (!envValue) {
			return [];
		}

		const delimiter = isWindows ? ';' : ':';
		const segments = envValue.split(delimiter)
			.map(segment => segment.trim())
			.filter(segment => segment.length > 0);

		return segments.map(segment => URI.file(path.resolve(segment)));
	}

	private normalizeAndDeduplicate(uris: readonly URI[]): URI[] {
		const unique = new Map<string, URI>();
		for (const uri of uris) {
			unique.set(uri.with({ fragment: '', query: '' }).toString(), uri);
		}
		return Array.from(unique.values());
	}
}
