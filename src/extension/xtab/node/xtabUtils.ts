/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { toTextParts } from '../../../platform/chat/common/globalStringUtils';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';


export function toLines(stream: AsyncIterableObject<{ delta: { text: string } }>) {
	return new AsyncIterableObject<string>(async (emitter) => {
		let buffer: string | null = null;

		for await (const chunk of stream) {
			buffer ??= '';
			buffer += chunk.delta.text;

			const parts: string[] = buffer.split(/\r?\n/);
			buffer = parts.pop() ?? '';

			emitter.emitMany(parts);
		}

		if (buffer !== null) {
			emitter.emitOne(buffer);
		}
	});
}

/**
 * Remove backticks on the first and last lines.
 */
export function linesWithBackticksRemoved(linesStream: AsyncIterableObject<string>) {
	return new AsyncIterableObject<string>(async (emitter) => {
		let lineN = -1;

		let bufferedBacktickLine: string | undefined;

		for await (const line of linesStream) {
			++lineN;

			if (bufferedBacktickLine) {
				emitter.emitOne(bufferedBacktickLine);
				bufferedBacktickLine = undefined;
			}

			if (line.match(/^```[a-z]*$/)) {
				if (lineN === 0) {
					continue;
				} else {
					// maybe middle of stream or last line
					// we set it to buffer; if it's midle of stream, it will be emitted
					// if last line, it will be omitted
					bufferedBacktickLine = line;
				}
			} else {
				emitter.emitOne(line);
			}
		}

		// ignore bufferedLine
	});
}

export function constructMessages({ systemMsg, userMsg }: { systemMsg: string; userMsg: string }): Raw.ChatMessage[] {
	return [
		{
			role: Raw.ChatRole.System,
			content: toTextParts(systemMsg)
		},
		{
			role: Raw.ChatRole.User,
			content: toTextParts(userMsg)
		}
	] satisfies Raw.ChatMessage[];
}

export function charCount(messages: Raw.ChatMessage[]): number {
	const promptCharCount = messages.reduce((total, msg) => total + msg.content.reduce((subtotal, part) => subtotal + (part.type === Raw.ChatCompletionContentPartKind.Text ? part.text.length : 0), 0), 0);
	return promptCharCount;
}