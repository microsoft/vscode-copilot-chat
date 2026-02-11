/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ChatEndpointFamily } from '../../../platform/endpoint/common/endpointProvider';
import { CapturingToken } from '../../../platform/requestLogger/common/capturingToken';
import { IRequestLogger } from '../../../platform/requestLogger/node/requestLogger';
import { CancellationToken, CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { ChatRequest } from '../../../vscodeTypes';
import { Conversation, Turn } from '../../prompt/common/conversation';
import { DebugSubagentToolCallingLoop } from '../../prompt/node/debugSubagentToolCallingLoop';
import { DEBUG_MAX_TOOL_CALLS } from '../common/debugConstants';
import { IDebugContextService } from '../common/debugContextService';

/**
 * Model family to use for the debug subagent.
 * Claude Sonnet 4.5 is preferred for better analysis capabilities.
 */
const DEBUG_MODEL_FAMILY = 'claude-sonnet-4.5';
const DEBUG_MODEL_FALLBACK: ChatEndpointFamily = 'gpt-4.1';

/**
 * Creates a minimal mock ChatRequest for use when invoking the debug subagent
 * from the panel (outside of chat context).
 */
function createMinimalChatRequest(): ChatRequest {
	// Create a minimal request with just enough properties to satisfy the loop
	return {
		// Core required properties
		prompt: '',
		command: undefined,
		references: [],
		toolReferences: [],
		toolInvocationToken: undefined as unknown as vscode.ChatParticipantToolToken,
		model: undefined as unknown as vscode.LanguageModelChat,
		// Additional required properties from ChatRequest interface
		id: generateUuid(),
		attempt: 0,
		sessionId: generateUuid(),
		enableCommandDetection: false,
		isParticipantDetected: false,
		acceptedConfirmationData: undefined,
		// Properties from proposed APIs
		tools: new Map(),
		editedFileEvents: [],
		location: ChatLocation.Panel,
		location2: undefined,
		modeInstructions2: undefined,
		hasHooksEnabled: false,
	} as ChatRequest;
}

/**
 * Service for invoking the debug subagent directly without going through chat UI.
 * Uses the same DebugSubagentToolCallingLoop as the chat-based DebugSubagentTool,
 * ensuring unified prompt, tools, and logging.
 */
export class DebugSubagentInvoker {

	constructor(
		private readonly _instantiationService: IInstantiationService,
		private readonly _debugContextService: IDebugContextService,
		private readonly _requestLogger: IRequestLogger
	) { }

	/**
	 * Execute a debug query using the debug subagent (same as chat invocation)
	 */
	async executeQuery(query: string, token?: CancellationToken): Promise<string> {
		const cts = new CancellationTokenSource(token);
		const subAgentInvocationId = generateUuid();
		const parentSessionId = generateUuid();

		// Create a capturing token for logging and trajectory
		const capturingToken = new CapturingToken(
			`Debug Panel: ${query.substring(0, 50)}${query.length > 50 ? '...' : ''}`,
			'debug',
			false,
			false,
			subAgentInvocationId,
			'debug-panel'  // subAgentName for trajectory tracking
		);

		return this._requestLogger.captureInvocation(capturingToken, async () => {
			// Try to get Claude model, fall back to GPT-4.1 if not available
			// Note: ChatEndpointFamily only includes certain models, so we check Claude availability
			// but pass undefined for modelFamily (letting the endpoint use its defaults) when Claude is selected
			let modelFamily: ChatEndpointFamily | undefined = DEBUG_MODEL_FALLBACK;
			try {
				const claudeModels = await vscode.lm.selectChatModels({ family: DEBUG_MODEL_FAMILY, vendor: 'copilot' });
				if (claudeModels.length > 0) {
					// Claude is available - omit modelFamily so request/endpoint handles model selection
					modelFamily = undefined;
				}
			} catch {
				// Ignore errors, use fallback
			}
			return this._executeQueryInternal(query, cts, subAgentInvocationId, parentSessionId, modelFamily);
		});
	}

	/**
	 * Internal query execution using DebugSubagentToolCallingLoop
	 */
	private async _executeQueryInternal(
		query: string,
		cts: CancellationTokenSource,
		subAgentInvocationId: string,
		parentSessionId: string,
		modelFamily: ChatEndpointFamily | undefined
	): Promise<string> {
		try {
			const debugInstruction = [
				`Debug analysis request: ${query}`,
				'',
				'Analyze and provide findings using the available debug tools.',
			].join('\n');

			// Create the debug subagent loop - same as DebugSubagentTool does
			const loop = this._instantiationService.createInstance(DebugSubagentToolCallingLoop, {
				toolCallLimit: DEBUG_MAX_TOOL_CALLS,
				conversation: new Conversation(parentSessionId, [new Turn(generateUuid(), { type: 'user', message: debugInstruction })]),
				request: createMinimalChatRequest(),
				location: ChatLocation.Panel,
				promptText: query,
				subAgentInvocationId: subAgentInvocationId,
				modelFamily, // Use selected model family for endpoint selection (undefined when Claude available)
			});

			// Run the loop with no output stream (panel handles display separately)
			const loopResult = await loop.run(undefined, cts.token);

			let subagentResponse = '';
			let success = false;
			if (loopResult.response.type === ChatFetchResponseType.Success) {
				subagentResponse = loopResult.toolCallRounds.at(-1)?.response ?? loopResult.round.response ?? '';
				success = true;
			} else {
				subagentResponse = `The debug subagent request failed with this message:\n${loopResult.response.type}: ${loopResult.response.reason}`;
			}

			// Fire event for debug panel to receive the response
			this._debugContextService.fireDebugSubagentResponse({
				query,
				response: subagentResponse,
				success,
				timestamp: new Date()
			});

			return subagentResponse;

		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const response = `Debug analysis failed: ${errorMsg}`;

			this._debugContextService.fireDebugSubagentResponse({
				query,
				response,
				success: false,
				timestamp: new Date()
			});

			return response;
		} finally {
			cts.dispose();
		}
	}
}
