/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { LanguageModelTextPart } from '../../../vscodeTypes';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';

export const ITodoListContextProvider = createServiceIdentifier<ITodoListContextProvider>('ITodoListContextProvider');
export interface ITodoListContextProvider {
	getCurrentTodoContext(sessionId: string): Promise<string | undefined>;
}

export class TodoListContextProvider implements ITodoListContextProvider {
	constructor(
		@IToolsService private readonly toolsService: IToolsService,
	) { }

	async getCurrentTodoContext(sessionId: string): Promise<string | undefined> {
		try {
			const result = await this.toolsService.invokeTool(
				ToolName.CoreManageTodoList,
				{
					input: { operation: 'read', chatSessionId: sessionId }
				} as any,
				CancellationToken.None
			);

			if (!result || !result.content) {
				return undefined;
			}

			const todoList = result.content
				.filter((part): part is LanguageModelTextPart => part instanceof LanguageModelTextPart)
				.map(part => part.value)
				.join('\n');

			if (!todoList.trim()) {
				return undefined;
			}

			return todoList;
		} catch (error) {
			return undefined;
		}
	}
}
