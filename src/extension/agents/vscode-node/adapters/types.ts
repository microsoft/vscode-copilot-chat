/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import * as vscode from 'vscode';

export interface ParsedRequest {
	model?: string;
	messages: vscode.LanguageModelChatMessage[];
	tools?: vscode.LanguageModelTool<any>[];
	options?: vscode.LanguageModelChatRequestOptions;
}

export interface StreamEventData {
	event: string;
	data: string;
}

export interface ProtocolAdapter {
	/**
	 * Parse the incoming request body and convert to VS Code format
	 */
	parseRequest(body: string): ParsedRequest;

	/**
	 * Convert VS Code streaming response parts to protocol-specific events
	 */
	formatStreamResponse(
		part: vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart,
		context: StreamingContext
	): StreamEventData[];

	/**
	 * Generate the final events to close the stream
	 */
	generateFinalEvents(context: StreamingContext): StreamEventData[];

	/**
	 * Generate initial events to start the stream (optional, protocol-specific)
	 */
	generateInitialEvents?(context: StreamingContext): StreamEventData[];

	/**
	 * Get the content type for responses
	 */
	getContentType(): string;

	/**
	 * Extract the authentication key/nonce from request headers
	 */
	extractAuthKey(headers: http.IncomingHttpHeaders): string | undefined;
}

export interface StreamingContext {
	requestId: string;
	modelId: string;
	currentBlockIndex: number;
	hasTextBlock: boolean;
	hadToolCalls: boolean;
	outputTokens: number;
}
