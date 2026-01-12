/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { autorun } from '../../../util/vs/base/common/observableInternal';
import { URI } from '../../../util/vs/base/common/uri';
import { getContributedToolName } from '../common/toolNames';
import { IToolsService } from '../common/toolsService';
import { IToolGroupingCache, IToolGroupingService } from '../common/virtualTools/virtualToolTypes';
import { isVscodeLanguageModelTool } from '../common/toolsRegistry';
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
			if (isVscodeLanguageModelTool(tool)) {
				this._register(vscode.lm.registerTool(getContributedToolName(name), tool));
			}
		}

		this._register(vscode.commands.registerCommand('github.copilot.debug.resetVirtualToolGroups', async () => {
			await toolGrouping.clear();
			vscode.window.showInformationMessage(l10n.t('Tool groups have been reset. They will be regenerated on the next agent request.'));
		}));

		this._register(vscode.commands.registerCommand('github.copilot.chat.tools.memory.openFolder', async () => {
			const storageUri = this.extensionContext.storageUri;
			if (!storageUri) {
				vscode.window.showErrorMessage(l10n.t('No workspace is currently open. Memory operations require an active workspace.'));
				return;
			}
			const memoryFolderUri = URI.joinPath(storageUri, 'memory-tool/memories');
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.from(memoryFolderUri));
				if (stat.type === vscode.FileType.Directory) {
					return vscode.env.openExternal(vscode.Uri.from(memoryFolderUri));
				}
			} catch {
			}
			vscode.window.showInformationMessage(l10n.t('No memories have been saved yet. The memory folder will be created when the first memory is saved.'));
		}));

		this._register(autorun(reader => {
			vscode.commands.executeCommand('setContext', 'chat.toolGroupingThreshold', toolGroupingService.threshold.read(reader));
		}));
	}
}
