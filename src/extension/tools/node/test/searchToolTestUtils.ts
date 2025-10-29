/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IEndpointProvider } from '../../../../platform/endpoint/common/endpointProvider';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';

/**
 * Creates a mock endpoint provider for search tool tests
 */
export function createMockEndpointProvider(modelFamily: string): IEndpointProvider {
	return {
		_serviceBrand: undefined,
		getChatEndpoint: async () => ({
			family: modelFamily,
			model: 'test-model',
			maxOutputTokens: 1000,
			supportsToolCalls: true,
			supportsVision: true,
			supportsPrediction: true,
			showInModelPicker: true,
		} as IChatEndpoint),
		getAllChatEndpoints: async () => [],
		getAllCompletionModels: async () => [],
		getEmbeddingsEndpoint: async () => ({} as any),
	} as IEndpointProvider;
}

/**
 * Mock language model chat for testing search tools with model-specific behavior
 */
export const mockLanguageModelChat: vscode.LanguageModelChat = {
	name: 'test-model',
	id: 'test-id',
	vendor: 'test',
	family: 'test-family',
	version: 'test-version',
	maxInputTokens: 1000,
	maxOutputTokens: 1000,
	sendRequest: async () => ({
		text: (async function* () { yield ''; })(),
		stream: (async function* () { })()
	} as vscode.LanguageModelChatResponse),
	countTokens: async () => 0,
	capabilities: {
		supportsToolCalling: true,
		supportsImageToText: true
	},
} as vscode.LanguageModelChat;
