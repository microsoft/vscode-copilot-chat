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
import { isVscodeLanguageModelTool } from '../common/toolsRegistry';
import { IToolsService } from '../common/toolsService';
import { IToolGroupingCache, IToolGroupingService } from '../common/virtualTools/virtualToolTypes';
import '../node/allTools';
import { extractSessionId } from '../node/memoryTool';
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

		this._register(vscode.commands.registerCommand('github.copilot.chat.tools.memory.viewMemory', async () => {
			const globalStorageUri = this.extensionContext.globalStorageUri;
			const storageUri = this.extensionContext.storageUri;

			interface MemoryItem extends vscode.QuickPickItem {
				fileUri?: URI;
			}

			const items: MemoryItem[] = [];

			// Collect user-scoped memories from globalStorageUri/memory-tool/memories/
			if (globalStorageUri) {
				const userMemoryUri = URI.joinPath(globalStorageUri, 'memory-tool/memories');
				try {
					const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.from(userMemoryUri));
					const fileEntries = entries.filter(([name, type]) => type === vscode.FileType.File && !name.startsWith('.'));
					if (fileEntries.length > 0) {
						items.push({ label: 'memory/', kind: vscode.QuickPickItemKind.Separator });
						for (const [name] of fileEntries) {
							items.push({
								label: `$(file) ${name}`,
								description: 'user',
								fileUri: URI.joinPath(userMemoryUri, name),
							});
						}
					}
				} catch {
					// User memory directory may not exist yet
				}
			}

			// Collect session-scoped memories from storageUri/memory-tool/memories/<sessionId>/
			const sessionResource = vscode.window.activeChatPanelSessionResource;
			console.log('Active chat session resource:', sessionResource?.toString());
			if (storageUri && sessionResource) {
				const sessionId = extractSessionId(sessionResource.toString());
				const sessionMemoryUri = URI.joinPath(storageUri, 'memory-tool/memories', sessionId);
				try {
					const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.from(sessionMemoryUri));
					const fileEntries = entries.filter(([name, type]) => type === vscode.FileType.File && !name.startsWith('.'));
					if (fileEntries.length > 0) {
						items.push({ label: `memory/${sessionId}/`, kind: vscode.QuickPickItemKind.Separator });
						for (const [name] of fileEntries) {
							items.push({
								label: `$(file) ${name}`,
								description: 'session',
								fileUri: URI.joinPath(sessionMemoryUri, name),
							});
						}
					}
				} catch {
					// Session memory directory may not exist yet
				}
			}

			if (items.length === 0) {
				vscode.window.showInformationMessage(l10n.t('No memories found.'));
				return;
			}

			const selected = await vscode.window.showQuickPick(items, {
				title: l10n.t('Memory'),
				placeHolder: l10n.t('Select a memory file to view'),
			});

			if (selected?.fileUri) {
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.from(selected.fileUri));
			}
		}));

		this._register(autorun(reader => {
			vscode.commands.executeCommand('setContext', 'chat.toolGroupingThreshold', toolGroupingService.threshold.read(reader));
		}));
	}
}
