/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { URI } from '../../../../util/vs/base/common/uri';

export enum ClaudeToolNames {
	Task = 'Task',
	Bash = 'Bash',
	Glob = 'Glob',
	Grep = 'Grep',
	LS = 'LS',
	ExitPlanMode = 'ExitPlanMode',
	Read = 'Read',
	Edit = 'Edit',
	MultiEdit = 'MultiEdit',
	Write = 'Write',
	NotebookEdit = 'NotebookEdit',
	WebFetch = 'WebFetch',
	TodoWrite = 'TodoWrite',
	WebSearch = 'WebSearch',
	BashOutput = 'BashOutput',
	KillBash = 'KillBash',
}

export interface ITodoWriteInput {
	readonly todos: readonly {
		readonly content: string;
		readonly status: 'pending' | 'in_progress' | 'completed';
		readonly activeForm: string;
	}[];
}

export interface IExitPlanModeInput {
	readonly plan: string;
}

export interface ITaskToolInput {
	readonly description: string;
	readonly subagent_type: string;
	readonly prompt: string;
}

export interface IBashToolInput {
	readonly command: string;
}

export interface IReadToolInput {
	readonly file_path: string;
}

export interface IGlobToolInput {
	readonly pattern: string;
}

export interface IGrepToolInput {
	readonly pattern: string;
}

export interface ILSToolInput {
	readonly path: string;
}

export interface IEditToolInput {
	readonly file_path: string;
}

export interface IWriteToolInput {
	readonly file_path: string;
}

export interface INotebookEditToolInput {
	readonly notebook_path: string;
}

export const claudeEditTools: readonly string[] = [ClaudeToolNames.Edit, ClaudeToolNames.MultiEdit, ClaudeToolNames.Write, ClaudeToolNames.NotebookEdit];

export function getAffectedUrisForEditTool(input: PreToolUseHookInput): URI[] {
	switch (input.tool_name) {
		case ClaudeToolNames.Edit:
		case ClaudeToolNames.MultiEdit:
			return [URI.file((input.tool_input as IEditToolInput).file_path)];
		case ClaudeToolNames.Write:
			return [URI.file((input.tool_input as IWriteToolInput).file_path)];
		case ClaudeToolNames.NotebookEdit:
			return [URI.file((input.tool_input as INotebookEditToolInput).notebook_path)];
		default:
			return [];
	}
}