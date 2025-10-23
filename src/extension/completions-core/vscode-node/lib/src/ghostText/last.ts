/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Context } from '../context';
import { Logger } from '../logger';
import { postInsertionTasks, postRejectionTasks } from '../postInsertion';
import { countLines, PartialAcceptTriggerKind, SuggestionStatus } from '../suggestions/partialSuggestions';
import { TelemetryWithExp } from '../telemetry';
import { IPosition, TextDocumentContents, TextDocumentIdentifier } from '../textDocument';
import { CopilotCompletion } from './copilotCompletion';
import { ResultType } from './ghostText';
import { PostInsertionCategory, telemetryShown } from './telemetry';

const ghostTextLogger = new Logger('ghostText');

export class LastGhostText {
	#position: IPosition | undefined;
	#uri: string | undefined;
	#shownCompletions: CopilotCompletion[] = [];
	index: number | undefined;
	totalLength: number | undefined;
	partiallyAcceptedLength: number | undefined;
	linesLeft: number | undefined; // Lines left to accept in the current completion, used for partial acceptance
	linesAccepted: number = 0; // Number of lines accepted in the current completion, used for partial acceptance
	lastLineAcceptedLength: number | undefined; // Length of the last accepted line, used for partial acceptance

	get position() {
		return this.#position;
	}

	get shownCompletions() {
		return this.#shownCompletions || [];
	}

	get uri() {
		return this.#uri;
	}

	resetState() {
		this.#uri = undefined;
		this.#position = undefined;
		this.#shownCompletions = [];
		this.resetPartialAcceptanceState();
	}

	setState({ uri }: TextDocumentIdentifier, position: IPosition) {
		this.#uri = uri;
		this.#position = position;
		this.#shownCompletions = [];
	}

	resetPartialAcceptanceState() {
		this.partiallyAcceptedLength = 0;
		this.totalLength = undefined;
		this.linesLeft = undefined;
		this.linesAccepted = 0;
	}
}

function computeRejectedCompletions<
	T extends { completionText: string; completionTelemetryData: TelemetryWithExp; offset: number },
>(last: LastGhostText): T[] {
	const rejectedCompletions: T[] = [];
	last.shownCompletions.forEach(c => {
		if (c.displayText && c.telemetry) {
			let completionText;
			let completionTelemetryData;

			if (last.partiallyAcceptedLength) {
				// suggestion got partially accepted already but rejecting the remainder
				completionText = c.displayText.substring(last.partiallyAcceptedLength - 1);
				completionTelemetryData = c.telemetry.extendedBy(
					{
						compType: 'partial',
					},
					{
						compCharLen: completionText.length,
					}
				);
			} else {
				completionText = c.displayText;
				completionTelemetryData = c.telemetry;
			}
			const rejection = { completionText, completionTelemetryData, offset: c.offset };
			rejectedCompletions.push(rejection as T);
		}
	});
	return rejectedCompletions;
}

export function rejectLastShown(ctx: Context, offset?: number) {
	const last = ctx.get(LastGhostText);
	if (!last.position || !last.uri) { return; }
	//The position has changed and we're not in typing-as-suggested flow
	// so previously shown completions can be reported as rejected
	const rejectedCompletions = computeRejectedCompletions(last);
	if (rejectedCompletions.length > 0) {
		postRejectionTasks(ctx, 'ghostText', offset ?? rejectedCompletions[0].offset, last.uri, rejectedCompletions);
	}
	last.resetState();
	last.resetPartialAcceptanceState();
}

export function setLastShown(
	ctx: Context,
	document: TextDocumentContents,
	position: IPosition,
	resultType: ResultType
) {
	const last = ctx.get(LastGhostText);
	if (
		last.position &&
		last.uri &&
		!(
			last.position.line === position.line &&
			last.position.character === position.character &&
			last.uri.toString() === document.uri.toString()
		) &&
		resultType !== ResultType.TypingAsSuggested // results for partial acceptance count as TypingAsSuggested
	) {
		rejectLastShown(ctx, document.offsetAt(last.position));
	}
	last.setState(document, position);
	return last.index;
}

export function handleGhostTextShown(ctx: Context, cmp: CopilotCompletion) {
	const last = ctx.get(LastGhostText);
	last.index = cmp.index;
	if (!last.shownCompletions.find(c => c.index === cmp.index)) {
		// Only update if .position is still at the position of the completion
		if (
			cmp.uri === last.uri &&
			last.position?.line === cmp.position.line &&
			last.position?.character === cmp.position.character
		) {
			last.shownCompletions.push(cmp);
		}
		// Show telemetry only if it was not shown before (i.e. don't sent repeated telemetry in cycling case when user cycled through every suggestions or goes back and forth)
		if (cmp.displayText) {
			const fromCache = !(cmp.resultType === ResultType.Network);
			ghostTextLogger.debug(
				ctx,
				`[${cmp.telemetry.properties.headerRequestId}] shown choiceIndex: ${cmp.telemetry.properties.choiceIndex}, fromCache ${fromCache}`
			);
			cmp.telemetry.measurements.compCharLen = cmp.displayText.length;
			telemetryShown(ctx, 'ghostText', cmp);
		}
	}
}

/**
 * Handles partial acceptance for VS Code clients using line-based strategy.
 * VS Code tracks acceptance by lines and resets the accepted length per line.
 */
function handleLineAcceptance(ctx: Context, cmp: CopilotCompletion, acceptedLength: number) {
	const last = ctx.get(LastGhostText);

	// If this is the first acceptance, we need to initialize the linesLeft
	if (last.linesLeft === undefined) {
		last.linesAccepted = countLines(cmp.insertText.substring(0, acceptedLength));
		last.linesLeft = countLines(cmp.displayText);
	}

	const linesLeft = countLines(cmp.displayText);

	if (last.linesLeft > linesLeft) {
		// If the number of lines left has decreased, we need to update the accepted lines count
		// and reset the last line accepted length
		last.linesAccepted += last.linesLeft - linesLeft;
		last.lastLineAcceptedLength = last.partiallyAcceptedLength;
		last.linesLeft = linesLeft;
	}

	last.partiallyAcceptedLength = (last.lastLineAcceptedLength || 0) + acceptedLength;
}

/**
 * Handles full acceptance of ghost text completions.
 * This method is primarily used by VS Code for explicit full acceptances.
 */
export function handleGhostTextPostInsert(
	ctx: Context,
	cmp: CopilotCompletion,
	triggerCategory: PostInsertionCategory = 'ghostText'
) {
	const last = ctx.get(LastGhostText);

	let suggestionStatus: SuggestionStatus;

	if (last.partiallyAcceptedLength) {
		suggestionStatus = {
			compType: 'full',
			acceptedLength: (last.partiallyAcceptedLength || 0) + cmp.displayText.length,
			acceptedLines: last.linesAccepted + (last.linesLeft ?? 0),
		};
	} else {
		suggestionStatus = {
			compType: 'full',
			acceptedLength: cmp.displayText.length,
			acceptedLines: countLines(cmp.displayText),
		};
	}

	//If any completion was accepted, clear the list of shown completions
	//that would be passed to rejected telemetry
	last.resetState();

	return postInsertionTasks(
		ctx,
		triggerCategory,
		cmp.displayText,
		cmp.offset,
		cmp.uri,
		cmp.telemetry,
		suggestionStatus,
		cmp.copilotAnnotations
	);
}

export function handlePartialGhostTextPostInsert(
	ctx: Context,
	cmp: CopilotCompletion,
	acceptedLength: number,
	triggerKind: PartialAcceptTriggerKind = PartialAcceptTriggerKind.Unknown,
	triggerCategory: PostInsertionCategory = 'ghostText',
) {
	const last = ctx.get(LastGhostText);

	handleLineAcceptance(ctx, cmp, acceptedLength);

	const suggestionStatus: SuggestionStatus = {
		compType: 'partial',
		acceptedLength: last.partiallyAcceptedLength || 0,
		acceptedLines: last.linesAccepted,
	};

	return postInsertionTasks(
		ctx,
		triggerCategory,
		cmp.displayText,
		cmp.offset,
		cmp.uri,
		cmp.telemetry,
		suggestionStatus,
		cmp.copilotAnnotations
	);
}
