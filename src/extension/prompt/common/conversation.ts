/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PromptReference, Raw } from '@vscode/prompt-tsx';
import type { ChatRequestEditedFileEvent, ChatResponseStream, ChatResult, LanguageModelToolResult } from 'vscode';
import { FilterReason } from '../../../platform/networking/common/openai';
import { isLocation, toLocation } from '../../../util/common/types';
import { ResourceMap } from '../../../util/vs/base/common/map';
import { assertType } from '../../../util/vs/base/common/types';
import { URI } from '../../../util/vs/base/common/uri';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { Location, Range } from '../../../vscodeTypes';
import { InternalToolReference, IToolCallRound } from '../common/intents';
import { ChatVariablesCollection } from './chatVariablesCollection';
import { ToolCallRound } from './toolCallRound';
export { PromptReference } from '@vscode/prompt-tsx';

export enum TurnStatus {
	InProgress = 'in-progress',
	Success = 'success',
	Cancelled = 'cancelled',
	OffTopic = 'off-topic',
	Filtered = 'filtered',
	PromptFiltered = 'prompt-filtered',
	Error = 'error',
}

export type TurnMessage = {
	readonly type: 'user' | 'follow-up' | 'template' | 'offtopic-detection' | 'model' | 'meta' | 'server';
	readonly name?: string;
	/* readonly  */message: string;
};


export abstract class PromptMetadata {
	readonly _marker: undefined;
	toString(): string {
		return Object.getPrototypeOf(this).constructor.name;
	}
}

export class RequestDebugInformation {
	constructor(
		readonly uri: URI,
		readonly intentId: string,
		readonly languageId: string,
		readonly initialDocumentText: string,
		readonly userPrompt: string,
		readonly userSelection: Range
	) { }
}

export class Turn {

	private _references: readonly PromptReference[] = [];

	private _responseInfo?: { message: TurnMessage | undefined; status: TurnStatus; responseId: string | undefined; chatResult?: ChatResult };

	private readonly _metadata = new Map<any, any[]>();

	public readonly startTime = Date.now();

	constructor(
		readonly id: string = generateUuid(),
		readonly request: TurnMessage,
		private readonly _promptVariables: ChatVariablesCollection | undefined = undefined,
		private readonly _toolReferences: readonly InternalToolReference[] = [],
		readonly editedFileEvents?: ChatRequestEditedFileEvent[]
	) { }

	get promptVariables(): ChatVariablesCollection | undefined {
		return this._promptVariables;
	}

	get toolReferences(): readonly InternalToolReference[] {
		return this._toolReferences;
	}

	get references(): readonly PromptReference[] {
		return this._references;
	}

	addReferences(newReferences: readonly PromptReference[]) {
		this._references = getUniqueReferences([...this._references, ...newReferences]);
	}

	// --- response

	get responseMessage(): TurnMessage | undefined {
		return this._responseInfo?.message;
	}

	get responseStatus(): TurnStatus {
		return this._responseInfo?.status ?? TurnStatus.InProgress;
	}

	get responseId(): string | undefined {
		return this._responseInfo?.responseId;
	}

	get responseChatResult(): ChatResult | undefined {
		return this._responseInfo?.chatResult;
	}

	get resultMetadata(): Partial<IResultMetadata> | undefined {
		return this._responseInfo?.chatResult?.metadata;
	}

	get renderedUserMessage(): string | Raw.ChatCompletionContentPart[] | undefined {
		const metadata = this.resultMetadata;
		return metadata?.renderedUserMessage;
	}

	get rounds(): readonly IToolCallRound[] {
		const metadata = this.resultMetadata;
		const rounds = metadata?.toolCallRounds;
		if (!rounds || rounds.length === 0) {
			// Should always have at least one round
			const response = this.responseMessage?.message ?? '';
			return [new ToolCallRound(response, [], undefined, this.id)];
		}

		return rounds;
	}

	setResponse(status: TurnStatus, message: TurnMessage | undefined, responseId: string | undefined, chatResult: ChatResult | undefined) {
		if (this._responseInfo?.status === TurnStatus.Cancelled) {
			// The cancelled result can be assigned from inside ToolCallingLoop
			return;
		}

		assertType(!this._responseInfo);
		this._responseInfo = { message, status, responseId, chatResult };
	}


	// --- metadata

	getMetadata<T extends object>(key: new (...args: any[]) => T): T | undefined {
		return this._metadata.get(key)?.at(-1);
	}

	getAllMetadata<T extends object>(key: new (...args: any[]) => T): T[] | undefined {
		return this._metadata.get(key);
	}

	setMetadata<T extends object>(value: T): void {
		const key = Object.getPrototypeOf(value).constructor;
		const arr = this._metadata.get(key) ?? [];
		arr.push(value);
		this._metadata.set(key, arr);
	}
}

// TODO handle persisted 'previous' and '' IDs (?)
// 'previous' -> last tool call round of previous turn
// '' -> current turn, but with user message
/**
 * Move summaries from metadata onto rounds.
 * This is needed for summaries that were produced for a different turn than the current one, because we can only
 * return resultMetadata from a particular request for the current turn, and can't modify the data for previous turns.
 */
export function normalizeSummariesOnRounds(turns: readonly Turn[]): void {
	for (const [idx, turn] of turns.entries()) {
		const turnSummary = turn.resultMetadata?.summary;
		if (turnSummary) {
			const roundInTurn = turn.rounds.find(round => round.id === turnSummary.toolCallRoundId);
			if (roundInTurn) {
				roundInTurn.summary = turnSummary.text;
			} else {
				const previousTurns = turns.slice(0, idx);
				for (const turn of previousTurns) {
					const roundInPreviousTurn = turn.rounds.find(round => round.id === turnSummary.toolCallRoundId);
					if (roundInPreviousTurn) {
						roundInPreviousTurn.summary = turnSummary.text;
						break;
					}
				}
			}
		}
	}
}

export interface IConversationState {
	readonly turns: Turn[];
}

export class Conversation {

	private readonly _turns: Turn[] = [];

	constructor(
		readonly sessionId: string,
		turns: Turn[]
	) {
		assertType(turns.length > 0, 'A conversation must have at least one turn');
		this._turns = turns;
	}

	get turns(): readonly Turn[] {
		return this._turns;
	}

	getLatestTurn(): Turn {
		return this._turns.at(-1)!; // safe, we checked for length in the ctor
	}
}


export type ResponseStreamParticipant = (inStream: ChatResponseStream) => ChatResponseStream;

export function getUniqueReferences(references: PromptReference[]): PromptReference[] {
	const groupedPromptReferences: ResourceMap<PromptReference[] | PromptReference> = new ResourceMap();
	const variableReferences: PromptReference[] = [];

	const getCombinedRange = (a: Range, b: Range): Range | undefined => {
		if (a.contains(b)) {
			return a;
		}

		if (b.contains(a)) {
			return b;
		}

		const [firstRange, lastRange] = (a.start.line < b.start.line) ? [a, b] : [b, a];
		// check if a is before b
		if (firstRange.end.line >= (lastRange.start.line - 1)) {
			return new Range(firstRange.start, lastRange.end);
		}

		return undefined;
	};

	// remove overlaps from within the same promptContext
	references.forEach(targetReference => {
		const refAnchor = targetReference.anchor;
		if ('variableName' in refAnchor) {
			variableReferences.push(targetReference);
		} else if (!isLocation(refAnchor)) {
			groupedPromptReferences.set(refAnchor, targetReference);
		} else {
			// reference is a range
			const existingRefs = groupedPromptReferences.get(refAnchor.uri);
			const asValidLocation = toLocation(refAnchor);
			if (!asValidLocation) {
				return;
			}
			if (!existingRefs) {
				groupedPromptReferences.set(refAnchor.uri, [new PromptReference(asValidLocation, undefined, targetReference.options)]);
			} else if (!(existingRefs instanceof PromptReference)) {
				// check if existingRefs isn't already a full file
				const oldLocationsToKeep: Location[] = [];
				let newRange = asValidLocation.range;
				existingRefs.forEach(existingRef => {
					if ('variableName' in existingRef.anchor) {
						return;
					}

					if (!isLocation(existingRef.anchor)) {
						// this shouldn't be the case, since all PromptReferences added as part of an array should be ranges
						return;
					}
					const existingRange = toLocation(existingRef.anchor);
					if (!existingRange) {
						return;
					}
					const combinedRange = getCombinedRange(newRange, existingRange.range);
					if (combinedRange) {
						// if we can consume this range, incorporate it into the new range and don't add it to the locations to keep
						newRange = combinedRange;
					} else {
						oldLocationsToKeep.push(existingRange);
					}
				});
				const newRangeLocation: Location = {
					uri: refAnchor.uri,
					range: newRange,
				};
				groupedPromptReferences.set(
					refAnchor.uri,
					[...oldLocationsToKeep, newRangeLocation]
						.sort((a, b) => a.range.start.line - b.range.start.line || a.range.end.line - b.range.end.line)
						.map(location => new PromptReference(location, undefined, targetReference.options)));

			}
		}
	});

	// sort values
	const finalValues = Array.from(groupedPromptReferences.keys())
		.sort((a, b) => a.toString().localeCompare(b.toString()))
		.map(e => {
			const values = groupedPromptReferences.get(e);
			if (!values) {
				// should not happen, these are all keys
				return [];
			}
			return values;
		}).flat();

	return [
		...finalValues,
		...variableReferences
	];
}

export type CodeBlock = { readonly code: string; readonly language?: string; readonly resource?: URI; readonly markdownBeforeBlock?: string };

export interface IResultMetadata {
	modelMessageId: string;
	responseId: string;
	sessionId: string;
	agentId: string;
	/** The user message exactly as it must be rendered in history. Should not be optional, but not every prompt will adopt this immediately */
	renderedUserMessage?: Raw.ChatCompletionContentPart[];
	renderedGlobalContext?: Raw.ChatCompletionContentPart[];
	command?: string;
	filterCategory?: FilterReason;

	/**
	 * All code blocks that were in the response
	*/
	codeBlocks?: readonly CodeBlock[];

	toolCallRounds?: readonly IToolCallRound[];
	toolCallResults?: Record<string, LanguageModelToolResult>;
	maxToolCallsExceeded?: boolean;
	summary?: { toolCallRoundId: string; text: string };
}

/** There may be no metadata for results coming from old persisted messages, or from messages that are currently in progress (TODO, try to handle this case) */
export interface ICopilotChatResultIn extends ChatResult {
	metadata?: Partial<IResultMetadata>;
}

export interface ICopilotChatResult extends ChatResult {
	metadata: IResultMetadata;
}

export class RenderedUserMessageMetadata {
	constructor(
		readonly renderedUserMessage: Raw.ChatCompletionContentPart[],
	) { }
}

export class GlobalContextMessageMetadata {
	constructor(
		readonly renderedGlobalContext: Raw.ChatCompletionContentPart[],
	) { }
}
