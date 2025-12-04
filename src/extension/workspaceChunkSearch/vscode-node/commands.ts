/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { t } from '@vscode/l10n';
import * as vscode from 'vscode';
import { TriggerRemoteIndexingError } from '../../../platform/workspaceChunkSearch/node/codeSearch/codeSearchRepo';
import { IWorkspaceChunkSearchService } from '../../../platform/workspaceChunkSearch/node/workspaceChunkSearchService';
import { IWorkspaceFileIndex } from '../../../platform/workspaceChunkSearch/node/workspaceFileIndex';
import { TelemetryCorrelationId } from '../../../util/common/telemetryCorrelationId';
import { DisposableStore, IDisposable } from '../../../util/vs/base/common/lifecycle';
import { ServicesAccessor } from '../../../util/vs/platform/instantiation/common/instantiation';

export const buildLocalIndexCommandId = 'github.copilot.buildLocalWorkspaceIndex';
export const buildRemoteIndexCommandId = 'github.copilot.buildRemoteWorkspaceIndex';

export function register(accessor: ServicesAccessor): IDisposable {
	const workspaceChunkSearch = accessor.get(IWorkspaceChunkSearchService);
	const workspaceFileIndex = accessor.get(IWorkspaceFileIndex);

	const disposableStore = new DisposableStore();

	disposableStore.add(vscode.commands.registerCommand(buildLocalIndexCommandId, onlyRunOneAtATime(async () => {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: t`Updating local workspace index...`,
		}, async () => {
			const result = await workspaceChunkSearch.triggerLocalIndexing('manual', new TelemetryCorrelationId('BuildLocalIndexCommand'));
			if (result.isError()) {
				vscode.window.showWarningMessage(t`Could not build local workspace index.` + ' \n\n' + result.err.userMessage);
			}
		});
	})));

	disposableStore.add(vscode.commands.registerCommand(buildRemoteIndexCommandId, onlyRunOneAtATime(async () => {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: t`Building remote workspace index...`,
		}, async () => {
			const triggerResult = await workspaceChunkSearch.triggerRemoteIndexing('manual', new TelemetryCorrelationId('BuildRemoteIndexCommand'));
			if (triggerResult.isError()) {
				if (triggerResult.err.id === TriggerRemoteIndexingError.alreadyIndexed.id) {
					vscode.window.showInformationMessage(t`Remote workspace index ready to use.`);
				} else {
					vscode.window.showWarningMessage(t`Could not build remote workspace index. ` + '\n\n' + triggerResult.err.userMessage);
				}
			}
		});
	})));

	disposableStore.add(vscode.commands.registerCommand('github.copilot.debug.collectWorkspaceIndexDiagnostics', async () => {
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Window,
			title: t`Collecting workspace index diagnostics...`,
		}, async () => {
			const document = await vscode.workspace.openTextDocument({ language: 'markdown' });
			const editor = await vscode.window.showTextDocument(document);

			await appendText(editor, '# Workspace Index Diagnostics\n');
			await appendText(editor, 'Tracked file count: ' + workspaceFileIndex.fileCount + '\n\n');

			await appendText(editor, '## All tracked files\n');
			const fileEntries = Array.from(workspaceFileIndex.values());
			const stepSize = 500;
			for (let i = 0; i < fileEntries.length; i += stepSize) {
				if (editor.document.isClosed) {
					return;
				}

				const files = fileEntries.slice(i, i + stepSize);
				if (files.length) {
					await appendText(editor, files.map(file => `- ${file.uri.fsPath}`).join('\n') + '\n');
				}
			}
		});
	}));

	return disposableStore;
}

async function appendText(editor: vscode.TextEditor, string: string) {
	await editor.edit(builder => {
		builder.insert(editor.document.lineAt(editor.document.lineCount - 1).range.end, string);
	});
}

function onlyRunOneAtATime<T>(taskFactory: () => Promise<T>): () => Promise<T> {
	let runningTask: Promise<T> | undefined;

	return async (): Promise<T> => {
		if (runningTask) {
			return runningTask;
		}

		const task = taskFactory();
		runningTask = task;

		try {
			return await task;
		} finally {
			runningTask = undefined;
		}
	};
}