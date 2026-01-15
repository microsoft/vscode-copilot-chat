/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { Disposable, DisposableMap } from '../../../util/vs/base/common/lifecycle';
import { autorun, autorunIterableDelta } from '../../../util/vs/base/common/observableInternal';
import { URI } from '../../../util/vs/base/common/uri';
import { getContributedToolName } from '../common/toolNames';
import { ICopilotTool, isVscodeLanguageModelTool, ToolRegistry } from '../common/toolsRegistry';
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
			if (isVscodeLanguageModelTool(tool)) {
				this._register(vscode.lm.registerTool(getContributedToolName(name), tool));
			}
		}

		const modelSpecificTools = this._register(new DisposableMap<string>());
		this._register(autorunIterableDelta(
			reader => toolsService.modelSpecificTools.read(reader),
			({ addedValues, removedValues }) => {
				for (const { definition } of removedValues) {
					modelSpecificTools.deleteAndDispose(definition.name);
				}
				for (const { definition, tool } of addedValues) {
					if (isVscodeLanguageModelTool(tool)) {
						modelSpecificTools.set(definition.name, vscode.lm.registerToolDefinition(definition, tool));
					}
				}
			},
			v => v.definition,
		));

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

ToolRegistry.registerModelSpecificTool(
	{
		name: 'gpt41_get_time',
		inputSchema: {},
		description: 'Get the current date and time (4.1)',
		displayName: 'Get Time (GPT 4.1)',
		userDescription: 'Gets the current date and time from the system. (4.1)',
		toolReferenceName: 'get_time',
		source: undefined,
		tags: [],
		models: [{ id: 'gpt-4.1' }],
	},
	class implements ICopilotTool<unknown> {
		invoke() {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Current year is 2041 (GPT 4.1)')]);
		}
	}
);

ToolRegistry.registerModelSpecificTool(
	{
		name: 'gpt4o_get_time',
		inputSchema: {},
		description: 'Get the current date and time (4o)',
		userDescription: 'Gets the current date and time from the system. (4o)',
		displayName: 'Get Time (GPT 4o)',
		toolReferenceName: 'get_time',
		source: undefined,
		tags: [],
		models: [{ id: 'gpt-4o' }],
	},
	class implements ICopilotTool<unknown> {
		invoke() {
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Current year is 2040 (GPT 4o)')]);
		}
	}
);