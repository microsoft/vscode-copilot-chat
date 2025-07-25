/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../../platform/configuration/common/configurationService';
import { CachedFunction } from '../../../../util/vs/base/common/cache';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { autorun, derived, mapObservableArrayCached } from '../../../../util/vs/base/common/observableInternal';
import { Range } from '../../../../util/vs/editor/common/core/range';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { ObservableVsCode } from '../../../workspaceRecorder/vscode-node/utilsObservable';
import { EditSource } from '../../common/documentWithAnnotatedEdits';
import { EditSourceTrackingImpl } from '../../common/editSourceTrackingImpl';
import { IVSCodeObservableDocument, VSCodeWorkspace } from '../parts/vscodeWorkspace';
import { makeSettable } from '../utils/observablesUtils';

export class EditSourceTrackingFeature extends Disposable {
	private readonly _editSourceTrackingShowDecorations;
	private readonly _editSourceTrackingShowStatusBar;
	private readonly _showStateInMarkdownDoc = 'copilot.editSourceTracker.showDetails';
	private readonly _toggleDecorations = 'copilot.editSourceTracker.toggleDecorations';

	constructor(
		private readonly _workspace: VSCodeWorkspace,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._editSourceTrackingShowDecorations = makeSettable(this._configurationService.getConfigObservable(ConfigKey.Internal.EditSourceTrackingShowDecorations));
		this._editSourceTrackingShowStatusBar = this._configurationService.getConfigObservable(ConfigKey.Internal.EditSourceTrackingShowStatusBar);

		const visibleTextEditorDocs = ObservableVsCode.instance.visibleTextEditors.map(editors => new Set(editors.map(e => e.editor.document)));

		const impl = this._register(this._instantiationService.createInstance(EditSourceTrackingImpl, _workspace, (doc, reader) => {
			const obsDoc = (doc as IVSCodeObservableDocument);
			if (obsDoc.kind === 'textDocument') {
				const docIsVisible = visibleTextEditorDocs.read(reader).has(obsDoc.textDocument);
				return docIsVisible;
			} else {
				const notebook = obsDoc.notebook;
				const visibleEditors = visibleTextEditorDocs.read(reader);
				const docIsVisible = notebook.getCells().some(c => visibleEditors.has(c.document));
				return docIsVisible;
			}
		}));

		this._register(autorun((reader) => {
			if (!this._editSourceTrackingShowDecorations.read(reader)) {
				return;
			}

			mapObservableArrayCached(this, ObservableVsCode.instance.visibleTextEditors, (e, store) => {
				store.add(autorun(async (reader) => {
					const store = reader.store;
					const decorations = new CachedFunction((source: EditSource) => {
						return store.add(vscode.window.createTextEditorDecorationType({
							backgroundColor: source.getColor(),
						}));
					});

					const doc = this._workspace.getDocumentByTextDocument(e.editor.document, reader);
					if (!doc) {
						return;
					}
					doc.version.read(reader);
					const ranges = (impl.docsState.read(reader).get(doc)?.longtermTracker.read(reader)?.getTrackedRanges(reader)) ?? [];

					const t = doc.value.get().getTransformer();
					const groups = groupByKeyToMap(ranges, d => decorations.get(d.source));

					for (const [key, ranges] of groups.entries()) {
						e.editor.setDecorations(key, ranges.map(r => rangeToVSCodeRange(t.getRange(r.range))));
					}
				}));
			}).recomputeInitiallyAndOnChange(reader.store);
		}));

		this._register(autorun(reader => {
			if (!this._editSourceTrackingShowStatusBar.read(reader)) {
				return;
			}

			const statusBarItem = reader.store.add(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100));

			const sumChangedCharacters = derived(reader => {
				const docs = impl.docsState.read(reader);
				let sum = 0;
				for (const state of docs.values()) {
					const t = state.longtermTracker.read(reader);
					if (!t) { continue; }
					const d = state.getTelemetryData(t.getTrackedRanges(reader));
					sum += d.totalModifiedCharactersInFinalState;
				}
				return sum;
			});

			reader.store.add(autorun(reader => {
				statusBarItem.text = `$(edit) ${sumChangedCharacters.read(reader)}`;
			}));

			reader.store.add(autorun(reader => {
				const docs = impl.docsState.read(reader);
				const docsDataInTooltip: string[] = [];
				const editSources: EditSource[] = [];
				for (const [doc, state] of docs) {
					const tracker = state.longtermTracker.read(reader);
					if (!tracker) {
						continue;
					}
					const trackedRanges = tracker.getTrackedRanges(reader);
					const data = state.getTelemetryData(trackedRanges);
					if (data.totalModifiedCharactersInFinalState === 0) {
						continue; // Don't include unmodified documents in tooltip
					}

					editSources.push(...trackedRanges.map(r => r.source));

					// Filter out unmodified properties as these are not interesting to see in the hover
					const filteredData = Object.fromEntries(
						Object.entries(data).filter(([_, value]) => !(typeof value === 'number') || value !== 0)
					);

					docsDataInTooltip.push([
						`### ${doc.id.toUri().fsPath}`,
						'```json',
						JSON.stringify(filteredData, undefined, '\t'),
						'```',
						'\n'
					].join('\n'));
				}

				let tooltipContent: string;
				if (docsDataInTooltip.length === 0) {
					tooltipContent = 'No modified documents';
				} else if (docsDataInTooltip.length <= 3) {
					tooltipContent = docsDataInTooltip.join('\n\n');
				} else {
					const lastThree = docsDataInTooltip.slice(-3);
					tooltipContent = '...\n\n' + lastThree.join('\n\n');
				}

				const agenda = this._createEditSourceAgenda(editSources);

				const tooltipWithCommand = new vscode.MarkdownString(tooltipContent + '\n\n[View Details](command:' + this._showStateInMarkdownDoc + ')');
				tooltipWithCommand.appendMarkdown('\n\n' + agenda + '\n\nToggle decorations: [Click here](command:' + this._toggleDecorations + ')');
				tooltipWithCommand.isTrusted = true;
				tooltipWithCommand.supportHtml = true;
				statusBarItem.command = { command: this._showStateInMarkdownDoc, title: 'Show Edit Source Tracking Details' };
				statusBarItem.tooltip = tooltipWithCommand;
			}));

			statusBarItem.show();

			reader.store.add(vscode.commands.registerCommand(this._toggleDecorations, () => {
				this._editSourceTrackingShowDecorations.set(!this._editSourceTrackingShowDecorations.get(), undefined);
			}));

			reader.store.add(vscode.commands.registerCommand(this._showStateInMarkdownDoc, async () => {
				const docs = impl.docsState.get();
				const allDocsData: string[] = [];
				for (const [doc, state] of docs) {
					const tracker = state.longtermTracker.get();
					if (!tracker) {
						continue;
					}
					const data = state.getTelemetryData(tracker.getTrackedRanges());
					allDocsData.push([
						`## ${doc.id.toUri().fsPath}`,
						'',
						'```json',
						JSON.stringify({ ...data, isTrackedByGit: await data.isTrackedByGit }, undefined, '\t'),
						'```',
						'\n'
					].join('\n'));
				}

				const markdownContent = [
					'# Edit Source Tracking Details',
					'',
					'This document shows detailed information about edit sources across all tracked documents.',
					'',
					allDocsData.length > 0 ? allDocsData.join('\n') : 'No modified documents found.'
				].join('\n');

				const doc = await vscode.workspace.openTextDocument({
					content: markdownContent,
					language: 'markdown',
				});

				// await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'vscode.markdown.preview.editor');
				await vscode.window.showTextDocument(doc);
			}));
		}));
	}

	private _createEditSourceAgenda(editSources: EditSource[]): string {
		// Collect all edit sources from the tracked documents
		const editSourcesSeen = new Set<string>();
		const editSourceInfo = [];
		for (const editSource of editSources) {
			if (!editSourcesSeen.has(editSource.toString())) {
				editSourcesSeen.add(editSource.toString());
				editSourceInfo.push({ name: editSource.toString(), color: editSource.getColor() });
			}
		}

		const agendaItems = editSourceInfo.map(info =>
			`<span style="background-color:${info.color};border-radius:3px;">${info.name}</span>`
		);

		return agendaItems.join(' ');
	}
}

function rangeToVSCodeRange(range: Range): import('vscode').Range {
	return new vscode.Range(range.startLineNumber - 1, range.startColumn - 1, range.endLineNumber - 1, range.endColumn - 1);
}

function groupByKeyToMap<T, K>(items: T[], keyFn: (t: T) => K): Map<K, T[]> {
	const out = new Map<K, T[]>();
	for (const item of items) {
		const key = keyFn(item);
		if (!out.has(key)) {
			out.set(key, []);
		}
		out.get(key)!.push(item);
	}
	return out;
}
