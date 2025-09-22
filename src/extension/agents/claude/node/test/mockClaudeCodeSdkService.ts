/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Options, Query, SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-code';
import { IClaudeCodeSdkService } from '../claudeCodeSdkService';

/**
 * Mock implementation of IClaudeCodeService for testing
 */
export class MockClaudeCodeSdkService implements IClaudeCodeSdkService {
	readonly _serviceBrand: undefined;
	public queryCallCount = 0;

	public async query(options: {
		prompt: AsyncIterable<SDKUserMessage>;
		options: Options;
	}): Promise<Query> {
		this.queryCallCount++;
		return this.createMockGenerator(options.prompt) as unknown as Query;
	}

	private async* createMockGenerator(prompt: AsyncIterable<SDKUserMessage>): AsyncGenerator<SDKAssistantMessage | SDKResultMessage, void, unknown> {
		// For every user message yielded, emit an assistant text and then a result
		for await (const _ of prompt) {
			yield {
				type: 'assistant',
				session_id: 'sess-1',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Hello from mock!' }
					]
				}
			} as SDKAssistantMessage;
			yield {
				type: 'result',
				subtype: 'error_max_turns',
				uuid: 'mock-uuid',
				session_id: 'sess-1',
				duration_ms: 0,
				duration_api_ms: 0,
				is_error: false,
				num_turns: 0,
				total_cost_usd: 0,
				usage: { input_tokens: 0, output_tokens: 0 },
				permission_denials: []
			} as unknown as SDKResultMessage;
		}
	}
}