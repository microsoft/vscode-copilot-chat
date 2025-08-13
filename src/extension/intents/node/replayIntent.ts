/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type * as vscode from 'vscode';
import { ChatLocation } from '../../../platform/chat/common/commonTypes';
import { ITabsAndEditorsService } from '../../../platform/tabs/common/tabsAndEditorsService';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Event } from '../../../util/vs/base/common/event';
import { Intent } from '../../common/constants';
import { Conversation } from '../../prompt/common/conversation';
import { ChatTelemetryBuilder } from '../../prompt/node/chatParticipantTelemetry';
import { IDocumentContext } from '../../prompt/node/documentContext';
import { IIntent, IIntentInvocation, IIntentInvocationContext } from '../../prompt/node/intents';

export class ReplayIntent implements IIntent {

	static readonly ID: Intent = Intent.Replay;

	readonly id: string = ReplayIntent.ID;

	readonly description = l10n.t('Replay a previous conversation');

	readonly locations = [ChatLocation.Editor, ChatLocation.Panel];

	constructor(
		@ITabsAndEditorsService private readonly tabsAndEditorsService: ITabsAndEditorsService,
	) { }

	/**
	 * Returns the active editor's TextDocument if available.
	 */
	getActiveEditorDocument(): vscode.TextDocument | undefined {
		const editor = this.tabsAndEditorsService.activeTextEditor;
		return editor?.document;
	}

	invoke(invocationContext: IIntentInvocationContext): Promise<IIntentInvocation> {
		// implement handleRequest ourselves so we can skip implementing this.
		throw new Error('Method not implemented.');
	}

	handleRequest(conversation: Conversation, request: vscode.ChatRequest, stream: vscode.ChatResponseStream, token: CancellationToken, documentContext: IDocumentContext | undefined, agentName: string, location: ChatLocation, chatTelemetry: ChatTelemetryBuilder, onPaused: Event<boolean>): Promise<vscode.ChatResult> {

	}
}