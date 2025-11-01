/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../util/vs/base/common/uri';

/**
 * Arguments for the Copilot CLI str_replace_editor tool.
 * This tool is used by Copilot CLI to perform file editing operations.
 */
interface StrReplaceEditorArgs {
	/** The edit command to execute */
	command: 'view' | 'str_replace' | 'insert' | 'create' | 'undo_edit';
	/** The file path to operate on */
	path: string;
}

/**
 * Type guard to check if a tool call is a Copilot CLI edit operation.
 * This function validates that the tool is the str_replace_editor and that it's
 * performing an actual edit operation (not just viewing).
 *
 * @param toolName - The name of the tool being invoked
 * @param toolArgs - The arguments passed to the tool
 * @returns true if this is a Copilot CLI edit tool call (excludes 'view' commands)
 */
export function isCopilotCliEditToolCall(toolName: string, toolArgs: unknown): toolArgs is StrReplaceEditorArgs {
	return toolName === 'str_replace_editor'
		&& typeof toolArgs === 'object'
		&& toolArgs !== null
		&& 'command' in toolArgs
		&& toolArgs.command !== 'view';
}

/**
 * Extracts the list of file URIs that will be affected by a Copilot CLI edit tool call.
 * This is used to track which files are being modified during a Copilot CLI session.
 *
 * @param toolName - The name of the tool being invoked
 * @param toolArgs - The arguments passed to the tool
 * @returns An array of URIs for files that will be affected by the edit operation.
 *          Returns an empty array if the tool is not an edit operation or has no path.
 */
export function getAffectedUrisForEditTool(toolName: string, toolArgs: unknown): URI[] {
	if (isCopilotCliEditToolCall(toolName, toolArgs) && toolArgs.path) {
		return [URI.file(toolArgs.path)];
	}

	return [];
}
