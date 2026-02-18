/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IAgentDebugEventService } from '../common/agentDebugEventService';
import { AgentDebugPanel } from './agentDebugPanel';

export class AgentDebugPanelContribution extends Disposable {

	constructor(
		@IAgentDebugEventService private readonly _debugEventService: IAgentDebugEventService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._logService.info('[AgentDebug] PanelContribution loaded, registering commands');

		this._register(vscode.commands.registerCommand('github.copilot.agentDebug.openPanel', () => {
			this._logService.info(`[AgentDebug] openPanel command executed, event count: ${this._debugEventService.getEvents().length}`);
			AgentDebugPanel.createOrShow(this._debugEventService, this._logService);
		}));

		this._register(vscode.commands.registerCommand('github.copilot.agentDebug.attachSession', () => {
			this._logService.info('[AgentDebug] attachSession command executed');
			const panel = AgentDebugPanel.createOrShow(this._debugEventService, this._logService);
			panel.attachLatest();
		}));
	}
}
