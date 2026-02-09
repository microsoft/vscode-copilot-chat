/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChatExtendedRequestHandler } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

/**
 * Chat participant for product growth and user education.
 * Sends educational messages to teach users how to use Copilot features.
 */
export class GrowthChatSessionParticipant extends Disposable {
	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	createHandler(): ChatExtendedRequestHandler {
		return this.handleRequest.bind(this);
	}

	private async handleRequest(
		request: vscode.ChatRequest,
		context: vscode.ChatContext,
		stream: vscode.ChatResponseStream,
		token: vscode.CancellationToken
	): Promise<vscode.ChatResult | void> {
		this.logService.info(`[GrowthChatSessionParticipant] Handling request: ${request.prompt}`);

		// For now, just send a simple educational message
		stream.markdown(vscode.l10n.t('Welcome! This is an educational message from Copilot Growth.'));

		return {};
	}
}
