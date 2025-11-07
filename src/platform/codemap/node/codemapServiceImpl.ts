/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { TextDocumentSnapshot } from '../../editing/common/textDocumentSnapshot';
import { OverlayNode } from '../../parser/node/nodes';
import { IParserService } from '../../parser/node/parserService';
import { Codemap, CodemapNode, ICodemapService } from '../common/codemapService';

export class CodemapServiceImpl implements ICodemapService {
	readonly _serviceBrand: undefined;

	constructor(
		@IParserService private readonly parserService: IParserService
	) { }

	async getCodemap(document: TextDocumentSnapshot, token: CancellationToken): Promise<Codemap | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const ast = this.parserService.getTreeSitterAST(document);
		if (!ast) {
			return undefined;
		}

		const structure = await ast.getStructure();
		if (!structure) {
			return undefined;
		}

		// Convert OverlayNode to CodemapNode with richer information
		const codemapStructure = this.convertToCodemapNode(structure, document);
		const summary = this.generateSummary(codemapStructure, document);

		return {
			structure: codemapStructure,
			summary
		};
	}

	private convertToCodemapNode(node: OverlayNode, document: TextDocumentSnapshot): CodemapNode {
		// Extract the actual text for this node to include names
		const name = this.extractNodeName(node, document);

		return {
			type: node.kind,
			name,
			range: {
				start: node.startIndex,
				end: node.endIndex
			},
			children: node.children?.map(child => this.convertToCodemapNode(child, document))
		};
	}

	private extractNodeName(node: OverlayNode, document: TextDocumentSnapshot): string | undefined {
		// For named nodes, try to extract the identifier
		// This helps the LLM understand what's where in the file
		const text = document.getText();
		const nodeText = text.substring(node.startIndex, Math.min(node.endIndex, node.startIndex + 100));

		// Common patterns for extracting names from different node types
		const patterns: Record<string, RegExp> = {
			'function_declaration': /function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
			'method_definition': /(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/,
			'class_declaration': /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
			'interface_declaration': /interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
			'type_alias_declaration': /type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
			'variable_declaration': /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
			'property_declaration': /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]/,
			'enum_declaration': /enum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/
		};

		const pattern = patterns[node.kind];
		if (pattern) {
			const match = nodeText.match(pattern);
			if (match && match[1]) {
				return match[1];
			}
		}

		return undefined;
	}

	private generateSummary(node: CodemapNode | undefined, document: TextDocumentSnapshot): string {
		if (!node) {
			return 'No structure available';
		}

		const counts = this.countNodeTypes(node);
		const namedElements = this.extractNamedElementsWithLines(node, document);
		const parts: string[] = [];

		// Count-based summary
		if (counts.class_declaration > 0) {
			parts.push(`${counts.class_declaration} class${counts.class_declaration > 1 ? 'es' : ''}`);
		}
		if (counts.function_declaration > 0 || counts.method_definition > 0) {
			const total = counts.function_declaration + counts.method_definition;
			parts.push(`${total} function${total > 1 ? 's' : ''}/method${total > 1 ? 's' : ''}`);
		}
		if (counts.interface_declaration > 0) {
			parts.push(`${counts.interface_declaration} interface${counts.interface_declaration > 1 ? 's' : ''}`);
		}

		const countSummary = parts.length > 0 ? parts.join(', ') : 'No major structures detected';

		// Named elements WITH LINE NUMBERS for better context
		const elementLines: string[] = [];
		if (namedElements.classes.length > 0) {
			elementLines.push(`Classes: ${namedElements.classes.map(e => `${e.name} (lines ${e.startLine}-${e.endLine})`).join(', ')}`);
		}
		if (namedElements.functions.length > 0) {
			const funcList = namedElements.functions.slice(0, 10).map(e => `${e.name} (line ${e.startLine})`).join(', ');
			elementLines.push(`Functions/Methods: ${funcList}${namedElements.functions.length > 10 ? '...' : ''}`);
		}
		if (namedElements.interfaces.length > 0) {
			elementLines.push(`Interfaces: ${namedElements.interfaces.map(e => `${e.name} (lines ${e.startLine}-${e.endLine})`).join(', ')}`);
		}

		if (elementLines.length > 0) {
			return `${countSummary}\n${elementLines.join('\n')}`;
		}

		return countSummary;
	}

	private extractNamedElementsWithLines(node: CodemapNode, document: TextDocumentSnapshot): {
		classes: Array<{ name: string; startLine: number; endLine: number }>;
		functions: Array<{ name: string; startLine: number; endLine: number }>;
		interfaces: Array<{ name: string; startLine: number; endLine: number }>;
	} {
		const classes: Array<{ name: string; startLine: number; endLine: number }> = [];
		const functions: Array<{ name: string; startLine: number; endLine: number }> = [];
		const interfaces: Array<{ name: string; startLine: number; endLine: number }> = [];

		const traverse = (n: CodemapNode) => {
			if (n.name && n.range) {
				const startLine = this.offsetToLine(n.range.start, document);
				const endLine = this.offsetToLine(n.range.end, document);

				if (n.type === 'class_declaration') {
					classes.push({ name: n.name, startLine, endLine });
				} else if (n.type === 'function_declaration' || n.type === 'method_definition') {
					functions.push({ name: n.name, startLine, endLine });
				} else if (n.type === 'interface_declaration') {
					interfaces.push({ name: n.name, startLine, endLine });
				}
			}
			n.children?.forEach(traverse);
		};

		traverse(node);
		return { classes, functions, interfaces };
	}

	private offsetToLine(offset: number, document: TextDocumentSnapshot): number {
		const text = document.getText();
		let line = 1;
		for (let i = 0; i < offset && i < text.length; i++) {
			if (text[i] === '\n') {
				line++;
			}
		}
		return line;
	}

	async getElementCode(document: TextDocumentSnapshot, elementName: string, codemap?: Codemap): Promise<{ code: string; lineRange: { start: number; end: number } } | undefined> {
		const map = codemap || await this.getCodemap(document, CancellationToken.None);
		if (!map || !map.structure) {
			return undefined;
		}

		// Find the element by name
		const element = this.findElementByName(map.structure, elementName);
		if (!element || !element.range) {
			return undefined;
		}

		const text = document.getText();
		const code = text.substring(element.range.start, element.range.end);
		const startLine = this.offsetToLine(element.range.start, document);
		const endLine = this.offsetToLine(element.range.end, document);

		return {
			code,
			lineRange: { start: startLine, end: endLine }
		};
	}

	private findElementByName(node: CodemapNode, name: string): CodemapNode | undefined {
		if (node.name === name) {
			return node;
		}

		if (node.children) {
			for (const child of node.children) {
				const found = this.findElementByName(child, name);
				if (found) {
					return found;
				}
			}
		}

		return undefined;
	}

	private countNodeTypes(node: CodemapNode): Record<string, number> {
		const counts: Record<string, number> = {};

		const traverse = (n: CodemapNode) => {
			counts[n.type] = (counts[n.type] || 0) + 1;
			n.children?.forEach(traverse);
		};

		traverse(node);
		return counts;
	}
}
