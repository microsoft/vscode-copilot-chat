/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type * as vscode from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { ToolName } from '../common/toolNames';
import { ICopilotToolExtension, ToolRegistry } from '../common/toolsRegistry';

interface IManageTodoListParams {
	operation: 'write' | 'read';
	todoList?: readonly {
		readonly id: number;
		readonly title: string;
		readonly description: string;
		readonly status: 'not-started' | 'in-progress' | 'completed';
	}[];
}


/**
 * A thin wrapper tool to provide custom behavior on top of the internal manage_todo_list tool.
 * This allows the extension to override the tool definition based on the model or other factors.
 */
class ManageTodoListToolExtension implements ICopilotToolExtension<IManageTodoListParams> {
	static readonly toolName = ToolName.CoreManageTodoList;
	constructor(
		@ILogService readonly _logService: ILogService
	) { }

	alternativeDefinition(originTool: vscode.LanguageModelToolInformation, chatEndpoint: IChatEndpoint | undefined): vscode.LanguageModelToolInformation {
		// specialize the tool definition for gpt-5 to reduce the frequency
		const model = chatEndpoint?.model;
		if (model === 'gpt-5-codex') {
			return {
				...originTool,
				description: originTool.description?.replace('VERY frequently ', ''),
			};
		}

		return originTool;
	}
}

ToolRegistry.registerToolExtension(ManageTodoListToolExtension);
