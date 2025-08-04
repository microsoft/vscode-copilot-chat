/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IToolCall, IToolCallRound } from './intents';


/**
 * Represents a round of tool calling from the AI assistant.
 * Each round contains the assistant's response text, any tool calls it made,
 * and retry information if there were input validation issues.
 */
export class ToolCallRound implements IToolCallRound {

	public summary: string | undefined;

	/**
	 * @param response The text response from the assistant
	 * @param toolCalls The tool calls made by the assistant
	 * @param toolInputRetry The number of times this round has been retried due to tool input validation failures
	 */
	constructor(
		public readonly response: string,
		public readonly toolCalls: IToolCall[],
		public readonly toolInputRetry: number = 0,
		public readonly id: string = ToolCallRound.generateID(),
	) { }

	private static generateID(): string {
		return generateUuid();
	}
}
