/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { CancellationError, isCancellationError } from '../../../util/vs/base/common/errors';
import { escapeRegExpCharacters } from '../../../util/vs/base/common/strings';
import { Location, Position, Range } from '../../../vscodeTypes';
import { parsePrecedingLineNumberAnnotation, parseTrailingLineNumberAnnotation } from './lineAnnotationParser';
import { coalesceParts, LinkifiedPart, LinkifiedText, LinkifyLocationAnchor } from './linkifiedText';
import type { IContributedLinkifier, ILinkifier, LinkifierContext } from './linkifyService';

namespace LinkifierState {
	export enum Type {
		Default,
		CodeOrMathBlock,
		Accumulating,
	}

	export enum AccumulationType {
		Word,
		InlineCodeOrMath,
		PotentialLink,
	}

	export const Default = { type: Type.Default } as const;

	export class CodeOrMathBlock {
		readonly type = Type.CodeOrMathBlock;

		constructor(
			public readonly fence: string,
			public readonly indent: string,
			public readonly contents = '',
		) { }

		appendContents(text: string): CodeOrMathBlock {
			return new CodeOrMathBlock(this.fence, this.indent, this.contents + text);
		}
	}

	export class Accumulating {
		readonly type = LinkifierState.Type.Accumulating;

		constructor(
			public readonly pendingText: string,
			public readonly accumulationType = LinkifierState.AccumulationType.Word,
			public readonly terminator?: string,
		) { }

		append(text: string): Accumulating {
			return new Accumulating(this.pendingText + text, this.accumulationType, this.terminator);
		}
	}

	export type State = typeof Default | CodeOrMathBlock | Accumulating;
}

/**
 * Stateful linkifier that incrementally linkifies appended text.
 *
 * Make sure to create a new linkifier for each response.
 */
export class Linkifier implements ILinkifier {

	private _state: LinkifierState.State = LinkifierState.Default;
	private _appliedText = '';

	private _totalAddedLinkCount = 0;

	// Buffer used to delay emitting a single file anchor until we either
	// detect a line annotation or exceed buffering heuristics.
	private _delayedAnchorBuffer: { anchor: LinkifyLocationAnchor; afterText: string; totalChars: number; precedingText: string } | undefined;

	private static readonly maxAnchorBuffer = 140; // chars of following text to wait for annotation
	private static readonly flushTerminatorsRe = /[\.?!]\s*$|\n/; // punctuation or newline suggests end of sentence

	constructor(
		private readonly context: LinkifierContext,
		private readonly productUriScheme: string,
		private readonly linkifiers: readonly IContributedLinkifier[] = [],
	) { }

	get totalAddedLinkCount(): number {
		return this._totalAddedLinkCount;
	}

	async append(newText: string, token: CancellationToken): Promise<LinkifiedText> {
		// Linkification needs to run on whole sequences of characters. However the incoming stream may be broken up.
		// To handle this, accumulate text until we have whole tokens.

		const out: LinkifiedPart[] = [];

		for (const part of newText.split(/(\s+)/)) {
			if (!part.length) {
				continue;
			}

			switch (this._state.type) {
				case LinkifierState.Type.Default: {
					if (/^\s+$/.test(part)) {
						out.push(this.doAppend(part));
					} else {
						// Start accumulating

						// `text...
						if (/^[^\[`]*`[^`]*$/.test(part)) {
							this._state = new LinkifierState.Accumulating(part, LinkifierState.AccumulationType.InlineCodeOrMath, '`');
						}
						// `text`
						else if (/^`[^`]+`$/.test(part)) {
							// No linkifying inside inline code
							out.push(...(await this.doLinkifyAndAppend(part, { skipUnlikify: true }, token)).parts);
						}
						// $text...
						else if (/^[^\[`]*\$[^\$]*$/.test(part)) {
							this._state = new LinkifierState.Accumulating(part, LinkifierState.AccumulationType.InlineCodeOrMath, '$');
						}
						// $text$
						else if (/^[^\[`]*\$[^\$]*\$$/.test(part)) {
							// No linkifying inside math code
							out.push(this.doAppend(part));
						}
						// [text...
						else if (/^\s*\[[^\]]*$/.test(part)) {
							this._state = new LinkifierState.Accumulating(part, LinkifierState.AccumulationType.PotentialLink);
						}
						// Plain old word
						else {
							this._state = new LinkifierState.Accumulating(part);
						}
					}
					break;
				}
				case LinkifierState.Type.CodeOrMathBlock: {
					if (
						new RegExp('(^|\\n)' + escapeRegExpCharacters(this._state.fence) + '($|\\n)').test(part)
						|| (this._state.contents.length > 2 && new RegExp('(^|\\n)\\s*' + escapeRegExpCharacters(this._state.fence) + '($|\\n\\s*$)').test(this._appliedText + part))
					) {
						// To end the code block, the previous text needs to be empty up the start of the last line and
						// at lower indentation than the opening code block.
						const indent = this._appliedText.match(/(\n|^)([ \t]*)[`~]*$/);
						if (indent && indent[2].length <= this._state.indent.length) {
							this._state = LinkifierState.Default;
							out.push(this.doAppend(part));
							break;
						}
					}

					this._state = this._state.appendContents(part);

					// No linkifying inside code blocks
					out.push(this.doAppend(part));
					break;
				}
				case LinkifierState.Type.Accumulating: {
					const completeWord = async (state: LinkifierState.Accumulating, inPart: string, skipUnlikify: boolean) => {
						const toAppend = state.pendingText + inPart;
						this._state = LinkifierState.Default;
						const r = await this.doLinkifyAndAppend(toAppend, { skipUnlikify }, token);
						out.push(...r.parts);
					};

					if (this._state.accumulationType === LinkifierState.AccumulationType.PotentialLink) {
						if (/]/.test(part)) {
							this._state = this._state.append(part);
							break;
						} else if (/\n/.test(part)) {
							await completeWord(this._state, part, false);
							break;
						}
					} else if (this._state.accumulationType === LinkifierState.AccumulationType.InlineCodeOrMath && new RegExp(escapeRegExpCharacters(this._state.terminator ?? '`')).test(part)) {
						const terminator = this._state.terminator ?? '`';
						const terminalIndex = part.indexOf(terminator);
						if (terminalIndex === -1) {
							await completeWord(this._state, part, true);
						} else {
							if (terminator === '`') {
								await completeWord(this._state, part, true);
							} else {
								// Math shouldn't run linkifies

								const pre = part.slice(0, terminalIndex + terminator.length);
								// No linkifying inside inline math
								out.push(this.doAppend(this._state.pendingText + pre));

								// But we can linkify after
								const rest = part.slice(terminalIndex + terminator.length);
								this._state = LinkifierState.Default;
								if (rest.length) {
									out.push(...(await this.doLinkifyAndAppend(rest, { skipUnlikify: true }, token)).parts);
								}
							}
						}
						break;
					} else if (this._state.accumulationType === LinkifierState.AccumulationType.Word && /\s/.test(part)) {
						const toAppend = this._state.pendingText + part;
						this._state = LinkifierState.Default;

						// Check if we've found special tokens
						const fence = toAppend.match(/(^|\n)\s*(`{3,}|~{3,}|\$\$)/);
						if (fence) {
							const indent = this._appliedText.match(/(\n|^)([ \t]*)$/);
							this._state = new LinkifierState.CodeOrMathBlock(fence[2], indent?.[2] ?? '');
							out.push(this.doAppend(toAppend));
						}
						else {
							const r = await this.doLinkifyAndAppend(toAppend, {}, token);
							out.push(...r.parts);
						}

						break;
					}

					// Keep accumulating
					this._state = this._state.append(part);
					break;
				}
			}
		}
		// Coalesce adjacent string parts first so upgrade regex sees complete annotation text
		// If we are still accumulating a word (end of input chunk), finalize it so annotations like 'lines 77–85.' are present.
		if (this._state.type === LinkifierState.Type.Accumulating && this._state.accumulationType === LinkifierState.AccumulationType.Word) {
			const pending = this._state.pendingText;
			this._state = LinkifierState.Default;
			if (pending.length) {
				const r = await this.doLinkifyAndAppend(pending, {}, token);
				out.push(...r.parts);
			}
		}

		const coalesced = coalesceParts(out);

		return { parts: this.processCoalescedParts(coalesced) };
	}

	async flush(token: CancellationToken): Promise<LinkifiedText | undefined> {
		let out: LinkifiedText | undefined;

		// Flush any buffered anchor before finalizing
		if (this._delayedAnchorBuffer) {
			out = { parts: this.flushAnchorBuffer() };
		}

		switch (this._state.type) {
			case LinkifierState.Type.CodeOrMathBlock: {
				out = { parts: [this.doAppend(this._state.contents)] };
				break;
			}
			case LinkifierState.Type.Accumulating: {
				const toAppend = this._state.pendingText;
				out = await this.doLinkifyAndAppend(toAppend, {}, token);
				break;
			}
		}

		this._state = LinkifierState.Default;
		return out;
	}

	private doAppend(newText: string): string {
		this._appliedText = this._appliedText + newText;
		return newText;
	}

	private async doLinkifyAndAppend(newText: string, options: { skipUnlikify?: boolean }, token: CancellationToken): Promise<LinkifiedText> {
		if (newText.length === 0) {
			return { parts: [] };
		}

		this.doAppend(newText);

		// Run contributed linkifiers
		let parts: LinkifiedPart[] = [newText];
		for (const linkifier of this.linkifiers) {
			parts = coalesceParts(await this.runLinkifier(parts, linkifier, token));
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}
		}

		// Do a final pass that un-linkifies any file links that don't have a scheme.
		// This prevents links like: [some text](index.html) from sneaking through as these can never be opened properly.
		if (!options.skipUnlikify) {
			parts = parts.map(part => {
				if (typeof part === 'string') {
					return part.replaceAll(/\[([^\[\]]+)\]\(([^\s\)]+)\)/g, (matched, text, path) => {
						// Always preserve product URI scheme links
						if (path.startsWith(this.productUriScheme + ':')) {
							return matched;
						}

						return /^\w+:/.test(path) ? matched : text;
					});
				}
				return part;
			});
		}

		this._totalAddedLinkCount += parts.filter(part => typeof part !== 'string').length;
		return { parts };
	}

	private async runLinkifier(parts: readonly LinkifiedPart[], linkifier: IContributedLinkifier, token: CancellationToken): Promise<LinkifiedPart[]> {
		const out: LinkifiedPart[] = [];
		for (const part of parts) {
			if (token.isCancellationRequested) {
				throw new CancellationError();
			}

			if (typeof part === 'string') {
				let linkified: LinkifiedText | undefined;
				try {
					linkified = await linkifier.linkify(part, this.context, token);
				} catch (e) {
					if (!isCancellationError(e)) {
						console.error(e);
					}
					out.push(part);
					continue;
				}

				if (linkified) {
					out.push(...linkified.parts);
				} else {
					out.push(part);
				}
			} else {
				out.push(part);
			}
		}
		return out;
	}

	// --- buffering helpers ---

	private processCoalescedParts(parts: readonly LinkifiedPart[]): LinkifiedPart[] {
		const emit: LinkifiedPart[] = [];
		for (const part of parts) {
			if (part instanceof LinkifyLocationAnchor) {
				const value = part.value;
				if (typeof value === 'object' && value !== null && 'range' in value) { // already has line info
					emit.push(part);
					continue;
				}
				if (this._delayedAnchorBuffer) {
					emit.push(...this.flushAnchorBuffer());
				}
				// Capture up to N chars of preceding applied text to allow upgrading
				// anchors when annotation precedes file name: "in lines 5-7 of example.ts".
				// Build a preceding snapshot from contiguous prior string parts (not entire applied text)
				const precedingSnapshot = (() => {
					let acc = '';
					for (let i = emit.length - 1; i >= 0; i--) {
						const prev = emit[i];
						if (typeof prev === 'string') {
							acc = prev + acc;
							if (acc.length >= 160) { break; }
						} else {
							break; // stop at non-string boundary
						}
					}
					return acc.slice(-160);
				})();
				this._delayedAnchorBuffer = { anchor: part, afterText: '', totalChars: 0, precedingText: precedingSnapshot };
				// Try immediate upgrade using preceding annotation pattern.
				// If upgraded, continue buffering to capture any trailing text (e.g., punctuation).
				this.tryUpgradeBufferedAnchorFromPreceding();
				continue;
			}
			if (this._delayedAnchorBuffer && typeof part === 'string') {
				this._delayedAnchorBuffer.afterText += part;
				this._delayedAnchorBuffer.totalChars += part.length;
				if (this.shouldFlushCurrentBuffer()) {
					emit.push(...this.flushAnchorBuffer());
				}
				continue;
			}
			emit.push(part);
		}
		return emit;
	}

	private shouldFlushCurrentBuffer(): boolean {
		const b = this._delayedAnchorBuffer;
		if (!b) { return false; }
		return Linkifier.flushTerminatorsRe.test(b.afterText)
			|| b.totalChars > Linkifier.maxAnchorBuffer
			|| !!parseTrailingLineNumberAnnotation(b.afterText)
			|| this.tryUpgradeBufferedAnchorFromPreceding();
	}

	private flushAnchorBuffer(): LinkifiedPart[] {
		if (!this._delayedAnchorBuffer) { return []; }
		const { anchor, afterText } = this._delayedAnchorBuffer;
		let resultAnchor: LinkifyLocationAnchor = anchor;
		const parsed = parseTrailingLineNumberAnnotation(afterText);
		if (parsed) {
			resultAnchor = new LinkifyLocationAnchor({ uri: anchor.value, range: new Range(new Position(parsed.startLine, 0), new Position(parsed.startLine, 0)) } as Location);
		}
		this._delayedAnchorBuffer = undefined;
		return afterText.length > 0 ? [resultAnchor, afterText] : [resultAnchor];
	}

	// Preceding annotation pattern (annotation before file name):
	// Examples: "in lines 5-7 of example.ts", "lines 10-12 of foo.py", "on line 45 of bar.ts", "ln 22 of baz.js"
	// We only upgrade once; if already upgraded via trailing text we skip.
	private tryUpgradeBufferedAnchorFromPreceding(): boolean {
		const b = this._delayedAnchorBuffer;
		if (!b) { return false; }
		// If already has line info or we already parsed trailing text, skip.
		const val = b.anchor.value;
		if (typeof val === 'object' && val !== null && 'range' in val) { return false; }
		// Extract tail ending right before the file path anchor was inserted.
		// Snapshot may include other text after the annotation; restrict to last 160 chars.
		const text = b.precedingText;
		if (!text) { return false; }
		const parsed = parsePrecedingLineNumberAnnotation(text);
		if (!parsed) { return false; }
		b.anchor = new LinkifyLocationAnchor({ uri: b.anchor.value, range: new Range(new Position(parsed.startLine, 0), new Position(parsed.startLine, 0)) } as Location);
		return true;
	}
}
