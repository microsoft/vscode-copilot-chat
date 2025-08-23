/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * @fileoverview Utility functions for creating elidable texts from indentation trees.
 */

import { IndentationTree, deparseLine, foldTree, isBlank, mapLabels, visitTree } from '../../common/indentation/api';
import { Tokenizer, getTokenizer } from '../tokenization/api';
import { ElidableText } from './elidableText';

/** All these costs are multiplicative, i.e. should be between 0 and 1 */
export type TreeTraversalConfig = { worthUp: number; worthSibling: number; worthDown: number };
export const DEFAULT_TREE_TRAVERSAL_CONFIG: TreeTraversalConfig = {
	worthUp: 0.9,
	worthSibling: 0.88,
	worthDown: 0.8,
};

/**
 * Take some nodes of an indentation tree and make an elidable text from it,
 * valuing nodes closer to nodes labeled "true" more highly.
 * @param tree
 */
export function fromTreeWithFocussedLines(
	tree: IndentationTree<boolean>,
	metadata?: Map<string, unknown>,
	tokenizer: Tokenizer = getTokenizer(),
	config: TreeTraversalConfig = DEFAULT_TREE_TRAVERSAL_CONFIG
): ElidableText {
	// go through the tree and relabel the nodes with their distance from the nearest "true" node
	const treeWithDistances = mapLabels(tree, (x: boolean) => (x ? (1 as number) : undefined));
	// traverse the tree bottomUp to add config.costUp to the labels of the parents
	visitTree(
		treeWithDistances,
		node => {
			if (isBlank(node)) { return; }
			const maxChildLabel = node.subs.reduce((memo, child) => Math.max(memo, child.label ?? 0), 0);
			node.label = Math.max(node.label ?? 0, maxChildLabel * config.worthUp);
		},
		'bottomUp'
	);
	// traverse the tree topDown and for all children, add config.costDown and config.costSibling
	visitTree(
		treeWithDistances,
		node => {
			if (isBlank(node)) {
				return;
			}
			const values = node.subs.map(sub => sub.label ?? 0);
			let new_values = [...values];
			for (let i = 0; i < values.length; i++) {
				if (values[i] === 0) {
					continue;
				} else {
					new_values = new_values.map((v, j) =>
						Math.max(v, Math.pow(config.worthSibling, Math.abs(i - j)) * values[i])
					);
				}
			}
			// add config.costDown
			const nodeLabel = node.label;
			if (nodeLabel !== undefined) {
				new_values = new_values.map(v => Math.max(v, config.worthDown * nodeLabel));
			}
			node.subs.forEach((sub, i) => (sub.label = new_values[i]));
		},
		'topDown'
	);
	return fromTreeWithValuedLines(treeWithDistances, metadata, tokenizer);
}

export function fromTreeWithValuedLines(
	tree: IndentationTree<number>,
	metadata?: Map<string, unknown>,
	tokenizer: Tokenizer = getTokenizer()
): ElidableText {
	const valuedLines = foldTree(
		tree,
		[] as [string, number][],
		(node, acc) => {
			if (node.type === 'line' || node.type === 'blank') {
				acc.push(node.type === 'line' ? [deparseLine(node).trimEnd(), node.label ?? 0] : ['', node.label ?? 0]);
			}
			return acc;
		},
		'topDown'
	);
	return new ElidableText(valuedLines, metadata, tokenizer);
}
