/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../../tools/common/toolsRegistry';
import { ParallelTaskSuggestion } from '../common/types';
import { IParallelTaskService } from './parallelTaskService';

interface IParallelTaskSuggestToolParams {
	operation?: 'suggest' | 'execute' | 'status';
	mainTaskDescription?: string;
	workspaceContext?: {
		projectType?: string;
		frameworksUsed?: string[];
		recentChanges?: string[];
		selectedFiles?: string[];
	};
	taskSuggestions?: Array<{
		id: string;
		title: string;
		description: string;
		category?: string;
		priority: 'high' | 'medium' | 'low';
		estimatedDuration: string;
		reasoning?: string;
		expectedOutcome?: string;
		canRunInBackground: boolean;
		suggestedTrigger: 'immediate' | 'after-main-task' | 'on-user-approval';
		toolsRequired?: string[];
	}>;
	sessionId?: string;
}

export class ParallelTaskSuggestTool implements ICopilotTool<IParallelTaskSuggestToolParams> {
	public static readonly toolName = ToolName.SuggestParallelTasks;

	// In-memory storage for parallel tasks (like VS Code's todo service)
	private readonly taskStore = new Map<string, ParallelTaskSuggestion[]>();

	constructor(
		@IParallelTaskService private readonly parallelTaskService: IParallelTaskService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IParallelTaskSuggestToolParams>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const args = options.input;
		const sessionId = args.sessionId || 'default';
		const operation = args.operation || 'suggest';

		switch (operation) {
			case 'suggest':
				return this.handleSuggestOperation(args, sessionId);
			case 'execute':
				return this.handleExecuteOperation(args, sessionId, token);
			case 'status':
				return this.handleStatusOperation(sessionId);
			default:
				return new LanguageModelToolResult([
					new LanguageModelTextPart('Error: Unknown operation. Use "suggest", "execute", or "status".')
				]);
		}
	}

	private handleSuggestOperation(args: IParallelTaskSuggestToolParams, sessionId: string): vscode.LanguageModelToolResult {
		if (!args.mainTaskDescription) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('Error: mainTaskDescription is required for suggest operation.')
			]);
		}

		// Return context information for the language model to analyze
		// The language model will use this context to generate task suggestions
		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				`## Main Task Context\n\n` +
				`**Task:** ${args.mainTaskDescription}\n\n` +
				`**Project Type:** ${args.workspaceContext?.projectType || 'unknown'}\n` +
				`**Frameworks:** ${args.workspaceContext?.frameworksUsed?.join(', ') || 'none specified'}\n` +
				`**Recent Changes:** ${args.workspaceContext?.recentChanges?.length || 0} files\n` +
				`**Selected Files:** ${args.workspaceContext?.selectedFiles?.length || 0} files\n\n` +
				`Based on this context, suggest parallel tasks that can run alongside the main work. ` +
				`Use the "execute" operation with taskSuggestions to implement the suggestions.`
			)
		]);
	}

	private handleExecuteOperation(args: IParallelTaskSuggestToolParams, sessionId: string, token: vscode.CancellationToken): vscode.LanguageModelToolResult {
		if (!args.taskSuggestions || args.taskSuggestions.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('Error: taskSuggestions are required for execute operation.')
			]);
		}

		// Convert the task suggestions to our internal format
		const tasks: ParallelTaskSuggestion[] = args.taskSuggestions.map(task => ({
			id: task.id,
			title: task.title,
			description: task.description,
			category: task.category,
			priority: task.priority,
			estimatedDuration: task.estimatedDuration,
			reasoning: task.reasoning,
			expectedOutcome: task.expectedOutcome,
			constraints: [],
			dependencies: [],
			canRunInBackground: task.canRunInBackground,
			suggestedTrigger: task.suggestedTrigger,
			toolsRequired: task.toolsRequired || [],
		}));

		// Store the tasks
		this.taskStore.set(sessionId, tasks);

		// Execute tasks that are marked for immediate execution
		const immediateExecutionTasks = tasks.filter(task => task.suggestedTrigger === 'immediate');
		for (const task of immediateExecutionTasks) {
			// Execute in background without waiting
			this.parallelTaskService.executeBackgroundTask(task, token);
		}

		const executedCount = immediateExecutionTasks.length;
		const totalCount = tasks.length;

		return new LanguageModelToolResult([
			new LanguageModelTextPart(
				`Successfully stored ${totalCount} parallel task suggestion${totalCount !== 1 ? 's' : ''}. ` +
				`${executedCount > 0 ? `Started ${executedCount} immediate task${executedCount !== 1 ? 's' : ''} in background.` : ''}`
			)
		]);
	}

	private handleStatusOperation(sessionId: string): vscode.LanguageModelToolResult {
		const storedTasks = this.taskStore.get(sessionId) || [];
		const runningTasks = this.parallelTaskService.getRunningTasks();

		if (storedTasks.length === 0 && runningTasks.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('No parallel tasks found.')
			]);
		}

		const response = this.formatTaskStatus(storedTasks, runningTasks);
		return new LanguageModelToolResult([
			new LanguageModelTextPart(response)
		]);
	}

	private formatTaskStatus(storedTasks: ParallelTaskSuggestion[], runningTasks: any[]): string {
		const lines = ['## Parallel Tasks Status', ''];

		if (storedTasks.length > 0) {
			lines.push(`**Stored Suggestions:** ${storedTasks.length}`);
			storedTasks.forEach((task, index) => {
				const priorityIcon = this.getPriorityIcon(task.priority);
				lines.push(`${index + 1}. ${task.title} ${priorityIcon} (${task.suggestedTrigger})`);
			});
			lines.push('');
		}

		if (runningTasks.length > 0) {
			lines.push(`**Running Tasks:** ${runningTasks.length}`);
			runningTasks.forEach((execution, index) => {
				const statusIcon = this.getStatusIcon(execution.status);
				lines.push(`${index + 1}. ${execution.suggestion.title} ${statusIcon} (${execution.status})`);
			});
		}

		return lines.join('\n');
	}

	private getPriorityIcon(priority: 'high' | 'medium' | 'low'): string {
		switch (priority) {
			case 'high': return '🔴';
			case 'medium': return '🟡';
			case 'low': return '🟢';
			default: return '';
		}
	}

	private getStatusIcon(status: string): string {
		switch (status) {
			case 'queued': return '⏳';
			case 'running': return '🔄';
			case 'completed': return '✅';
			case 'failed': return '❌';
			case 'cancelled': return '⏹️';
			default: return '❓';
		}
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IParallelTaskSuggestToolParams>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const args = options.input;
		const operation = args.operation || 'suggest';

		let message: string;
		if (operation === 'suggest') {
			message = 'Analyzing task for parallel work opportunities...';
		} else if (operation === 'execute') {
			const taskCount = args.taskSuggestions?.length || 0;
			message = `Executing ${taskCount} parallel task${taskCount !== 1 ? 's' : ''}...`;
		} else {
			message = 'Checking parallel task status...';
		}

		return {
			invocationMessage: message
		};
	}
}

// Register the tool with the tool registry
ToolRegistry.registerTool(ParallelTaskSuggestTool);