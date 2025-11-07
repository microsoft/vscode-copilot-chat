/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { TextDocumentSnapshot } from '../../editing/common/textDocumentSnapshot';
import { OverlayNode } from '../../parser/node/nodes';
import { IParserService } from '../../parser/node/parserService';
import { Codemap, CodemapNode, ICodemapService, LanguageMetadata, StructuredCodemap } from '../common/codemapService';

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
		const structured = this.generateStructuredCodemap(codemapStructure, document);

		return {
			structure: codemapStructure,
			summary,
			structured
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
		if ((counts.function_declaration || 0) > 0 || (counts.method_definition || 0) > 0) {
			const total = (counts.function_declaration || 0) + (counts.method_definition || 0);
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

	private generateStructuredCodemap(node: CodemapNode, document: TextDocumentSnapshot): StructuredCodemap {
		const classes: StructuredCodemap['classes'] = [];
		const functions: StructuredCodemap['functions'] = [];
		const interfaces: StructuredCodemap['interfaces'] = [];
		let reactHooksCount = 0;
		let asyncFunctionsCount = 0;
		let componentsCount = 0;

		// Track function depth to limit how deep we look for nested functions
		// Depth 3 is needed for React components where helper functions are defined inside the component:
		// depth=1: function_declaration (Component), depth=2: statement_block, depth=3: lexical_declaration with arrow functions
		const processNode = (n: CodemapNode, parentClass?: { name: string; range: { start: number; end: number }; methods: any[]; properties: any[] }, depth: number = 0) => {
			if (n.type === 'class_declaration' && n.name && n.range) {
				const classInfo = {
					name: n.name,
					range: { start: this.offsetToLine(n.range.start, document), end: this.offsetToLine(n.range.end, document) },
					methods: [] as Array<{ name: string; line: number }>,
					properties: [] as Array<{ name: string; line: number }>
				};
				classes.push(classInfo);

				// Process children within this class
				n.children?.forEach(child => processNode(child, classInfo, depth + 1));
			} else if (n.type === 'interface_declaration' && n.name && n.range) {
				interfaces.push({
					name: n.name,
					range: { start: this.offsetToLine(n.range.start, document), end: this.offsetToLine(n.range.end, document) }
				});
			} else if (n.type === 'method_definition' && n.name && n.range) {
				const line = this.offsetToLine(n.range.start, document);
				const metadata = this.extractLanguageMetadata(n, document);
				if (metadata.isAsync) {
					asyncFunctionsCount++;
				}
				if (metadata.reactHooks && metadata.reactHooks.length > 0) {
					reactHooksCount += metadata.reactHooks.length;
				}
				if (metadata.returnsJSX) {
					componentsCount++;
				}
				if (parentClass) {
					parentClass.methods.push({ name: n.name, line, metadata: Object.keys(metadata).length > 0 ? metadata : undefined });
				}
			} else if ((n.type === 'property_declaration' || n.type === 'public_field_definition') && n.name && n.range) {
				const line = this.offsetToLine(n.range.start, document);
				if (parentClass) {
					parentClass.properties.push({ name: n.name, line });
				}
			} else if (n.type === 'function_declaration' && n.name && n.range) {
				const line = this.offsetToLine(n.range.start, document);
				const metadata = this.extractLanguageMetadata(n, document);
				if (metadata.isAsync) {
					asyncFunctionsCount++;
				}
				if (metadata.reactHooks && metadata.reactHooks.length > 0) {
					reactHooksCount += metadata.reactHooks.length;
				}
				if (metadata.returnsJSX) {
					componentsCount++;
				}
				functions.push({
					name: n.name,
					line,
					metadata: Object.keys(metadata).length > 0 ? metadata : undefined
				});
				// IMPORTANT: Recurse into function body to find nested arrow functions
				n.children?.forEach(child => processNode(child, parentClass, depth + 1));
			} else if (n.type === 'variable_declarator' && n.name && n.range && n.children) {
				// Handle arrow functions: const myFunc = () => {}
				// Check if this variable has an arrow_function or function child
				const hasFunction = n.children.some(c =>
					c.type === 'arrow_function' ||
					c.type === 'function' ||
					c.type === 'function_expression'
				);
				if (hasFunction && depth <= 3) {  // Depth 3 for React helper functions inside components
					const line = this.offsetToLine(n.range.start, document);
					const metadata = this.extractLanguageMetadata(n, document);
					if (metadata.isAsync) {
						asyncFunctionsCount++;
					}
					if (metadata.reactHooks && metadata.reactHooks.length > 0) {
						reactHooksCount += metadata.reactHooks.length;
					}
					if (metadata.returnsJSX) {
						componentsCount++;
					}
					functions.push({
						name: n.name,
						line,
						metadata: Object.keys(metadata).length > 0 ? metadata : undefined
					});
				}
				// Always recurse into children
				n.children?.forEach(child => processNode(child, parentClass, depth + 1));
			} else {
				// Recurse for other node types
				n.children?.forEach(child => processNode(child, parentClass, depth + 1));
			}
		};

		processNode(node, undefined, 0);

		const patterns = {
			reactHooksCount: reactHooksCount > 0 ? reactHooksCount : undefined,
			asyncFunctionsCount: asyncFunctionsCount > 0 ? asyncFunctionsCount : undefined,
			componentsCount: componentsCount > 0 ? componentsCount : undefined
		};

		return {
			classes,
			functions,
			interfaces,
			patterns: (patterns.reactHooksCount || patterns.asyncFunctionsCount || patterns.componentsCount) ? patterns : undefined
		};
	}

	private extractLanguageMetadata(node: CodemapNode, document: TextDocumentSnapshot): LanguageMetadata {
		if (!node.range) {
			return {};
		}

		const text = document.getText();
		const nodeText = text.substring(node.range.start, Math.min(node.range.end, node.range.start + 500));
		const metadata: LanguageMetadata = {};

		// Detect async functions/methods
		if (/\basync\s+(function|\(|[a-zA-Z_$])/.test(nodeText)) {
			metadata.isAsync = true;
		}

		// Detect React hooks (useState, useEffect, useCallback, etc.)
		const hookMatches = nodeText.match(/\b(use[A-Z][a-zA-Z]*)\s*\(/g);
		if (hookMatches) {
			const hooks = hookMatches.map(h => h.replace(/\s*\($/, ''));
			// Filter to known React hooks
			const knownHooks = hooks.filter(h =>
				['useState', 'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext',
					'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue'].includes(h)
			);
			if (knownHooks.length > 0) {
				metadata.reactHooks = [...new Set(knownHooks)]; // Deduplicate
			}
		}

		// Detect JSX return (React components)
		if (/return\s+[(<]/.test(nodeText) && /<[A-Z]/.test(nodeText)) {
			metadata.returnsJSX = true;
		}

		// Detect decorators (TypeScript/Python style)
		const decoratorMatches = nodeText.match(/@[a-zA-Z_$][a-zA-Z0-9_$]*/g);
		if (decoratorMatches) {
			metadata.decorators = [...new Set(decoratorMatches)];
		}

		return metadata;
	}
}
