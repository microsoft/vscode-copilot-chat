/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { URI } from '../../../util/vs/base/common/uri';
import { CellOrNotebookEdit } from '../../prompts/node/codeMapper/codeMapper';
import { ToolName } from '../common/toolNames';
import { ToolRegistry } from '../common/toolsRegistry';
import { AbstractReplaceStringTool } from './abstractReplaceStringTool';
import { IReplaceStringToolParams } from './replaceStringTool';

export interface IMultiReplaceStringToolParams {
	explanation: string;
	replacements: IReplaceStringToolParams[];
}

export class MultiReplaceStringTool extends AbstractReplaceStringTool<IMultiReplaceStringToolParams> {
	public static toolName = ToolName.MultiReplaceString;

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IMultiReplaceStringToolParams>, token: vscode.CancellationToken) {
		if (!options.input.replacements || !Array.isArray(options.input.replacements)) {
			throw new Error('Invalid input, no replacements array');
		}

		const prepared = await Promise.all(options.input.replacements.map(r => this.prepareEditsForFile(options, r, token)));

		for (let i = 0; i < prepared.length; i++) {
			const e1 = prepared[i];
			if (!e1.generatedEdit.success) {
				continue;
			}

			for (let k = i + 1; k < prepared.length; k++) {
				const e2 = prepared[k];
				// Merge successful edits of the same type and URI so that edits come in
				// a single correct batch and positions aren't later clobbered.
				if (!e2.generatedEdit.success || e2.uri.toString() !== e1.uri.toString() || (!!e2.generatedEdit.notebookEdits !== !!e1.generatedEdit.notebookEdits)) {
					continue;
				}

				prepared.splice(k, 1);
				k--;

				if (e2.generatedEdit.notebookEdits) {
					e1.generatedEdit.notebookEdits = mergeNotebookAndTextEdits(e1.generatedEdit.notebookEdits!, e2.generatedEdit.notebookEdits);
				} else {
					e1.generatedEdit.textEdits = e1.generatedEdit.textEdits.concat(e2.generatedEdit.textEdits);
					e1.generatedEdit.textEdits.sort(textEditSorter);
				}
			}
		}

		return this.applyAllEdits(options, prepared, token);
	}

	protected override toolName(): ToolName {
		return MultiReplaceStringTool.toolName;
	}
}

ToolRegistry.registerTool(MultiReplaceStringTool);

function textEditSorter(a: vscode.TextEdit, b: vscode.TextEdit) {
	return b.range.end.compareTo(a.range.end) || b.range.start.compareTo(a.range.start);
}

/**
 * Merge two arrays of notebook edits or text edits grouped by URI.
 * Text edits for the same URI are concatenated and sorted in reverse file order (descending by start position).
 */
function mergeNotebookAndTextEdits(left: CellOrNotebookEdit[], right: CellOrNotebookEdit[]): CellOrNotebookEdit[] {
	const notebookEdits: vscode.NotebookEdit[] = [];
	const textEditsByUri = new ResourceMap<vscode.TextEdit[]>();

	const add = (item: vscode.NotebookEdit | [URI, vscode.TextEdit[]]) => {
		if (Array.isArray(item)) {
			const [uri, edits] = item;
			let bucket = textEditsByUri.get(uri);
			if (!bucket) {
				bucket = [];
				textEditsByUri.set(uri, bucket);
			}
			bucket.push(...edits);
		} else {
			notebookEdits.push(item);
		}
	};

	left.forEach(add);
	right.forEach(add);

	const mergedTextEditTuples: [URI, vscode.TextEdit[]][] = [];
	for (const [uri, edits] of textEditsByUri.entries()) {
		edits.sort(textEditSorter);
		mergedTextEditTuples.push([uri, edits]);
	}

	return [...notebookEdits, ...mergedTextEditTuples];
}
