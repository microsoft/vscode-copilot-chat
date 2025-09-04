/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import * as http from 'http';
import type { IMakeChatRequestOptions } from '../../../../platform/networking/common/networking';
import { APIUsage } from '../../../../platform/networking/common/openai';

export interface IParsedRequest {
	model?: string;
	messages: Raw.ChatMessage[];
	options?: IMakeChatRequestOptions['requestOptions'];
}

export interface IStreamEventData {
	event: string;
	data: string;
}

export interface IAgentTextBlock {
	type: 'text';
	content: string;
}

export interface IAgentToolCallBlock {
	type: 'tool_call';
	callId: string;
	name: string;
	input: object;
}

export type IAgentStreamBlock = IAgentTextBlock | IAgentToolCallBlock;

export interface IProtocolAdapter {
	/**
	 * The name of this protocol adapter
	 */
	readonly name: string;

	/**
	 * Parse the incoming request body and convert to VS Code format
	 */
	parseRequest(body: string): IParsedRequest;

	/**
	 * Convert raw streaming data to protocol-specific events
	 */
	formatStreamResponse(
		streamData: IAgentStreamBlock,
		context: IStreamingContext
	): IStreamEventData[];

	/**
	 * Generate the final events to close the stream
	 */
	generateFinalEvents(context: IStreamingContext, usage?: APIUsage): IStreamEventData[];

	/**
	 * Generate initial events to start the stream (optional, protocol-specific)
	 */
	generateInitialEvents?(context: IStreamingContext): IStreamEventData[];

	/**
	 * Get the content type for responses
	 */
	getContentType(): string;

	/**
	 * Extract the authentication key/nonce from request headers
	 */
	extractAuthKey(headers: http.IncomingHttpHeaders): string | undefined;
}

export interface IProtocolAdapterFactory {
	/**
	 * Create a new adapter instance for a request
	 */
	createAdapter(): IProtocolAdapter;
}

export interface IStreamingContext {
	requestId: string;
	endpoint: {
		modelId: string;
		modelMaxPromptTokens: number;
	};
}
