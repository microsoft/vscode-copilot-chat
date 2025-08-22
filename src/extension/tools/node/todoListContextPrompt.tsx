/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { ITodoListContextProvider } from '../../prompt/node/todoListContextProvider';
import { Tag } from '../../prompts/node/base/tag';
import { ToolName } from '../common/toolNames';

export interface TodoListContextPromptProps extends BasePromptElementProps {
	sessionId?: string;
}

/**
 * A wrapper prompt element that provides todo list context
 */
export class TodoListContextPrompt extends PromptElement<TodoListContextPromptProps> {
	constructor(
		props: any,
		@ITodoListContextProvider private readonly todoListContextProvider: ITodoListContextProvider,
	) {
		super(props);
	}

	async render() {
		const sessionId = this.props.sessionId;
		if (!sessionId) {
			return null;
		}
		const todoContext = await this.todoListContextProvider.getCurrentTodoContext(sessionId);
		return (
			<Tag name="todoList">
				{todoContext || <>Empty todo list. Call `{ToolName.CoreManageTodoList}` to set todos as needed.</>}
			</Tag>
		);
	}
}
