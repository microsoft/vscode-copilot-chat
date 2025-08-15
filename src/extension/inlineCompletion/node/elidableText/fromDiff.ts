/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as diff from 'diff';
import { flattenVirtual, mapLabels, parseTree, visitTree } from '../../common/indentation/api';
import { DocumentInfo } from '../../common/prompt';
import { ElidableText } from './elidableText';
import { fromTreeWithFocussedLines } from './fromIndentationTrees';

/**
 * Returns two {@link ElidableText} objects, one for each of the two contents.
 * Lines that changed are focussed on.
 * @param oldContent
 * @param newContent
 * @returns
 */
export function elidableTextForDiff(
	oldContent: string | DocumentInfo,
	newContent: string | DocumentInfo
): [ElidableText, ElidableText] {
	// languageId is: if one of the contents is a DocumentInfo, use its, otherwise only if both are equal
	const languageId =
		typeof oldContent === 'string'
			? typeof newContent === 'string'
				? undefined
				: newContent.languageId
			: typeof newContent === 'string'
				? oldContent.languageId
				: oldContent.languageId === newContent.languageId
					? oldContent.languageId
					: undefined;
	oldContent = typeof oldContent === 'string' ? oldContent : oldContent.source;
	newContent = typeof newContent === 'string' ? newContent : newContent.source;

	// collect lines that changed
	const patch = diff.structuredPatch('', '', oldContent, newContent);
	const changedLinesOld = new Set<number>();
	const changedLinesNew = new Set<number>();
	for (const hunk of patch.hunks) {
		for (let i = hunk.oldStart; i < hunk.oldStart + hunk.oldLines; i++) {
			changedLinesOld.add(i);
		}
		for (let i = hunk.newStart; i < hunk.newStart + hunk.newLines; i++) {
			changedLinesNew.add(i);
		}
	}

	// build indentation trees
	const oldTree = mapLabels(flattenVirtual(parseTree(oldContent, languageId)), () => false);
	const newTree = mapLabels(flattenVirtual(parseTree(newContent, languageId)), () => false);

	// mark changed lines
	visitTree(
		oldTree,
		node => {
			if (node.type === 'line' || node.type === 'blank') {
				if (changedLinesOld.has(node.lineNumber)) {
					node.label = true;
				}
			}
		},
		'topDown'
	);
	visitTree(
		newTree,
		node => {
			if (node.type === 'line' || node.type === 'blank') {
				if (changedLinesNew.has(node.lineNumber)) {
					node.label = true;
				}
			}
		},
		'topDown'
	);

	return [fromTreeWithFocussedLines(oldTree), fromTreeWithFocussedLines(newTree)];
}
