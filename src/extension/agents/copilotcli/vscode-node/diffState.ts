/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogger } from '../../../../platform/log/common/logService';

export interface ActiveDiff {
	diffId: string;
	tabName: string;
	originalUri: vscode.Uri;
	modifiedUri: vscode.Uri;
	newContents: string;
	cleanup: () => void;
	resolve: (result: { status: 'SAVED' | 'REJECTED'; trigger: string }) => void;
}

// Map from diffId to active diff info
const activeDiffs = new Map<string, ActiveDiff>();

let _logger: ILogger | undefined;

export function initDiffState(logger: ILogger): void {
	_logger = logger;
}

export function registerActiveDiff(diff: ActiveDiff): void {
	_logger?.info(`[DIFF] registerActiveDiff: tabName=${diff.tabName}, diffId=${diff.diffId}, mapSize=${activeDiffs.size}`);
	activeDiffs.set(diff.diffId, diff);
	_logger?.info(`[DIFF] After register, mapSize=${activeDiffs.size}`);
	updateContext();
}

export function unregisterActiveDiff(diffId: string): void {
	const diff = activeDiffs.get(diffId);
	_logger?.info(`[DIFF] unregisterActiveDiff: diffId=${diffId}, found=${!!diff}, mapSize=${activeDiffs.size}`);
	activeDiffs.delete(diffId);
	_logger?.info(`[DIFF] After unregister, mapSize=${activeDiffs.size}`);
	updateContext();
}

export function getActiveDiffByTabName(tabName: string): ActiveDiff | undefined {
	for (const diff of activeDiffs.values()) {
		if (diff.tabName === tabName) {
			return diff;
		}
	}
	return undefined;
}

function isDiffTab(tab: vscode.Tab): tab is vscode.Tab & { input: vscode.TabInputTextDiff } {
	return tab.input instanceof vscode.TabInputTextDiff;
}

export function getActiveDiffByTab(tab: vscode.Tab): ActiveDiff | undefined {
	if (!isDiffTab(tab)) {
		_logger?.info('[DIFF] getActiveDiffByTab: tab is not a diff tab');
		return undefined;
	}
	const modifiedUri = tab.input.modified.toString();
	_logger?.info(`[DIFF] getActiveDiffByTab: looking for modifiedUri=${modifiedUri}, mapSize=${activeDiffs.size}`);
	for (const diff of activeDiffs.values()) {
		_logger?.info(`[DIFF]   checking diff.modifiedUri=${diff.modifiedUri.toString()}`);
		if (diff.modifiedUri.toString() === modifiedUri) {
			_logger?.info('[DIFF]   MATCH found');
			return diff;
		}
	}
	_logger?.info('[DIFF]   No match found');
	return undefined;
}

export function getActiveDiffForCurrentTab(): ActiveDiff | undefined {
	const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
	_logger?.info(`[DIFF] getActiveDiffForCurrentTab: activeTab=${activeTab?.label ?? 'none'}`);
	if (activeTab) {
		return getActiveDiffByTab(activeTab);
	}
	return undefined;
}

export function hasActiveDiffs(): boolean {
	return activeDiffs.size > 0;
}

function updateContext(): void {
	const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
	const isActiveDiff = activeTab ? getActiveDiffByTab(activeTab) !== undefined : false;
	vscode.commands.executeCommand('setContext', 'github.copilot.chat.copilotCLI.hasActiveDiff', isActiveDiff);
}

export function setupDiffContextTracking(): vscode.Disposable[] {
	const disposables: vscode.Disposable[] = [];
	disposables.push(
		vscode.window.tabGroups.onDidChangeTabGroups(() => {
			updateContext();
		})
	);
	disposables.push(
		vscode.window.tabGroups.onDidChangeTabs(() => {
			updateContext();
		})
	);
	return disposables;
}
