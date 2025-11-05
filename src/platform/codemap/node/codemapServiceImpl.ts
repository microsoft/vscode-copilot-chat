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

		// Convert OverlayNode to CodemapNode
		const codemapStructure = this.convertToCodemapNode(structure);
		const summary = this.generateSummary(codemapStructure);

		return {
			structure: codemapStructure,
			summary
		};
	}

	private convertToCodemapNode(node: OverlayNode): CodemapNode {
		return {
			type: node.kind,
			range: {
				start: node.startIndex,
				end: node.endIndex
			},
			children: node.children?.map(child => this.convertToCodemapNode(child))
		};
	}

	private generateSummary(node: CodemapNode | undefined): string {
		if (!node) {
			return 'No structure available';
		}

		const counts = this.countNodeTypes(node);
		const parts: string[] = [];

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

		return parts.length > 0 ? parts.join(', ') : 'No major structures detected';
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
