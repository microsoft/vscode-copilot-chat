/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { CancellationTokenSource } from '../../../util/vs/base/common/cancellation';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { Turn } from '../../prompt/common/conversation';
import { PromptRenderer } from '../../prompts/node/base/promptRenderer';
import { IAnalyzeConversationArgs, IPromptTaskSave, PROMPT_SAVE_ANALYZE_COMMAND, PROMPT_SAVE_CHECK_COMMAND } from '../common/types';
import { PromptSavePrompt } from './promptSavePrompt';

export { PROMPT_SAVE_ANALYZE_COMMAND, PROMPT_SAVE_CHECK_COMMAND } from '../common/types';

export class PromptSaveCommands extends Disposable {
	constructor(
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEndpointProvider private readonly endpointProvider: IEndpointProvider,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(vscode.commands.registerCommand(
			PROMPT_SAVE_CHECK_COMMAND,
			() => this.checkAvailability()
		));

		this._register(vscode.commands.registerCommand(
			PROMPT_SAVE_ANALYZE_COMMAND,
			(args: IAnalyzeConversationArgs) => this.analyzeConversation(args)
		));
	}

	private async checkAvailability(): Promise<boolean> {
		// Check if LLM analysis is available
		try {
			const models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
			return models.length > 0;
		} catch {
			return false;
		}
	}

	private async analyzeConversation(args: IAnalyzeConversationArgs): Promise<IPromptTaskSave | undefined> {
		const startTime = Date.now();

		try {
			// Convert input turns to conversation Turn objects
			const history: Turn[] = args.turns.map(turn => {
				return new Turn(
					undefined,
					{
						type: turn.role === 'user' ? 'user' : 'model',
						message: turn.content
					}
				);
			});

			// Get endpoint for free mini model
			const endpoint = await this.endpointProvider.getChatEndpoint('gpt-4.1');

			// Render the prompt using PromptRenderer to preserve DI and endpoint wiring
			const renderer = PromptRenderer.create(
				this.instantiationService,
				endpoint,
				PromptSavePrompt,
				{ history, currentQuery: args.currentQuery }
			);
			const { messages } = await renderer.render();

			// Create cancellation token
			const cts = new CancellationTokenSource();

			// Send request to LLM
			const response = await endpoint.makeChatRequest(
				'prompt-save',
				messages,
				undefined,
				cts.token,
				ChatLocation.Panel,
				undefined,
				undefined,
				false
			);

			if (cts.token.isCancellationRequested) {
				return undefined;
			}

			if (response.type !== ChatFetchResponseType.Success) {
				throw new Error(`Chat request failed: ${response.reason}`);
			}

			// Extract JSON from markdown code block
			const analysis = this.parseAnalysisResponse(response.value);

			this.telemetryService.sendMSFTTelemetryEvent('chat.promptSave.success', {
				durationMs: String(Date.now() - startTime),
				turnCount: String(args.turns.length),
			});

			return analysis;

		} catch (error) {
			this.logService.error(`Prompt save analysis failed: ${error instanceof Error ? error.message : String(error)}`);

			this.telemetryService.sendMSFTTelemetryEvent('chat.promptSave.error', {
				durationMs: String(Date.now() - startTime),
				error: error instanceof Error ? error.message : String(error),
			});

			// Return undefined on error - VS Code will fall back to simple save
			return undefined;
		}
	}

	private parseAnalysisResponse(response: string): IPromptTaskSave {
		// Extract JSON from markdown code block
		const jsonMatch = response.match(/```json\s*\n([\s\S]*?)\n```/);
		if (!jsonMatch) {
			throw new Error('No JSON code block found in response');
		}

		const parsed = JSON.parse(jsonMatch[1]);

		// Validate required fields
		if (!parsed.title || !parsed.description || !parsed.prompt) {
			throw new Error('Invalid analysis response: missing required fields');
		}

		// Sanitize title to ensure it's valid kebab-case
		const sanitizedTitle = parsed.title
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '');

		return {
			title: sanitizedTitle,
			description: parsed.description,
			prompt: parsed.prompt
		};
	}
}
