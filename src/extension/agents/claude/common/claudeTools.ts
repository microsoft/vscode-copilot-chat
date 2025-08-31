/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
	todos: {
		content: string;
		status: 'pending' | 'in_progress' | 'completed';
		activeForm: string;
	}[];
}

export interface IExitPlanModeInput {
	plan: string;
}

export interface ITaskToolInput {
	description: string;
	subagent_type: string;
	prompt: string;
}
