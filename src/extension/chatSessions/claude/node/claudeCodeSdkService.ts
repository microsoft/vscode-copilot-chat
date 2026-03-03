/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createServiceIdentifier } from '../../../../util/common/services';

export interface IClaudeCodeSdkService {
	readonly _serviceBrand: undefined;

	/**
	 * Creates a new Claude Code query generator
	 * @param options Query options including prompt and configuration
	 * @returns Query instance for Claude Code responses
	 */
	query(options: {
		prompt: AsyncIterable<SDKUserMessage>;
		options: Options;
	}): Promise<Query>;
}

export const IClaudeCodeSdkService = createServiceIdentifier<IClaudeCodeSdkService>('IClaudeCodeSdkService');

/**
 * Service that wraps the Claude Code SDK for DI in tests
 */
export class ClaudeCodeSdkService implements IClaudeCodeSdkService {
	readonly _serviceBrand: undefined;

	public async query(options: {
		prompt: AsyncIterable<SDKUserMessage>;
		options: Options;
	}): Promise<Query> {
		const { query } = await import('@anthropic-ai/claude-agent-sdk');
		return query(options);
	}
}
