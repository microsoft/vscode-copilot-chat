/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { ITodoListContextProvider } from '../../prompt/node/todoListContextProvider';
import { Tag } from '../../prompts/node/base/tag';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';

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
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(props);
	}

	async render() {
		const sessionId = this.props.sessionId;
		if (!sessionId) {
			return null;
		}
		if (this.configurationService.getNonExtensionConfig<boolean>('chat.todoListTool.writeOnly')) {
			return null;
		}
		const todoContext = await this.todoListContextProvider.getCurrentTodoContext(sessionId);
		if (!todoContext) {
			return null;
		}
		return (
			<Tag name='todoList'>
				{todoContext}
			</Tag>
		);
	}
}
