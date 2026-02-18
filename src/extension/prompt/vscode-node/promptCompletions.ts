/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { autorun } from '../../../util/vs/base/common/observableInternal';
import { ICopilotInlineCompletionItemProviderService } from '../../completions/common/copilotInlineCompletionItemProviderService';
import { IConversationStore } from '../../conversationStore/node/conversationStore';

export class PromptCompletionContribution extends Disposable {

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IConversationStore conversationStore: IConversationStore,
		@ICopilotInlineCompletionItemProviderService copilotInlineCompletionItemProviderService: ICopilotInlineCompletionItemProviderService,
	) {
		super();
		const enabledObservable = configurationService.getConfigObservable(ConfigKey.Advanced.PromptCompletionsEnabled);
		this._register(autorun(reader => {
			if (!enabledObservable.read(reader)) {
				return;
			}
			reader.store.add(vscode.languages.registerInlineCompletionItemProvider(
				{ scheme: 'chatSessionInput' },
				new PromptCompletionsInlineProvider(conversationStore, copilotInlineCompletionItemProviderService),
				{ displayName: 'Prompt Inline Completions' }
			));
		}));
	}
}

class PromptCompletionsInlineProvider implements vscode.InlineCompletionItemProvider {

	private readonly _copilotInlineCompletionItemProvider: vscode.InlineCompletionItemProvider;

	constructor(
		private readonly conversationStore: IConversationStore,
		private readonly _copilotInlineCompletionItemProviderService: ICopilotInlineCompletionItemProviderService,
	) {
		this._copilotInlineCompletionItemProvider = this._copilotInlineCompletionItemProviderService.getOrCreateProvider();
	}

	async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
		const modelContent: string[] = [];
		const conversation = this.conversationStore.lastConversation;
		if (conversation && conversation.turns.length > 0) {
			for (const turn of conversation.turns) {
				if (turn.request.message) {
					modelContent.push(`${turn.request.message}\n`);
				}
			}
		}
		const promptText = document.getText();
		modelContent.push(promptText);
		const modelDocument = await vscode.workspace.openTextDocument({
			language: '*',
			content: modelContent.join('')
		});
		const modelPosition = modelDocument.positionAt(modelDocument.getText().length);
		const result = await this._copilotInlineCompletionItemProvider.provideInlineCompletionItems(modelDocument, modelPosition, context, token);
		return result ?? [];
	}
}