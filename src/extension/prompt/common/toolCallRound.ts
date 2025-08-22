/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ThinkingData } from '../../../platform/thinking/common/thinking';
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
	 * Creates a ToolCallRound from an existing IToolCallRound object.
	 * Prefer this over using a constructor overload to keep construction explicit.
	 */
	public static create(params: Omit<IToolCallRound, 'id'> & { id?: string }): ToolCallRound {
		const round = new ToolCallRound(
			params.response,
			params.toolCalls,
			params.toolInputRetry,
			params.id,
			params.statefulMarker,
			params.thinking
		);
		round.summary = params.summary;
		return round;
	}

	/**
	 * @param response The text response from the assistant
	 * @param toolCalls The tool calls made by the assistant
	 * @param toolInputRetry The number of times this round has been retried due to tool input validation failures
	 * @param id A stable identifier for this round
	 * @param statefulMarker Optional stateful marker used with the responses API
	 */
	constructor(
		public readonly response: string,
		public readonly toolCalls: IToolCall[] = [],
		public readonly toolInputRetry: number = 0,
		public readonly id: string = ToolCallRound.generateID(),
		public readonly statefulMarker?: string,
		public readonly thinking?: ThinkingData
	) { }

	private static generateID(): string {
		return generateUuid();
	}
}
