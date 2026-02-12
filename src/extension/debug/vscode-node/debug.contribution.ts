/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { DebugPanelManager } from './debugPanel';

// Import debug tools to ensure they are registered
import '../tools/vscode-node/analyzeLatestRequestTool';
import '../tools/vscode-node/getCurrentSessionTool';
import '../tools/vscode-node/getFailuresTool';
import '../tools/vscode-node/getHierarchyTool';
import '../tools/vscode-node/getLiveHierarchyTool';
import '../tools/vscode-node/getSessionHistoryTool';
import '../tools/vscode-node/getToolCallsTool';
import '../tools/vscode-node/getTrajectoriesListTool';
import '../tools/vscode-node/getTrajectoryTool';
import '../tools/vscode-node/loadSessionFileTool';
import '../tools/vscode-node/loadTrajectoryFileTool';

/**
 * Contribution that registers the debug panel command
 */
export class DebugPanelContribution extends Disposable {
	private _panelManager: DebugPanelManager | undefined;
	private readonly _disposables = this._register(new DisposableStore());

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();

		// Register the command to open the debug panel
		this._disposables.add(
			vscode.commands.registerCommand('github.copilot.debug.openDebugPanel', () => {
				this._showPanel();
			})
		);
	}

	/**
	 * Show the debug panel (lazy-create the manager)
	 */
	private _showPanel(): void {
		if (!this._panelManager) {
			this._panelManager = this._instantiationService.createInstance(DebugPanelManager);
			this._disposables.add(this._panelManager);
		}
		this._panelManager?.show();
	}
}
