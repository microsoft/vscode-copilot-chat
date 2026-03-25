/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { URI } from '../../../util/vs/base/common/uri';
import { LanguageModelTextPart } from '../../../vscodeTypes';
import { ToolName } from '../../tools/common/toolNames';
import { IToolsService } from '../../tools/common/toolsService';

export const ITodoListContextProvider = createServiceIdentifier<ITodoListContextProvider>('ITodoListContextProvider');
export interface ITodoListContextProvider {
	getCurrentTodoContext(sessionResource: URI): Promise<string | undefined>;
}

export class TodoListContextProvider implements ITodoListContextProvider {
	constructor(
		@IToolsService private readonly toolsService: IToolsService,
	) { }

	async getCurrentTodoContext(sessionResource: URI): Promise<string | undefined> {
		try {
			const result = await this.toolsService.invokeTool(
				ToolName.CoreManageTodoList,
				{
					input: {
						operation: 'read',
						chatSessionResource: sessionResource.toString() // passed as string, not sure if still needed. See https://github.com/microsoft/vscode/blob/0b84fd1b4b00ea54e1c56f296244c2a49f9c334c/src/vs/workbench/contrib/chat/common/tools/builtinTools/manageTodoListTool.ts#L103
					},
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

			if (!todoList.trim() || todoList === 'No todo list found.') {
				return undefined;
			}

			return todoList;
		} catch (error) {
			return undefined;
		}
	}
}
