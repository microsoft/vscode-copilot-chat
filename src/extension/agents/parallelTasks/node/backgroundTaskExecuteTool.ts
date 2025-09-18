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

interface IBackgroundTaskExecuteParams {
	taskSuggestions: ParallelTaskSuggestion[];
	executionMode?: 'immediate' | 'queued' | 'user-approval';
	notifyOnCompletion?: boolean;
}

export class BackgroundTaskExecuteTool implements ICopilotTool<IBackgroundTaskExecuteParams> {
	public static readonly toolName = ToolName.ExecuteBackgroundTasks;

	constructor(
		@IParallelTaskService private readonly parallelTaskService: IParallelTaskService
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IBackgroundTaskExecuteParams>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const args = options.input;

		if (!args.taskSuggestions || args.taskSuggestions.length === 0) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('Error: No task suggestions provided for execution.')
			]);
		}

		try {
			const executionMode = args.executionMode || 'queued';
			const results: string[] = [];

			// Filter tasks that can run in background based on execution mode
			const executableTasks = args.taskSuggestions.filter(task => {
				if (executionMode === 'immediate') {
					return task.canRunInBackground && task.suggestedTrigger === 'immediate';
				}
				return task.canRunInBackground;
			});

			if (executableTasks.length === 0) {
				return new LanguageModelToolResult([
					new LanguageModelTextPart('No tasks are suitable for background execution with the current settings.')
				]);
			}

			// Execute each task
			for (const task of executableTasks) {
				try {
					const execution = await this.parallelTaskService.executeBackgroundTask(task, token);

					switch (executionMode) {
						case 'immediate':
							results.push(`🚀 **Started immediately**: ${task.title}`);
							results.push(`   📋 ${task.description}`);
							results.push(`   ⏱️ Est. duration: ${task.estimatedDuration}`);
							results.push(`   🆔 Task ID: ${execution.id}`);
							break;
						case 'queued':
							results.push(`⏳ **Queued for execution**: ${task.title}`);
							results.push(`   📋 ${task.description}`);
							results.push(`   🆔 Task ID: ${execution.id}`);
							break;
						case 'user-approval':
							results.push(`👋 **Requesting approval**: ${task.title}`);
							results.push(`   📋 ${task.description}`);
							results.push(`   ⚠️ Requires user confirmation before execution`);
							break;
					}

					if (task.constraints.length > 0) {
						results.push(`   ⚠️ Constraints: ${task.constraints.join(', ')}`);
					}

					results.push(''); // Empty line for spacing
				} catch (error) {
					results.push(`❌ Failed to execute ${task.title}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			// Add summary
			const runningTasks = this.parallelTaskService.getRunningTasks();
			const backgroundTasks = runningTasks.filter(t => t.status === 'running' || t.status === 'queued');

			if (backgroundTasks.length > 0) {
				results.push('---');
				results.push(`📊 **Background Tasks Status**: ${backgroundTasks.length} task(s) running or queued`);

				if (args.notifyOnCompletion !== false) {
					results.push('🔔 You will be notified when tasks complete');
				}
			}

			return new LanguageModelToolResult([
				new LanguageModelTextPart(results.join('\n'))
			]);

		} catch (error) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`Error executing background tasks: ${error instanceof Error ? error.message : String(error)}`)
			]);
		}
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IBackgroundTaskExecuteParams>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		const taskCount = options.input.taskSuggestions?.length || 0;
		return {
			invocationMessage: `Executing ${taskCount} background task(s)...`
		};
	}
}

// Register the tool with the tool registry
ToolRegistry.registerTool(BackgroundTaskExecuteTool);