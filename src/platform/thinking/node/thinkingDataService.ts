/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { ThinkingData } from '../common/thinking';


export interface IThinkingDataService {
	readonly _serviceBrand: undefined;
	update(choice: {
		message?: ThinkingData;
		delta?: ThinkingData;
		index: number;
	}, toolCallId?: string): void;
	consume(id: string): ThinkingData | undefined;
	peek(id: string): ThinkingData | undefined;
	clear(): void;
}
export const IThinkingDataService = createServiceIdentifier<IThinkingDataService>('IThinkingDataService');


interface ThinkingDataInternal extends ThinkingData {
	tool_call_id?: string;
	choice_index?: number;
}

export class ThinkingDataImpl implements IThinkingDataService {
	readonly _serviceBrand: undefined;
	private data: ThinkingDataInternal[] = [];

	constructor() { }

	public update(choice: {
		message?: ThinkingData;
		delta?: ThinkingData;
		index: number;
	}, toolCallId?: string): void {
		const thinkingData = this.extractThinkingData(choice);
		const data = this.data.find(d => d.choice_index === choice.index);
		if (thinkingData) {
			if (data === undefined) {
				this.data.push({ ...thinkingData, choice_index: choice.index, tool_call_id: toolCallId });
			} else {
				if (data.tool_call_id === undefined && toolCallId && toolCallId.length > 0) {
					data.tool_call_id = toolCallId;
				}
				if (thinkingData.cot_summary !== undefined) {
					if (data.cot_summary === undefined) {
						data.cot_summary = thinkingData.cot_summary;
					} else {
						data.cot_summary += thinkingData.cot_summary ?? '';
					}
				} else if (thinkingData.reasoning_text !== undefined) {
					if (data.reasoning_text === undefined) {
						data.reasoning_text = thinkingData.reasoning_text;
					} else {
						data.reasoning_text += thinkingData.reasoning_text ?? '';
					}
				}
				if (data.cot_id === undefined && thinkingData.cot_id) {
					data.cot_id = thinkingData.cot_id;
				}
				if (data.reasoning_opaque === undefined && thinkingData.reasoning_opaque) {
					data.reasoning_opaque = thinkingData.reasoning_opaque;
				}
			}
		}
	}

	private extractThinkingData(choice: {
		message?: ThinkingData;
		delta?: ThinkingData;
		index: number;
	}): ThinkingData | undefined {
		if (choice.message?.cot_id || choice.message?.cot_summary !== undefined) {
			return { cot_id: choice.message.cot_id, cot_summary: choice.message.cot_summary };
		} else if (choice.delta?.cot_id || choice.delta?.cot_summary !== undefined) {
			return { cot_id: choice.delta.cot_id, cot_summary: choice.delta.cot_summary };
		} else if (choice.message?.reasoning_opaque || choice.message?.reasoning_text !== undefined) {
			return { reasoning_opaque: choice.message.reasoning_opaque, reasoning_text: choice.message.reasoning_text };
		} else if (choice.delta?.reasoning_opaque || choice.delta?.reasoning_text !== undefined) {
			return { reasoning_opaque: choice.delta.reasoning_opaque, reasoning_text: choice.delta.reasoning_text };
		}
		return undefined;
	}

	public consume(id: string): ThinkingData | undefined {
		const data = this.data.find(d => d.tool_call_id === id);
		if (data) {
			delete data.choice_index;
			if (data.cot_id) {
				return {
					cot_id: data.cot_id,
					cot_summary: data.cot_summary,
				};
			}
			if (data.reasoning_opaque) {
				return {
					reasoning_opaque: data.reasoning_opaque,
					reasoning_text: data.reasoning_text,
				};
			}
		}
		return undefined;
	}

	public peek(id: string): ThinkingData | undefined {
		const data = this.data.find(d => d.tool_call_id === id);
		if (data) {
			if (data.cot_id) {
				return {
					cot_id: data.cot_id,
					cot_summary: data.cot_summary,
				};
			}
			if (data.reasoning_opaque) {
				return {
					reasoning_opaque: data.reasoning_opaque,
					reasoning_text: data.reasoning_text,
				};
			}
		}
		return undefined;
	}

	public clear(): void {
		this.data = [];
	}
}