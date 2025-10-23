/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commentBlockAsSingles, getLanguageMarker, getPathMarker } from '../../../../prompt/src/languageMarker';
import { DocumentInfo } from '../../../../prompt/src/prompt';
import { CompletionState } from '../../completionState';
import { Context } from '../../context';
import { LRUCacheMap } from '../../helpers/cache';
import { TextDocumentManager } from '../../textDocumentManager';
import { setDefault } from '../../util/map';
import { CompletionsPromptOptions } from '../completionsPromptFactory/completionsPromptFactory';
import { ComponentSnapshot, VirtualPromptComponent } from '../components/virtualComponent';
import { EMPTY_NODE, RenderNode } from '../render/renderNode';
import { getAvailableNodeId } from '../render/utils';

// !!! This is an edited version of the workspace context prompt component and should be fully restored if kept !!!
export class WorkspaceContextPromptComponent implements VirtualPromptComponent {
	readonly name = 'workspaceContext';

	private root: RenderNode = EMPTY_NODE;
	private rootWithPathCache: LRUCacheMap<string, RenderNode> = new LRUCacheMap();

	constructor(private readonly ctx: Context) { }

	snapshot(options: CompletionsPromptOptions): ComponentSnapshot {
		const { completionState } = options;

		const root = setDefault(this.rootWithPathCache, completionState.textDocument.uri, () => {
			const pathMarker = this.getPathMarker(completionState);
			return {
				id: getAvailableNodeId(),
				text: [`${pathMarker}\n`, ''],
				children: [this.root],
				cost: 1,
				weight: 1,
				elisionMarker: '',
				canMerge: true,
				requireRenderedChild: false,
			};
		});
		return { root, mask: [] };
	}

	protected getPathMarker(completionState: CompletionState): string {
		const document = completionState.textDocument;

		const tdm = this.ctx.get(TextDocumentManager);
		const relativePath = tdm.getRelativePath(completionState.textDocument);
		const docInfo: DocumentInfo = {
			uri: document.uri,
			source: '', // We only need the URI
			relativePath,
			languageId: document.detectedLanguageId,
		};
		const notebook = tdm.findNotebook(document);
		if (docInfo.relativePath && !notebook) {
			return commentBlockAsSingles(getPathMarker(docInfo), docInfo.languageId);
		}
		return commentBlockAsSingles(getLanguageMarker(docInfo), docInfo.languageId);
	}
}
