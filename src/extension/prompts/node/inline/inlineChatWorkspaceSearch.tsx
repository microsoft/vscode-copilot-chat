/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement, PromptSizing } from '@vscode/prompt-tsx';
import { KeywordItem, ResolvedWorkspaceChunkQuery } from '../../../../platform/workspaceChunkSearch/common/workspaceChunkSearch';
import { TelemetryCorrelationId } from '../../../../util/common/telemetryCorrelationId';
import { Diagnostic } from '../../../../vscodeTypes';
import { IDocumentContext } from '../../../prompt/node/documentContext';
import { ChunksToolProps, WorkspaceChunks } from '../panel/workspace/workspaceContext';

interface InlineChatWorkspaceSearchProps extends BasePromptElementProps {
	readonly documentContext: IDocumentContext;
	readonly diagnostics: Diagnostic[];
	readonly useWorkspaceChunksFromSelection?: boolean;
	readonly useWorkspaceChunksFromDiagnostics?: boolean;
}

export class InlineChatWorkspaceSearch extends PromptElement<InlineChatWorkspaceSearchProps> {

	render(state: void, sizing: PromptSizing) {
		const { useWorkspaceChunksFromSelection, useWorkspaceChunksFromDiagnostics } = this.props;

		if (!useWorkspaceChunksFromSelection && !useWorkspaceChunksFromDiagnostics) {
			return null;
		}

		let tokenBudget = sizing.tokenBudget;
		if (useWorkspaceChunksFromSelection && useWorkspaceChunksFromDiagnostics) {
			tokenBudget = tokenBudget / 2;
		}
		return (
			<>
				{useWorkspaceChunksFromSelection &&
					<WorkspaceChunks {...this.getChunkSearchPropsForSelection()} />}
				{useWorkspaceChunksFromDiagnostics &&
					<WorkspaceChunks {...this.getChunkSearchPropsForDiagnostics(tokenBudget)} />}
			</>
		);
	}

	private getChunkSearchPropsForSelection(): ChunksToolProps {
		const { document, wholeRange } = this.props.documentContext;
		let range = document.validateRange(wholeRange);
		this.props.diagnostics.forEach(d => {
			range = range.union(d.range);
		});
		const selectedText = document.getText(range);

		const query = [
			`Please find code that is similar to the following code block:\n`,
			'```',
			selectedText,
			'```'
		].join('\n');
		return {
			telemetryInfo: new TelemetryCorrelationId('InlineChatWorkspaceSearch::getChunkSearchPropsForSelection'),
			query: {
				rawQuery: query,
				resolveQueryAndKeywords: async (): Promise<ResolvedWorkspaceChunkQuery> => ({
					rephrasedQuery: query,
					keywords: getKeywordsForContent(selectedText),
				}),
				resolveQuery: async () => query,
			},
			// do not return matches in the current file
			globPatterns: { exclude: [document.uri.fsPath] }, // TODO: use relativePattern once supported
			maxResults: 3,
		};
	}

	private getChunkSearchPropsForDiagnostics(tokenBudget: number): ChunksToolProps {
		const document = this.props.documentContext.document;
		const messages = this.props.diagnostics.map(d => d.message).join(' ');
		const query = `Please find code that can help me fix the following problems: ${messages}`;
		return {
			telemetryInfo: new TelemetryCorrelationId('InlineChatWorkspaceSearch::getChunkSearchPropsForDiagnostics'),
			query: {
				rawQuery: query,
				resolveQueryAndKeywords: async (): Promise<ResolvedWorkspaceChunkQuery> => ({
					rephrasedQuery: query,
					keywords: getKeywordsForContent(messages),
				}),
				resolveQuery: async () => query,
			},
			// do not return matches in the current file
			globPatterns: { exclude: [document.uri.fsPath] },
			maxResults: 3,
		};
	}
}

function getKeywordsForContent(text: string): readonly KeywordItem[] {
	// extract all identifiers in the selected text
	const identifiers = new Set<string>();
	const keywordsRegex = /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g;
	let match;
	while ((match = keywordsRegex.exec(text)) !== null) {
		identifiers.add(match[0]);
	}
	return Array.from(identifiers.values(), k => ({ keyword: k, variations: [] }));
}
