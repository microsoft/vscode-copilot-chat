/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { ITasksService } from '../../../../platform/tasks/common/tasksService';
import { ITerminalService } from '../../../../platform/terminal/common/terminalService';
import { ToolName } from '../../../tools/common/toolNames';

export interface TerminalAndTaskStateProps extends BasePromptElementProps {
	sessionId?: string;
}

/**
 * PromptElement that gets the current task and terminal state for the chat context.
 */
export class TerminalAndTaskStatePromptElement extends PromptElement<TerminalAndTaskStateProps> {
	constructor(
		props: TerminalAndTaskStateProps,
		@ITasksService private readonly tasksService: ITasksService,
		@ITerminalService private readonly terminalService: ITerminalService
	) {
		super(props);
	}
	async render() {
		const resultTasks: ITaskPromptInfo[] = [];
		const allTasks = this.tasksService.getTasks()?.[0]?.[1] ?? [];
		const tasks = Array.isArray(allTasks) ? allTasks : [];
		const taskTerminalPids = new Set<number>();
		const taskWithTerminals = await Promise.all(tasks.map(async (task) => {
			const terminal = await this.tasksService.getTerminalForTask(task);
			const terminalPid = terminal ? await terminal.processId : undefined;
			if (terminalPid) {
				taskTerminalPids.add(terminalPid);
				return task;
			}
		}));
		for (const exec of taskWithTerminals) {
			if (exec?.label) {
				resultTasks.push({
					name: exec.label,
					isBackground: exec.isBackground,
					type: exec?.type,
					command: exec?.command,
					script: exec.script,
					problemMatcher: Array.isArray(exec.problemMatcher) && exec.problemMatcher.length > 0 ? exec.problemMatcher.join(', ') : '',
					group: exec.group,
					dependsOn: exec.dependsOn,
					isActive: this.tasksService.isTaskActive(exec),
				});
			}
		}

		if (this.terminalService && Array.isArray(this.terminalService.terminals)) {
			const terminals = await Promise.all(this.terminalService.terminals.map(async (term) => {
				const lastCommand = await this.terminalService.getLastCommandForTerminal(term);
				const pid = await term.processId;
				if (taskTerminalPids.has(pid)) {
					return undefined;
				}
				return {
					name: term.name,
					pid,
					lastCommand: lastCommand ? {
						commandLine: lastCommand.commandLine ?? '(no last command)',
						cwd: lastCommand.cwd?.toString() ?? '(unknown)',
						exitCode: lastCommand.exitCode,
					} : undefined
				} as ITerminalPromptInfo;
			}));
			const resultTerminals = terminals.filter(t => !!t);

			if (resultTerminals.length === 0 && resultTasks.length === 0) {
				return 'No tasks or terminals found.';
			}

			const renderTasks = () =>
				resultTasks.length > 0 && (
					<>
						Tasks:<br />
						{resultTasks.map((t) => (
							<>
								Task: {t.name} ({t.isBackground && `is background: ${String(t.isBackground)} `}
								{t.isActive ? ', is running' : 'is inactive'}
								{t.type ? `, type: ${t.type}` : ''}
								{t.command ? `, command: ${t.command}` : ''}
								{t.script ? `, script: ${t.script}` : ''}
								{t.problemMatcher ? `Problem Matchers: ${t.problemMatcher}` : ''}
								{t.group?.kind ? `Group: ${t.group.isDefault ? 'isDefault ' + t.group.kind : t.group.kind} ` : ''}
								{t.dependsOn ? `Depends On: ${t.dependsOn}` : ''})
								<br />
							</>
						))}
					</>
				);

			const renderTerminals = () => (
				<>
					{resultTerminals.length > 0 && (
						<>
							Terminals:<br />
							{resultTerminals.map((term: ITerminalPromptInfo) => (
								<>
									Terminal: {term.name}<br />
									{term.lastCommand ? (
										<>
											Last Command: {term.lastCommand.commandLine ?? '(no last command)'}<br />
											Cwd: {term.lastCommand.cwd ?? '(unknown)'}<br />
											Exit Code: {term.lastCommand.exitCode ?? '(unknown)'}<br />
										</>
									) : ''}
									Output: {'{'}Use {ToolName.CoreGetTerminalOutput} for terminal with ID: {term.pid}.{'}'}<br />
								</>
							))}
						</>
					)}
				</>
			);

			return (
				<>
					{resultTasks.length > 0 ? renderTasks() : 'Tasks: No tasks found.'}
					{resultTerminals.length > 0 ? renderTerminals() : 'Terminals: No terminals found.'}
				</>
			);
		}
	}
}
interface ITaskPromptInfo {
	name: string;
	isBackground: boolean;
	type?: string;
	command?: string;
	problemMatcher?: string;
	group?: { isDefault?: boolean; kind?: string };
	script?: string;
	dependsOn?: string;
	isActive?: boolean;
}

interface ITerminalPromptInfo {
	name: string;
	pid: number | undefined;
	lastCommand: { commandLine: string; cwd: string; exitCode: number | undefined } | undefined;
}