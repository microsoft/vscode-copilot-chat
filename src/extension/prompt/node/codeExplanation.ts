/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { ChatFetchResponseType, ChatLocation } from '../../../platform/chat/common/commonTypes';
import { IEndpointProvider } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { renderPromptElement } from '../../prompts/node/base/promptRenderer';
import { CodeExplanationPrompt } from '../../prompts/node/panel/codeExplanation';
import { TurnStatus } from '../common/conversation';
import { addHistoryToConversation } from './chatParticipantRequestHandler';

export class ChatCodeExplanationProvider implements vscode.ChatCodeExplanationProvider {

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEndpointProvider private endpointProvider: IEndpointProvider,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async provideCodeExplanation(
		context: vscode.ChatContext,
		diffHunks: vscode.ChatDiffHunk[],
		token: vscode.CancellationToken,
	): Promise<vscode.ChatDiffHunkExplanation[]> {

		const { turns } = this.instantiationService.invokeFunction(accessor => addHistoryToConversation(accessor, context.history));
		if (turns.filter(t => t.responseStatus === TurnStatus.Success).length === 0) {
			return [];
		}

		const endpoint = await this.endpointProvider.getChatEndpoint('gpt-4o-mini');
		const { messages } = await renderPromptElement(this.instantiationService, endpoint, CodeExplanationPrompt, {
			history: turns,
			diffHunks
		});

		const response = await endpoint.makeChatRequest(
			'codeExplanation',
			messages,
			undefined,
			token,
			ChatLocation.Panel,
			undefined,
			undefined,
			false
		);

		if (token.isCancellationRequested) {
			return [];
		}

		if (response.type === ChatFetchResponseType.Success) {
			try {
				// Parse the JSON response to get explanations
				const explanations = JSON.parse(response.value.trim()) as vscode.ChatDiffHunkExplanation[];

				// Validate that we have explanations for the requested hunks
				const validExplanations = explanations.filter(explanation =>
					diffHunks.some(hunk => hunk.hunkId === explanation.hunkId)
				);

				return validExplanations;
			} catch (error) {
				this.logService.error(`Failed to parse code explanation response: ${error}`);
				return [];
			}
		} else {
			this.logService.error(`Failed to fetch code explanations because of response type (${response.type}) and reason (${response.reason})`);
			return [];
		}
	}
}
