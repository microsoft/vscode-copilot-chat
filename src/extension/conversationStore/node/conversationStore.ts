/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { LRUCache } from '../../../util/vs/base/common/map';
import { Conversation } from '../../prompt/common/conversation';

export const IConversationStore = createServiceIdentifier<IConversationStore>('IConversationStore');

export interface IConversationStore {
	readonly _serviceBrand: undefined;

	addConversation(responseId: string, conversation: Conversation): void;
	getConversation(responseId: string): Conversation | undefined;
	getAllConversations(): Conversation[];
	lastConversation: Conversation | undefined;
}

export class ConversationStore implements IConversationStore {
	readonly _serviceBrand: undefined;
	private conversationMap: LRUCache<string, Conversation>;

	constructor() {
		this.conversationMap = new LRUCache<string, Conversation>(1000);
	}

	addConversation(responseId: string, conversation: Conversation): void {
		this.conversationMap.set(responseId, conversation);
	}

	getConversation(responseId: string): Conversation | undefined {
		return this.conversationMap.get(responseId);
	}

	getAllConversations(): Conversation[] {
		return Array.from(this.conversationMap.values());
	}

	get lastConversation(): Conversation | undefined {
		return this.conversationMap.last;
	}
}
