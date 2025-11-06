/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { autorun } from '../../../util/vs/base/common/observableInternal';
import { URI } from '../../../util/vs/base/common/uri';
import { getContributedToolName } from '../common/toolNames';
import { IToolsService } from '../common/toolsService';
import { IToolGroupingCache, IToolGroupingService } from '../common/virtualTools/virtualToolTypes';

import '../node/allTools';
import './allTools';

export class ToolsContribution extends Disposable {
	constructor(
		@IToolsService toolsService: IToolsService,
		@IToolGroupingCache toolGrouping: IToolGroupingCache,
		@IToolGroupingService toolGroupingService: IToolGroupingService,
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();

		for (const [name, tool] of toolsService.copilotTools) {
			this._register(vscode.lm.registerTool(getContributedToolName(name), tool));
		}

		this._register(vscode.commands.registerCommand('github.copilot.debug.resetVirtualToolGroups', async () => {
			await toolGrouping.clear();
			vscode.window.showInformationMessage('Tool groups have been reset. They will be regenerated on the next agent request.');
		}));

		this._register(vscode.commands.registerCommand('github.copilot.chat.tools.memory.openFolder', async () => {
			const storageUri = this.extensionContext.storageUri;
			if (!storageUri) {
				vscode.window.showErrorMessage('No workspace is currently open. Memory operations require an active workspace.');
				return;
			}
			const memoryFolderUri = URI.joinPath(storageUri, 'memory-tool/memories');
			return vscode.env.openExternal(vscode.Uri.from(memoryFolderUri));
		}));

		this._register(autorun(reader => {
			vscode.commands.executeCommand('setContext', 'chat.toolGroupingThreshold', toolGroupingService.threshold.read(reader));
		}));
	}
}
