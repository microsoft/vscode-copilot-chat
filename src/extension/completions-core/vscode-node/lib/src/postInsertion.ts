/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { getLastCopilotToken } from './auth/copilotTokenManager';
import { ChangeTracker } from './changeTracker';
import { CitationManager, IPCitationDetail } from './citationManager';
import { createCompletionState } from './completionState';
import { Context } from './context';
import { FileReader } from './fileReader';
import { PostInsertionCategory, telemetryAccepted, telemetryRejected } from './ghostText/telemetry';
import { Logger } from './logger';
import { CopilotNamedAnnotationList } from './openai/stream';
import { contextIndentationFromText, indentationBlockFinished } from './prompt/parseBlock';
import { Prompt, extractPrompt } from './prompt/prompt';
import { fetchCitations } from './snippy/handlePostInsertion';
import { editDistance, lexEditDistance } from './suggestions/editDistance';
import { SuggestionStatus, computeCompletionText } from './suggestions/partialSuggestions';
import { TelemetryStore, TelemetryWithExp, telemetry, telemetryCatch } from './telemetry';
import { isRunningInTest } from './testing/runtimeMode';
import { TextDocumentManager } from './textDocumentManager';
import { PromiseQueue } from './util/promiseQueue';

const postInsertionLogger = new Logger('postInsertion');

type Timeout = {
	seconds: number;
	captureCode: boolean;
	captureRejection: boolean;
};
// windows for telemetry checks, in seconds
// captureCode = capture the code after acceptance,
// captureRejection = capture the code after rejection
const captureTimeouts: Timeout[] = [
	{ seconds: 15, captureCode: false, captureRejection: false },
	{ seconds: 30, captureCode: true, captureRejection: true },
	{ seconds: 120, captureCode: false, captureRejection: false },
	{ seconds: 300, captureCode: false, captureRejection: false },
	{ seconds: 600, captureCode: false, captureRejection: false },
];

// No. of chars before/after insertion point to look for the completion
const stillInCodeNearMargin = 50;
const stillInCodeFarMargin = 1500;

// If lex edit distance is below this fraction of completion length it is considered
// in the code
const stillInCodeFraction = 0.5;

// Number of characters captured after the insertion point.
// Used only if we couldn't detect termination point with indent-based parsing.
const captureCodeMargin = 500;

const postInsertConfiguration: {
	triggerPostInsertionSynchroneously: boolean;
	captureCode: boolean;
	captureRejection: boolean;
} = {
	triggerPostInsertionSynchroneously: false,
	captureCode: false,
	captureRejection: false,
};

async function captureCode(
	ctx: Context,
	uri: string,
	completionTelemetry: TelemetryWithExp,
	offset: number,
	suffixOffset?: number
): Promise<{ prompt: Prompt; capturedCode: string; terminationOffset: number }> {
	const result = await ctx.get(FileReader).getOrReadTextDocumentWithFakeClientProperties({ uri });
	if (result.status !== 'valid') {
		postInsertionLogger.info(ctx, `Could not get document for ${uri}. Maybe it was closed by the editor.`);
		return {
			prompt: {
				prefix: '',
				suffix: '',
				isFimEnabled: false,
			},
			capturedCode: '',
			terminationOffset: 0,
		};
	}
	const document = result.document;
	const documentText = document.getText();
	const documentTextBefore = documentText.substring(0, offset);
	const position = document.positionAt(offset);

	// Treat the code before offset as the hypothetical prompt
	const hypotheticalPromptResponse = await extractPrompt(
		ctx,
		completionTelemetry.properties.headerRequestId,
		createCompletionState(document, position),
		completionTelemetry
	);
	const hypotheticalPrompt =
		hypotheticalPromptResponse.type === 'prompt'
			? hypotheticalPromptResponse.prompt
			: {
				prefix: documentTextBefore,
				suffix: '',
				isFimEnabled: false,
			}; // TODO(eaftan): Pass an actual suffix when we're ready to support it

	if (hypotheticalPrompt.isFimEnabled && suffixOffset !== undefined) {
		// With FIM enabled, we can exactly determine capturedCode, suffix and prefix by propertly initialized trackers. No need to guess.
		const capturedCode = documentText.substring(offset, suffixOffset);
		hypotheticalPrompt.suffix = documentText.substring(suffixOffset);

		return { prompt: hypotheticalPrompt, capturedCode, terminationOffset: 0 };
	} else {
		//Everything after the insertion point is hypothetical response we could get from AI
		const hypotheticalResponse = documentText.substring(offset);

		//Try to find the termination offset in the hypothetical response using indentation based parsing
		const contextIndent = contextIndentationFromText(documentTextBefore, offset, document.detectedLanguageId);
		const indentTerminationFunction = indentationBlockFinished(contextIndent, undefined);
		const terminationResult = indentTerminationFunction(hypotheticalResponse);

		//If we could detect termination of the indentation block, capture 2x length of detected suggestion
		//Otherwise capture a lot of characters
		const maxOffset = Math.min(
			documentText.length,
			offset + (terminationResult ? terminationResult * 2 : captureCodeMargin)
		);

		const capturedCode = documentText.substring(offset, maxOffset);

		return { prompt: hypotheticalPrompt, capturedCode, terminationOffset: terminationResult ?? -1 };
	}
}

export function postRejectionTasks(
	ctx: Context,
	insertionCategory: PostInsertionCategory,
	insertionOffset: number,
	uri: string,
	completions: { completionText: string; completionTelemetryData: TelemetryWithExp }[]
) {
	//Send `.rejected` telemetry event for each rejected completion
	completions.forEach(({ completionText, completionTelemetryData }) => {
		postInsertionLogger.debug(
			ctx,
			`${insertionCategory}.rejected choiceIndex: ${completionTelemetryData.properties.choiceIndex}`
		);
		telemetryRejected(ctx, insertionCategory, completionTelemetryData);
	});

	const positionTracker = new ChangeTracker(ctx, uri, insertionOffset - 1);
	const suffixTracker = new ChangeTracker(ctx, uri, insertionOffset);

	const checkInCode = async (t: Timeout) => {
		postInsertionLogger.debug(
			ctx,
			`Original offset: ${insertionOffset}, Tracked offset: ${positionTracker.offset}`
		);
		const { completionTelemetryData } = completions[0];

		const { prompt, capturedCode, terminationOffset } = await captureCode(
			ctx,
			uri,
			completionTelemetryData,
			positionTracker.offset + 1,
			suffixTracker.offset
		);

		const promptTelemetry = {
			hypotheticalPromptJson: JSON.stringify({ prefix: prompt.prefix, context: prompt.context }),
			hypotheticalPromptSuffixJson: JSON.stringify(prompt.suffix),
		};

		const customTelemetryData = completionTelemetryData.extendedBy(
			{
				...promptTelemetry,
				capturedCodeJson: JSON.stringify(capturedCode),
			},
			{
				timeout: t.seconds,
				insertionOffset: insertionOffset,
				trackedOffset: positionTracker.offset,
				terminationOffsetInCapturedCode: terminationOffset,
			}
		);
		postInsertionLogger.debug(
			ctx,
			`${insertionCategory}.capturedAfterRejected choiceIndex: ${completionTelemetryData.properties.choiceIndex}`,
			customTelemetryData
		);
		telemetry(ctx, insertionCategory + '.capturedAfterRejected', customTelemetryData, TelemetryStore.Enhanced);
	};
	// Capture the code typed after we detected that completion was rejected,
	// Uses first displayed completion as the source/seed of telemetry information.
	captureTimeouts
		.filter(t => t.captureRejection)
		.map(t =>
			positionTracker.push(
				telemetryCatch(ctx, () => checkInCode(t), 'postRejectionTasks'),
				t.seconds * 1000
			)
		);
}

export function postInsertionTasks(
	ctx: Context,
	insertionCategory: PostInsertionCategory,
	completionText: string,
	insertionOffset: number,
	uri: string,
	telemetryData: TelemetryWithExp,
	suggestionStatus: SuggestionStatus,
	copilotAnnotations?: CopilotNamedAnnotationList
) {
	const telemetryDataWithStatus = telemetryData.extendedBy(
		{
			compType: suggestionStatus.compType,
		},
		{
			compCharLen: suggestionStatus.acceptedLength,
			numLines: suggestionStatus.acceptedLines,
		}
	);
	// send ".accepted" telemetry
	postInsertionLogger.debug(
		ctx,
		`${insertionCategory}.accepted choiceIndex: ${telemetryDataWithStatus.properties.choiceIndex}`
	);
	telemetryAccepted(ctx, insertionCategory, telemetryDataWithStatus);

	const fullCompletionText = completionText;
	completionText = computeCompletionText(completionText, suggestionStatus);
	const trimmedCompletion = completionText.trim();
	const tracker = new ChangeTracker(ctx, uri, insertionOffset);
	const suffixTracker = new ChangeTracker(ctx, uri, insertionOffset + completionText.length);

	const stillInCodeCheck = async (timeout: Timeout) => {
		const check = checkStillInCode(
			ctx,
			insertionCategory,
			trimmedCompletion,
			insertionOffset,
			uri,
			timeout,
			telemetryDataWithStatus,
			tracker,
			suffixTracker
		);
		await check;
	};

	// For test purposes, we add one set of these telemetry events synchronously to allow asserting the telemetry
	if (postInsertConfiguration.triggerPostInsertionSynchroneously && isRunningInTest(ctx)) {
		const check = stillInCodeCheck({
			seconds: 0,
			captureCode: postInsertConfiguration.captureCode,
			captureRejection: postInsertConfiguration.captureRejection,
		});
		ctx.get(PromiseQueue).register(check);
	} else {
		captureTimeouts.map(timeout =>
			tracker.push(
				telemetryCatch(ctx, () => stillInCodeCheck(timeout), 'postInsertionTasks'),
				timeout.seconds * 1000
			)
		);
	}

	telemetryCatch(ctx, citationCheck, 'post insertion citation check')(
		ctx,
		uri,
		fullCompletionText,
		completionText,
		insertionOffset,
		copilotAnnotations
	);
}

async function citationCheck(
	ctx: Context,
	uri: string,
	fullCompletionText: string,
	insertedText: string,
	insertionOffset: number,
	copilotAnnotations?: CopilotNamedAnnotationList
) {
	// If there are no citations, request directly from the snippy service
	if (!copilotAnnotations || (copilotAnnotations.ip_code_citations?.length ?? 0) < 1) {
		// Do not request citations if in blocking mode
		if (getLastCopilotToken(ctx)?.getTokenValue('sn') === '1') { return; }
		await fetchCitations(ctx, uri, insertedText, insertionOffset);
		return;
	}

	const doc = await ctx.get(TextDocumentManager).getTextDocument({ uri });

	// in the CLS, if the editor does not wait to send document updates until the
	// acceptance function returns, we could be in a race condition with ongoing
	// edits. This searches for the completion text so that hopefully we're providing
	// an exact location in a known version of the document.
	if (doc) {
		const found = find(doc.getText(), insertedText, stillInCodeNearMargin, insertionOffset);
		if (found.stillInCodeHeuristic) {
			insertionOffset = found.foundOffset;
		}
	}

	for (const citation of copilotAnnotations.ip_code_citations) {
		const citationStart = computeCitationStart(
			fullCompletionText.length,
			insertedText.length,
			citation.start_offset
		);
		if (citationStart === undefined) {
			postInsertionLogger.info(
				ctx,
				`Full completion for ${uri} contains a reference matching public code, but the partially inserted text did not include the match.`
			);
			continue;
		}
		const offsetStart = insertionOffset + citationStart;
		const start = doc?.positionAt(offsetStart);
		const offsetEnd =
			insertionOffset + computeCitationEnd(fullCompletionText.length, insertedText.length, citation.stop_offset);
		const end = doc?.positionAt(offsetEnd);
		const text = start && end ? doc?.getText({ start, end }) : '<unknown>';

		await ctx.get(CitationManager).handleIPCodeCitation(ctx, {
			inDocumentUri: uri,
			offsetStart,
			offsetEnd,
			version: doc?.version,
			location: start && end ? { start, end } : undefined,
			matchingText: text,
			details: citation.details.citations as IPCitationDetail[],
		});
	}
}

function computeCitationStart(
	completionLength: number,
	insertedLength: number,
	citationStartOffset: number
): number | undefined {
	if (insertedLength < completionLength && citationStartOffset > insertedLength) {
		return undefined;
	}
	return citationStartOffset;
}

function computeCitationEnd(completionLength: number, insertedLength: number, citationStopOffset: number): number {
	if (insertedLength < completionLength) {
		return Math.min(citationStopOffset, insertedLength);
	}
	return citationStopOffset;
}

function find(documentText: string, completion: string, margin: number, offset: number) {
	// Compute the best alignment between a window of the document text and the completion
	const window = documentText.substring(
		Math.max(0, offset - margin),
		Math.min(documentText.length, offset + completion.length + margin)
	);
	const lexAlignment = lexEditDistance(window, completion);
	const fraction = lexAlignment.lexDistance / lexAlignment.needleLexLength;
	const { distance: charEditDistance } = editDistance(
		window.substring(lexAlignment.startOffset, lexAlignment.endOffset),
		completion
	);
	return {
		relativeLexEditDistance: fraction,
		charEditDistance,
		completionLexLength: lexAlignment.needleLexLength,
		foundOffset: lexAlignment.startOffset + Math.max(0, offset - margin),
		lexEditDistance: lexAlignment.lexDistance,
		stillInCodeHeuristic: fraction <= stillInCodeFraction ? 1 : 0,
	};
}

async function checkStillInCode(
	ctx: Context,
	insertionCategory: string,
	completion: string,
	insertionOffset: number, // offset where the completion was inserted to
	uri: string,
	timeout: Timeout,
	telemetryData: TelemetryWithExp,
	tracker: ChangeTracker,
	suffixTracker: ChangeTracker
) {
	// Get contents of file from file system
	const result = await ctx.get(FileReader).getOrReadTextDocument({ uri });
	if (result.status === 'valid') {
		const document = result.document;
		const documentText = document.getText();

		// We try twice, first very close to the insertion point, then a bit
		// further. This is to increase accuracy for short completions,
		// where the completion might appear elsewhere.
		let finding = find(documentText, completion, stillInCodeNearMargin, tracker.offset);
		if (!finding.stillInCodeHeuristic) {
			finding = find(documentText, completion, stillInCodeFarMargin, tracker.offset);
		}
		// Debug and log a binary decision
		postInsertionLogger.debug(
			ctx,
			`stillInCode: ${finding.stillInCodeHeuristic ? 'Found' : 'Not found'}! Completion '${completion}' in file ${uri
			}. lexEditDistance fraction was ${finding.relativeLexEditDistance}. Char edit distance was ${finding.charEditDistance
			}. Inserted at ${insertionOffset}, tracked at ${tracker.offset}, found at ${finding.foundOffset
			}. choiceIndex: ${telemetryData.properties.choiceIndex}`
		);
		// Log all the details for analysis
		const customTelemetryData = telemetryData
			.extendedBy({}, { timeout: timeout.seconds, insertionOffset: insertionOffset, trackedOffset: tracker.offset })
			.extendedBy({}, finding);
		telemetry(ctx, insertionCategory + '.stillInCode', customTelemetryData);

		if (timeout.captureCode) {
			const { prompt, capturedCode, terminationOffset } = await captureCode(
				ctx,
				uri,
				customTelemetryData,
				tracker.offset,
				suffixTracker.offset
			);
			const promptTelemetry = {
				hypotheticalPromptJson: JSON.stringify({ prefix: prompt.prefix, context: prompt.context }),
				hypotheticalPromptSuffixJson: JSON.stringify(prompt.suffix),
			};

			const afterAcceptedTelemetry = telemetryData.extendedBy(
				{
					...promptTelemetry,
					capturedCodeJson: JSON.stringify(capturedCode),
				},
				{
					timeout: timeout.seconds,
					insertionOffset: insertionOffset,
					trackedOffset: tracker.offset,
					terminationOffsetInCapturedCode: terminationOffset,
				}
			);
			postInsertionLogger.debug(
				ctx,
				`${insertionCategory}.capturedAfterAccepted choiceIndex: ${telemetryData.properties.choiceIndex}`,
				customTelemetryData
			);
			telemetry(
				ctx,
				insertionCategory + '.capturedAfterAccepted',
				afterAcceptedTelemetry,
				TelemetryStore.Enhanced
			);
		}
	}
}
