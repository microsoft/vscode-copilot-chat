/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DocumentInfo } from '../../common/prompt';
import { flattenVirtual, isBlank, isLine, mapLabels, parseTree, visitTree } from '../../common/indentation/api';
import { getTokenizer, Tokenizer } from '../tokenization/api';
import type { ElidableText } from './elidableText';
import { fromTreeWithFocussedLines } from './fromIndentationTrees';

/**
 * Construct an {@link ElidableText} from a piece of source code, focussing on
 * the first line and last leaf that is not a closer.
 */
export function elidableTextForSourceCode(
	contents: string | DocumentInfo,
	focusOnLastLeaf = true,
	focusOnFirstLine = true,
	metadata?: Map<string, unknown>,
	tokenizer: Tokenizer = getTokenizer()
): ElidableText {
	// if contents is a DocumentInfo, it has source and languageId, and we want to pass both to parseTree
	const tree = typeof contents === 'string' ? parseTree(contents) : parseTree(contents.source, contents.languageId);
	flattenVirtual(tree);
	// we may want to include the last leaf that is not a closer, seeing the end as informative e.g. for appending
	const treeWithFocussedLines = mapLabels<string, boolean>(tree, label => focusOnLastLeaf && label !== 'closer');
	// if the label was closer, it's false now, but if there was no label, there still is no label
	// let's make it explicit that a node is true iff it's not a closer and we do want to focusOnLastLeaf
	visitTree(
		treeWithFocussedLines,
		node => {
			if (node.label === undefined) {
				node.label = focusOnLastLeaf && node.label !== false;
			}
		},
		'topDown'
	);
	if (focusOnLastLeaf) {
		visitTree(
			treeWithFocussedLines,
			node => {
				if (node.label) {
					let foundLastTrue = false;
					for (const subnode of [...node.subs].reverse()) {
						if (subnode.label && !foundLastTrue) {
							foundLastTrue = true;
						} else {
							subnode.label = false;
						}
					}
				} else {
					// all subs get label false
					for (const subnode of node.subs) {
						subnode.label = false;
					}
				}
				// we want to find the last _leaf_, so if there are subs, this is not it
				if (node.subs.length > 0) {
					node.label = false;
				}
			},
			'topDown'
		);
	}
	// we may want to focus on the first lines, seeing the beginning as informative e.g. for the setup
	if (focusOnFirstLine) {
		visitTree(
			treeWithFocussedLines,
			node => {
				node.label ||= (isLine(node) || isBlank(node)) && node.lineNumber === 0;
			},
			'topDown'
		);
	}

	return fromTreeWithFocussedLines(treeWithFocussedLines, metadata, tokenizer);
}
