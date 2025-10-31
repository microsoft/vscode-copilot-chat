/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../util/vs/base/common/uri';

interface StrReplaceEditorArgs {
	command: 'view' | 'str_replace' | 'insert' | 'create' | 'undo_edit';
	path: string;
}

export function isCopilotCliEditToolCall(toolName: string, toolArgs: unknown): toolArgs is StrReplaceEditorArgs {
	return toolName === 'str_replace_editor'
		&& typeof toolArgs === 'object'
		&& toolArgs !== null
		&& 'command' in toolArgs
		&& toolArgs.command !== 'view';
}

export function getAffectedUrisForEditTool(toolName: string, toolArgs: unknown): URI[] {
	if (isCopilotCliEditToolCall(toolName, toolArgs) && toolArgs.path) {
		return [URI.file(toolArgs.path)];
	}

	return [];
}
