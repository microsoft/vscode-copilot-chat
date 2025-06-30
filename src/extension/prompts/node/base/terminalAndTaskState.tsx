/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BasePromptElementProps, PromptElement } from '@vscode/prompt-tsx';
import { ITasksService } from '../../../../platform/tasks/common/tasksService';
import { ITerminalService } from '../../../../platform/terminal/common/terminalService';

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
		if (Boolean('true')) {
			// https://github.com/microsoft/vscode/issues/252690
			return;
		}

		const runningTasks: { name: string; isBackground: boolean; type?: string; command?: string; problemMatcher?: string; group?: string; script?: string; dependsOn?: string; buffer: string }[] = [];
		let terminals: { name: string; buffer: string }[] = [];

		const running = this.tasksService.getTasks();
		const tasks = Array.isArray(running?.[0]?.[1]) ? running[0][1] : [];
		for (const exec of tasks) {
			if (!this.tasksService.isTaskActive(exec)) {
				continue;
			}
			// TODO:@meganrogge when there's API to determine if a terminal is a task, improve this vscode#234440
			const terminal = this.terminalService.terminals.find(t => t.name === exec.label);
			if (exec.label && terminal) {
				const buffer = this.terminalService.getBufferForTerminal(terminal);
				runningTasks.push({
					name: exec.label,
					isBackground: exec.isBackground,
					type: exec?.type,
					command: exec?.command,
					script: exec.script,
					problemMatcher: Array.isArray(exec.problemMatcher) && exec.problemMatcher.length > 0 ? exec.problemMatcher.join(', ') : '',
					group: exec.group,
					dependsOn: exec.dependsOn,
					buffer
				});
			}
		}

		if (this.terminalService && Array.isArray(this.terminalService.terminals)) {
			const copilotTerminals = await this.terminalService.getCopilotTerminals(this.props.sessionId, true);
			terminals = copilotTerminals.map((term) => {
				const buffer = this.terminalService.getBufferForTerminal(term);
				return {
					name: term.name,
					buffer
				};
			});
		}
		if (terminals.length === 0 && tasks.length === 0) {
			return;
		}

		return (
			<>
				Active Tasks:<br />
				{runningTasks.length === 0 ? (
					<>(none)<br /></>
				) : (
					<>
						{runningTasks.map((t) => (
							<>
								Task: {t.name} ( background: {String(t.isBackground)}
								{t.type ? `, type: ${t.type}` : ''}
								{t.command ? `, command: ${t.command}` : ''}
								{t.script ? `, script: ${t.script}` : ''})<br />
								{t.problemMatcher ? `Problem Matchers: ${t.problemMatcher}` : ''}<br />
								{t.group ? `Group: ${t.group}` : ''}<br />
								{t.dependsOn ? `Depends On: ${t.dependsOn}` : ''}<br />
								Output: {t.buffer ?? '(no output)'}<br />
								<br />
							</>
						))}
					</>
				)}
				<br />
				Active Terminals:<br />
				{terminals.length === 0 ? (
					<>(No active Copilot terminals)<br /></>
				) : (
					<>
						{terminals.map((term, i) => (
							<>
								Terminal: {term.name} with output: {term.buffer ?? '(no output)'}<br />
							</>
						))}
					</>
				)}
			</>
		);
	}
}
