/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { URI } from '../../../util/vs/base/common/uri';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IExtensionContribution } from '../../common/contributions';
import { IExternalContextService } from '../node/externalContextService';

interface ExternalContextQuickPickItem extends vscode.QuickPickItem {
	readonly uri?: URI;
	readonly isBrowse?: boolean;
}

interface PickResult {
	readonly accepted: URI[];
	readonly excluded: URI[];
}

const ADD_COMMAND_ID = 'github.copilot.chat.addExternalContext';
const MANAGE_COMMAND_ID = 'github.copilot.chat.manageExternalContexts';
const STATUS_ALIGNMENT = vscode.StatusBarAlignment.Right;
const STATUS_PRIORITY = 100;
const DISALLOWED_FOLDER_NAMES = new Set(['node_modules', '.git', 'dist', 'build']);
const DISALLOWED_EXTENSIONS = new Set(['.log', '.tmp']);

export class ExternalContextContribution extends Disposable implements IExtensionContribution {
	readonly id = 'externalContext.contribution';

	private readonly statusItem: vscode.StatusBarItem;

	constructor(
		@IExternalContextService private readonly externalContextService: IExternalContextService,
	) {
		super();

		this.statusItem = this._register(vscode.window.createStatusBarItem(STATUS_ALIGNMENT, STATUS_PRIORITY));
		this.statusItem.name = vscode.l10n.t('Copilot External Context');
		this.statusItem.command = MANAGE_COMMAND_ID;
		this.statusItem.tooltip = vscode.l10n.t('Manage external folders shared with Copilot');
		this.statusItem.show();
		this.updateStatus();

		this._register(vscode.commands.registerCommand(ADD_COMMAND_ID, async () => this.handleAddExternalContext()));
		this._register(vscode.commands.registerCommand(MANAGE_COMMAND_ID, async () => this.handleManageExternalContexts()));
		this._register(this.externalContextService.onDidChangeExternalContext(() => this.updateStatus()));
	}

	private updateStatus(): void {
		const count = this.externalContextService.getExternalPaths().length;
		const max = this.externalContextService.maxExternalPaths;
		this.statusItem.text = `$(folder) ${count}/${max}`;
	}

	private async handleAddExternalContext(): Promise<void> {
		const remaining = this.externalContextService.maxExternalPaths - this.externalContextService.getExternalPaths().length;
		if (remaining <= 0) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Maximum of {0} external folders reached.', this.externalContextService.maxExternalPaths.toString()));
			return;
		}

		const pick = await this.pickExternalPaths();
		if (!pick || pick.accepted.length === 0) {
			if (pick && pick.excluded.length) {
				this.showExclusionMessage(pick.excluded);
			}
			return;
		}

		const added = this.externalContextService.addExternalPaths(pick.accepted);
		if (!added.length) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No external folders were added. The maximum of {0} folders may already be reached or your selection was excluded.', this.externalContextService.maxExternalPaths.toString()));
			return;
		}

		const label = added.length === 1 ? added[0].fsPath : vscode.l10n.t('{0} folders', added.length.toString());
		void vscode.window.setStatusBarMessage(vscode.l10n.t('Added {0} to Copilot external context', label), 3000);

		if (pick.excluded.length) {
			this.showExclusionMessage(pick.excluded);
		}

		if (added.length < pick.accepted.length || this.externalContextService.getExternalPaths().length >= this.externalContextService.maxExternalPaths) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Maximum of {0} external folders reached.', this.externalContextService.maxExternalPaths.toString()));
		}
	}

	private async handleManageExternalContexts(): Promise<void> {
		const current = this.externalContextService.getExternalPaths();
		if (!current.length) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No external folders are currently shared with Copilot.'));
			return;
		}

		const items = current.map<ExternalContextQuickPickItem>(uri => ({
			label: uri.fsPath,
			description: vscode.l10n.t('Remove from Copilot external context'),
			uri
		}));

		const picked = await vscode.window.showQuickPick(items, {
			canPickMany: true,
			ignoreFocusOut: true,
			placeHolder: vscode.l10n.t('Select folders to remove from Copilot external context')
		});

		if (!picked || picked.length === 0) {
			return;
		}

		for (const item of picked) {
			if (item.uri) {
				this.externalContextService.removeExternalPath(item.uri);
			}
		}

		const removedLabel = picked.length === 1 && picked[0].uri ? picked[0].uri.fsPath : vscode.l10n.t('{0} folders', picked.length.toString());
		void vscode.window.setStatusBarMessage(vscode.l10n.t('Removed {0} from Copilot external context', removedLabel), 3000);
	}

	private async pickExternalPaths(): Promise<PickResult | undefined> {
		const items = await this.getQuickPickItems();

		const picked = await vscode.window.showQuickPick<ExternalContextQuickPickItem>(items, {
			placeHolder: vscode.l10n.t('Select folders to include in Copilot external context'),
			ignoreFocusOut: true,
			canPickMany: true,
		});

		if (!picked) {
			return undefined;
		}

		const selected: URI[] = [];
		for (const item of picked) {
			if (item.uri) {
				selected.push(item.uri);
			}
		}

		if (picked.some(item => item.isBrowse)) {
			const browseUris = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: true,
				openLabel: vscode.l10n.t('Add to Copilot external context')
			});

			if (browseUris) {
				for (const uri of browseUris) {
					selected.push(URI.revive(uri));
				}
			}
		}

		if (!selected.length) {
			return { accepted: [], excluded: [] };
		}

		const normalized = this.normalizeAndDeduplicate(selected);
		return this.filterExcluded(normalized);
	}

	private async getQuickPickItems(): Promise<ExternalContextQuickPickItem[]> {
		const items: ExternalContextQuickPickItem[] = [];
		const envPaths = this.getEnvConfiguredPaths();

		for (const uri of envPaths) {
			items.push({
				label: uri.fsPath,
				description: vscode.l10n.t('From EXTERNAL_CONTEXT_PATHS setting'),
				uri
			});
		}

		items.sort((a, b) => a.label.localeCompare(b.label));

		items.push({
			label: vscode.l10n.t('Browse for folder…'),
			description: vscode.l10n.t('Select a custom folder'),
			isBrowse: true
		});

		return items;
	}

	private getEnvConfiguredPaths(): URI[] {
		const envValue = process.env.EXTERNAL_CONTEXT_PATHS || process.env.SYSTEM_CONTEXT_PATHS;
		if (!envValue) {
			return [];
		}

		const segments = envValue.split(path.delimiter)
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

	private async filterExcluded(uris: readonly URI[]): Promise<PickResult> {
		const patterns = await this.getWorkspaceExcludePatterns();
		const accepted: URI[] = [];
		const excluded: URI[] = [];

		for (const uri of uris) {
			if (this.shouldExclude(uri, patterns)) {
				excluded.push(uri);
			} else {
				accepted.push(uri);
			}
		}

		return { accepted, excluded };
	}

	private async getWorkspaceExcludePatterns(): Promise<string[]> {
		const config = vscode.workspace.getConfiguration('files');
		const excludes = config.get<Record<string, boolean>>('exclude');
		if (!excludes) {
			return [];
		}

		return Object.entries(excludes)
			.filter(([, value]) => value === true)
			.map(([pattern]) => pattern);
	}

	private shouldExclude(uri: URI, excludePatterns: readonly string[]): boolean {
		const fsPath = uri.fsPath;
		const segments = fsPath.split(path.sep).map(segment => segment.toLowerCase());
		if (segments.some(segment => DISALLOWED_FOLDER_NAMES.has(segment))) {
			return true;
		}

		const ext = path.extname(fsPath).toLowerCase();
		if (DISALLOWED_EXTENSIONS.has(ext)) {
			return true;
		}

		const normalized = fsPath.replace(/\\+/g, '/');
		for (const pattern of excludePatterns) {
			if (minimatch(normalized, pattern, { dot: true })) {
				return true;
			}
		}

		return false;
	}

	private showExclusionMessage(excluded: readonly URI[]): void {
		const label = excluded.length === 1 ? excluded[0].fsPath : vscode.l10n.t('{0} folders', excluded.length.toString());
		void vscode.window.showWarningMessage(vscode.l10n.t('Skipped {0} because the folder is excluded or disallowed for Copilot external context.', label));
	}
}
