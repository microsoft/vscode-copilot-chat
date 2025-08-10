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
	lastConversation: Conversation | undefined;
	/**
	 * Gets all conversations in the store, returning them as an array of objects
	 * containing both the responseId and the conversation data.
	 */
	getAllConversations(): Array<{ responseId: string; conversation: Conversation }>;
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

	get lastConversation(): Conversation | undefined {
		return this.conversationMap.last;
	}

	getAllConversations(): Array<{ responseId: string; conversation: Conversation }> {
		const conversations: Array<{ responseId: string; conversation: Conversation }> = [];
		// Use the forEach method from the underlying LinkedMap to iterate through all conversations
		this.conversationMap.forEach((conversation, responseId) => {
			conversations.push({ responseId, conversation });
		});
		return conversations;
	}
}
