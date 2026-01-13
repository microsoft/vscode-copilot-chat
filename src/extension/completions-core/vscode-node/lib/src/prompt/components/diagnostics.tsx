/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** @jsxRuntime automatic */
/** @jsxImportSource ../../../../prompt/jsx-runtime/ */

import type { Diagnostic } from 'vscode';
import { Chunk, ComponentContext, PromptElementProps, Text } from '../../../../prompt/src/components/components';
import { normalizeLanguageId } from '../../../../prompt/src/prompt';
import type { ICompletionsTextDocumentManagerService } from '../../textDocumentManager';
import {
	CompletionRequestData,
	isCompletionRequestData,
} from '../completionsPromptFactory/componentsCompletionsPromptFactory';
import { type DiagnosticChunkWithId } from '../contextProviders/contextItemSchemas';


function getCode(diagnostic: Diagnostic): string | undefined {
	if (diagnostic.code === undefined) {
		return undefined;
	}
	if (typeof diagnostic.code === 'string') {
		return diagnostic.code;
	}
	if (typeof diagnostic.code === 'number') {
		return diagnostic.code.toString();
	}
	if (typeof diagnostic.code === 'object' && diagnostic.code !== null && diagnostic.code.value) {
		return diagnostic.code.value.toString();
	}
	return undefined;
}

function getRelativePath(tdm: ICompletionsTextDocumentManagerService, item: DiagnosticChunkWithId): string {
	return tdm.getRelativePath({ uri: item.uri.toString() }) ?? item.uri.fsPath;
}

type DiagnosticsProps = {
	tdms: ICompletionsTextDocumentManagerService;
} & PromptElementProps;


export const Diagnostics = (props: DiagnosticsProps, context: ComponentContext) => {
	const [diagnostics, setDiagnostics] = context.useState<DiagnosticChunkWithId[]>();
	const [languageId, setLanguageId] = context.useState<string>();

	context.useData(isCompletionRequestData, (data: CompletionRequestData) => {
		if (data.diagnostics !== diagnostics) {
			setDiagnostics(data.diagnostics);
		}

		const normalizedLanguageId = normalizeLanguageId(data.document.detectedLanguageId);
		if (normalizedLanguageId !== languageId) {
			setLanguageId(normalizedLanguageId);
		}
	});

	if (!diagnostics || diagnostics.length === 0 || !languageId) {
		return;
	}
	const validChunks = diagnostics.filter(diagnostic => diagnostic.values.length > 0);
	if (validChunks.length === 0) {
		return;
	}

	// Sort by importance, with the most important first
	validChunks.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
	// Reverse the order so the most important snippet is last. Note, that we don't directly
	// sort in ascending order to handle importance 0 correctly.
	validChunks.reverse();

	return validChunks.map(diagnosticChunk => {
		const elements = [];
		elements.push(
			<Text key={diagnosticChunk.id} source={diagnosticChunk}>
				{`Consider the following ${languageId} diagnostics from ${getRelativePath(props.tdms, diagnosticChunk)}:\n`}
			</Text>
		);
		diagnosticChunk.values.forEach(diagnostic => {
			let codeStr = '';
			const code = getCode(diagnostic);
			if (code !== undefined) {
				const source = diagnostic.source ? diagnostic.source.toUpperCase() : '';
				codeStr = `${source} ${code}`;
			}
			const start = diagnostic.range.start;
			elements.push(
				<Text>
					{`${start.line + 1}:${start.character + 1} - ${diagnostic.severity} ${codeStr}: ${diagnostic.message}`}
				</Text>
			);
		});
		// TODO: use a `KeepTogether` elision that removes the header if no traits are present
		return <Chunk>{elements}</Chunk>;
	});
};