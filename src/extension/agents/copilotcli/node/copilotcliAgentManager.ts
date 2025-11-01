/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ModelProvider } from '@github/copilot/sdk';
import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ILogService } from '../../../../platform/log/common/logService';
import { Disposable } from '../../../../util/vs/base/common/lifecycle';
import { CopilotCLIPromptResolver } from './copilotcliPromptResolver';
import { ICopilotCLISessionService } from './copilotcliSessionService';

export class CopilotCLIAgentManager extends Disposable {
	constructor(
		private readonly promptResolver: CopilotCLIPromptResolver,
		@ILogService private readonly logService: ILogService,
		@ICopilotCLISessionService private readonly sessionService: ICopilotCLISessionService,
	) {
		super();
	}

	async handleRequest(
		copilotcliSessionId: string | undefined,
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		modelId: ModelProvider | undefined,
		workingDirectory: string | undefined,
		token: vscode.CancellationToken
	): Promise<{ copilotcliSessionId: string | undefined }> {
		const sessionIdForLog = copilotcliSessionId ?? 'new';
		this.logService.trace(`[CopilotCLIAgentManager] Handling request for sessionId=${sessionIdForLog}.`);

		const { prompt, attachments } = await this.promptResolver.resolvePrompt(request, token);
		// Check if we already have a session wrapper
		let session = copilotcliSessionId ? await this.sessionService.getSession(copilotcliSessionId, modelId, false, token) : undefined;

		if (session) {
			this.logService.trace(`[CopilotCLIAgentManager] Reusing CopilotCLI session ${copilotcliSessionId}.`);
		} else if (copilotcliSessionId) {
			stream.warning(l10n.t('Chat session not found.'));
			return { copilotcliSessionId: undefined };
		} else {
			session = await this.sessionService.createSession(prompt, modelId, token);
		}

		await session.invoke(prompt, attachments, request.toolInvocationToken, stream, modelId, workingDirectory, token);

		return { copilotcliSessionId: session.sessionId };
	}
}
