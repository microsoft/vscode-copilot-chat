/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CompletionState, createCompletionState } from './completionState';
import { Context } from './context';
import { completionsFromGhostTextResults, CopilotCompletion } from './ghostText/copilotCompletion';
import { getGhostText, GetGhostTextOptions, ResultType } from './ghostText/ghostText';
import { setLastShown } from './ghostText/last';
import { ITextEditorOptions } from './ghostText/normalizeIndent';
import { SpeculativeRequestCache } from './ghostText/speculativeRequestCache';
import { GhostTextResultWithTelemetry, handleGhostTextResultTelemetry, logger } from './ghostText/telemetry';
import { ITextDocument, TextDocumentContents } from './textDocument';
import { CancellationToken, Position, Range } from 'vscode-languageserver-protocol';

type GetInlineCompletionsOptions = Partial<GetGhostTextOptions> & {
	formattingOptions?: ITextEditorOptions;
};

async function getInlineCompletionsResult(
	ctx: Context,
	completionState: CompletionState,
	token?: CancellationToken,
	options: GetInlineCompletionsOptions = {}
): Promise<GhostTextResultWithTelemetry<CopilotCompletion[]>> {
	let lineLengthIncrease = 0;
	// The golang.go extension (and quite possibly others) uses snippets for function completions, which collapse down
	// to look like empty function calls (e.g., `foo()`) in selectedCompletionInfo.text.  Injecting that directly into
	// the prompt produces low quality completions, so don't.
	if (options.selectedCompletionInfo?.text && !options.selectedCompletionInfo.text.includes(')')) {
		completionState = completionState.addSelectedCompletionInfo(options.selectedCompletionInfo);
		lineLengthIncrease = completionState.position.character - options.selectedCompletionInfo.range.end.character;
	}

	const result = await getGhostText(ctx, completionState, token, options);
	if (result.type !== 'success') { return result; }
	const [resultArray, resultType] = result.value;

	if (token?.isCancellationRequested) {
		return {
			type: 'canceled',
			reason: 'after getGhostText',
			telemetryData: { telemetryBlob: result.telemetryBlob },
		};
	}

	const index = setLastShown(ctx, completionState.textDocument, completionState.position, resultType);

	const completions = completionsFromGhostTextResults(
		ctx,
		resultArray,
		resultType,
		completionState.textDocument,
		completionState.position,
		options.formattingOptions,
		index
	);
	if (completions.length === 0) {
		// This is a backstop, most/all cases of an empty completions list should be caught earlier
		// TODO: figure out how this accounts for 7% of ghostText.empty when it looks unreachable
		return { type: 'empty', reason: 'no completions in final result', telemetryData: result.telemetryData };
	}

	// Speculatively request a new completion including the newly returned completion in the document
	if (resultType !== ResultType.TypingAsSuggested) {
		completionState = completionState.applyEdits([
			{
				newText: completions[0].insertText,
				range: completions[0].range,
			},
		]);

		// Cache speculative request to be triggered when telemetryShown is called
		const specOpts = { isSpeculative: true, opportunityId: options.opportunityId };
		const fn = () => getGhostText(ctx, completionState, undefined, specOpts);
		ctx.get(SpeculativeRequestCache).set(completions[0].clientCompletionId, fn);
	}

	const value = completions.map(completion => {
		const { start, end } = completion.range;
		const range = Range.create(start, Position.create(end.line, end.character - lineLengthIncrease));
		return { ...completion, range };
	});
	return { ...result, value };
}

export async function getInlineCompletions(
	ctx: Context,
	textDocument: ITextDocument,
	position: Position,
	token?: CancellationToken,
	options: Exclude<Partial<GetInlineCompletionsOptions>, 'promptOnly'> = {}
): Promise<CopilotCompletion[] | undefined> {
	logCompletionLocation(ctx, textDocument, position);

	const result = await getInlineCompletionsResult(ctx, createCompletionState(textDocument, position), token, options);
	return handleGhostTextResultTelemetry(ctx, result);
}

function logCompletionLocation(ctx: Context, textDocument: TextDocumentContents, position: Position) {
	const prefix = textDocument.getText({
		start: { line: Math.max(position.line - 1, 0), character: 0 },
		end: position,
	});
	const suffix = textDocument.getText({
		start: position,
		end: {
			line: Math.min(position.line + 2, textDocument.lineCount - 1),
			character: textDocument.lineCount - 1 > position.line ? 0 : position.character,
		},
	});

	logger.debug(
		ctx,
		`Requesting for ${textDocument.uri} at ${position.line}:${position.character}`,
		`between ${JSON.stringify(prefix)} and ${JSON.stringify(suffix)}.`
	);
}
