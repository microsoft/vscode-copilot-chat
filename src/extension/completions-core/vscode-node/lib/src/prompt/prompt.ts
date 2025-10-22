/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptMetadata } from '../../../prompt/src/components/components';
import { commentBlockAsSingles } from '../../../prompt/src/languageMarker';
import { PromptOptions } from '../../../prompt/src/prompt';
import { SimilarFilesOptions } from '../../../prompt/src/snippetInclusion/similarFiles';
import { TokenizerName } from '../../../prompt/src/tokenization';
import { CancellationToken as ICancellationToken } from '../../../types/src';
import { CompletionState } from '../completionState';
import { Context } from '../context';
import { Features } from '../experiments/features';
import { getNumberOfSnippets, getSimilarFilesOptions } from '../experiments/similarFileOptionsProvider';
import { getMaxSolutionTokens } from '../openai/openai';
import { TelemetryWithExp } from '../telemetry';
import { INotebookCell, INotebookDocument, IntelliSenseInsertion } from '../textDocument';
import { TextDocumentManager } from '../textDocumentManager';
import { CompletionsPromptFactory } from './completionsPromptFactory/completionsPromptFactory';
import { shouldUseSplitContextPrompt } from './components/splitContextPrompt';
import { ContextProviderTelemetry } from './contextProviderRegistry';
import { NeighboringFileType, considerNeighborFile } from './similarFiles/neighborFiles';

// The minimum number of prompt-eligible characters before we offer a completion
export const MIN_PROMPT_CHARS = 10;

export interface Prompt {
	prefix: string;
	suffix: string;
	context?: string[];
	prefixTokens?: number;
	suffixTokens?: number;
	isFimEnabled: boolean;
}

export interface PromptResponsePresent {
	type: 'prompt';
	prompt: Prompt;
	/**
	 * The prefix is sent to the model without trailing whitespace. However the trailing whitespace will
	 * be kept around to do position adjustments when applying the completion.
	 */
	trailingWs: string;
	computeTimeMs: number;
	// evaluate whether we need to keep this. If yes, populate it
	neighborSource: Map<NeighboringFileType, string[]>;
	metadata: PromptMetadata;
	contextProvidersTelemetry?: ContextProviderTelemetry[];
}

export interface ExtractPromptOptions {
	selectedCompletionInfo?: IntelliSenseInsertion;
	data?: unknown;
	tokenizer?: TokenizerName;
}

interface ContextTooShort {
	type: 'contextTooShort';
}
interface CopilotContentExclusion {
	type: 'copilotContentExclusion';
}
interface PromptError {
	type: 'promptError';
}
interface PromptCancelled {
	type: 'promptCancelled';
}

interface PromptTimeout {
	type: 'promptTimeout';
}

export const _contextTooShort: ContextTooShort = { type: 'contextTooShort' };
export const _copilotContentExclusion: CopilotContentExclusion = { type: 'copilotContentExclusion' };
export const _promptError: PromptError = { type: 'promptError' };
export const _promptCancelled: PromptCancelled = { type: 'promptCancelled' };
export const _promptTimeout: PromptTimeout = { type: 'promptTimeout' };
export type PromptResponse =
	| PromptResponsePresent
	| CopilotContentExclusion
	| ContextTooShort
	| PromptError
	| PromptCancelled
	| PromptTimeout;

/** Record trailing whitespace, and trim it from prompt if the last line is only whitespace */
export function trimLastLine(source: string): [string, string] {
	const lines = source.split('\n');
	const lastLine = lines[lines.length - 1];
	const extraSpace: number = lastLine.length - lastLine.trimEnd().length;
	const promptTrim = source.slice(0, source.length - extraSpace);
	const trailingWs = source.slice(promptTrim.length);
	const resPrompt = lastLine.length === extraSpace ? promptTrim : source;
	return [resPrompt, trailingWs];
}

export function extractPrompt(
	ctx: Context,
	completionId: string,
	completionState: CompletionState,
	telemetryData: TelemetryWithExp,
	cancellationToken?: ICancellationToken,
	promptOpts: ExtractPromptOptions = {}
): Promise<PromptResponse> {
	const workspace = ctx.get(TextDocumentManager);
	const notebook = workspace.findNotebook(completionState.textDocument);
	const activeCell = notebook?.getCellFor(completionState.textDocument);
	if (notebook && activeCell) {
		completionState = applyEditsForNotebook(completionState, notebook, activeCell);
	}

	telemetryData.extendWithConfigProperties(ctx);
	telemetryData.sanitizeKeys();
	const separateContext = shouldUseSplitContextPrompt(ctx, telemetryData);
	const promptFactory = ctx.get(CompletionsPromptFactory);
	return promptFactory.prompt(
		{
			completionId,
			completionState,
			telemetryData,
			promptOpts: { ...promptOpts, separateContext },
		},
		cancellationToken
	);
}

function addNeighboringCellsToPrompt(neighboringCell: INotebookCell, activeCellLanguageId: string) {
	const languageId = neighboringCell.document.detectedLanguageId;
	const text = neighboringCell.document.getText();
	if (languageId === activeCellLanguageId) {
		// Blocks of the same language are added as is
		return text;
	} else {
		// Consider adding a languageMarker to cells of different languages
		// Note, that comments should be added with markers from the language of the active cell!
		return commentBlockAsSingles(text, activeCellLanguageId);
	}
}

function applyEditsForNotebook(state: CompletionState, notebook: INotebookDocument, activeCell: INotebookCell) {
	const cells = notebook.getCells();
	const beforeCells = cells.filter(
		cell =>
			cell.index < activeCell.index &&
			considerNeighborFile(activeCell.document.detectedLanguageId, cell.document.detectedLanguageId)
	);
	const newText =
		beforeCells.length > 0
			? beforeCells
				.map(cell => addNeighboringCellsToPrompt(cell, activeCell.document.detectedLanguageId))
				.join('\n\n') + '\n\n'
			: '';
	const top = { line: 0, character: 0 };
	return state.applyEdits([{ newText, range: { start: top, end: top } }]);
}

export function getPromptOptions(ctx: Context, telemetryData: TelemetryWithExp, languageId: string): PromptOptions {
	// Note: the default values of the EXP flags currently overwrite the default `PromptOptions`
	const maxTokens = ctx.get(Features).maxPromptCompletionTokens(telemetryData);
	const maxPromptLength = maxTokens - getMaxSolutionTokens(ctx);

	const numberOfSnippets = getNumberOfSnippets(telemetryData, languageId);
	const similarFilesOptions: SimilarFilesOptions = getSimilarFilesOptions(ctx, telemetryData, languageId);

	const suffixPercent = ctx.get(Features).suffixPercent(telemetryData);
	const suffixMatchThreshold = ctx.get(Features).suffixMatchThreshold(telemetryData);

	if (suffixPercent < 0 || suffixPercent > 100) {
		throw new Error(`suffixPercent must be between 0 and 100, but was ${suffixPercent}`);
	}

	if (suffixMatchThreshold < 0 || suffixMatchThreshold > 100) {
		throw new Error(`suffixMatchThreshold must be between 0 and 100, but was ${suffixMatchThreshold}`);
	}

	return {
		maxPromptLength,
		similarFilesOptions,
		numberOfSnippets,
		suffixPercent,
		suffixMatchThreshold,
	};
}
