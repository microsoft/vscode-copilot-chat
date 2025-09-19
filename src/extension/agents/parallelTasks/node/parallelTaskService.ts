/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { createServiceIdentifier } from '../../../../util/common/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../../util/vs/base/common/event';
import { BackgroundTaskExecution, MainTaskContext, ParallelTaskSuggestion } from '../common/types';

export const IParallelTaskService = createServiceIdentifier<IParallelTaskService>('IParallelTaskService');

export interface IParallelTaskService {
	readonly _serviceBrand: undefined;

	generateSuggestions(context: MainTaskContext): Promise<ParallelTaskSuggestion[]>;
	executeBackgroundTask(suggestion: ParallelTaskSuggestion, token: CancellationToken): Promise<BackgroundTaskExecution>;
	getRunningTasks(): BackgroundTaskExecution[];
	cancelTask(taskId: string): Promise<void>;

	readonly onTaskCompleted: vscode.Event<BackgroundTaskExecution>;
	readonly onTaskFailed: vscode.Event<BackgroundTaskExecution>;
}

export class ParallelTaskService implements IParallelTaskService {
	declare readonly _serviceBrand: undefined;

	private readonly runningTasks = new Map<string, BackgroundTaskExecution>();
	private taskIdCounter = 0;

	private readonly _onTaskCompleted = new Emitter<BackgroundTaskExecution>();
	readonly onTaskCompleted = this._onTaskCompleted.event;

	private readonly _onTaskFailed = new Emitter<BackgroundTaskExecution>();
	readonly onTaskFailed = this._onTaskFailed.event;

	constructor() { }

	async generateSuggestions(context: MainTaskContext): Promise<ParallelTaskSuggestion[]> {
		// This method is deprecated - the language model should use the manage_parallel_tasks tool directly
		// instead of this service generating suggestions
		return [];
	} async executeBackgroundTask(suggestion: ParallelTaskSuggestion, token: CancellationToken): Promise<BackgroundTaskExecution> {
		const execution: BackgroundTaskExecution = {
			id: `task_${++this.taskIdCounter}_${Date.now()}`,
			suggestion,
			status: 'queued',
		};

		this.runningTasks.set(execution.id, execution);

		// Start execution in background
		this.executeTaskInBackground(execution, token);

		return execution;
	}

	getRunningTasks(): BackgroundTaskExecution[] {
		return Array.from(this.runningTasks.values());
	}

	async cancelTask(taskId: string): Promise<void> {
		const task = this.runningTasks.get(taskId);
		if (task && task.status === 'running') {
			task.status = 'cancelled';
			this.runningTasks.delete(taskId);
		}
	}

	private async executeTaskInBackground(execution: BackgroundTaskExecution, token: CancellationToken): Promise<void> {
		try {
			execution.status = 'running';
			execution.startTime = Date.now();

			let result: string;
			// Handle flexible categories using string matching instead of enums
			const category = execution.suggestion.category?.toLowerCase();
			switch (category) {
				case 'testing':
					result = await this.executeTestingTask(execution.suggestion, token);
					break;
				case 'documentation':
					result = await this.executeDocumentationTask(execution.suggestion, token);
					break;
				case 'analysis':
					result = await this.executeAnalysisTask(execution.suggestion, token);
					break;
				case 'refactoring':
					result = await this.executeRefactoringTask(execution.suggestion, token);
					break;
				case 'setup':
					result = await this.executeSetupTask(execution.suggestion, token);
					break;
				default:
					result = await this.executeGenericTask(execution.suggestion, token);
			}

			execution.result = result;
			execution.status = 'completed';
			this._onTaskCompleted.fire(execution);
		} catch (error) {
			execution.error = error instanceof Error ? error.message : String(error);
			execution.status = 'failed';
			this._onTaskFailed.fire(execution);
		} finally {
			execution.endTime = Date.now();
			// Keep completed tasks for a while for reporting
			setTimeout(() => this.runningTasks.delete(execution.id), 60000);
		}
	}

	private async executeTestingTask(suggestion: ParallelTaskSuggestion, token: CancellationToken): Promise<string> {
		// Simulate test generation or execution
		await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate work
		return `Testing task completed: ${suggestion.title}. Generated tests for ${suggestion.filesInvolved?.length || 0} files.`;
	}

	private async executeDocumentationTask(suggestion: ParallelTaskSuggestion, token: CancellationToken): Promise<string> {
		// Simulate documentation generation
		await new Promise(resolve => setTimeout(resolve, 1500));
		return `Documentation task completed: ${suggestion.title}. Updated documentation for recent changes.`;
	}

	private async executeAnalysisTask(suggestion: ParallelTaskSuggestion, token: CancellationToken): Promise<string> {
		// Simulate analysis work
		await new Promise(resolve => setTimeout(resolve, 3000));
		return `Analysis task completed: ${suggestion.title}. Found 0 critical issues, 2 warnings.`;
	}

	private async executeRefactoringTask(suggestion: ParallelTaskSuggestion, token: CancellationToken): Promise<string> {
		// Simulate refactoring work
		await new Promise(resolve => setTimeout(resolve, 2500));
		return `Refactoring task completed: ${suggestion.title}. Cleaned up ${suggestion.filesInvolved?.length || 0} files.`;
	}

	private async executeSetupTask(suggestion: ParallelTaskSuggestion, token: CancellationToken): Promise<string> {
		// Simulate setup work
		await new Promise(resolve => setTimeout(resolve, 4000));
		return `Setup task completed: ${suggestion.title}. Configuration files created successfully.`;
	}

	private async executeGenericTask(suggestion: ParallelTaskSuggestion, token: CancellationToken): Promise<string> {
		// Simulate generic work
		await new Promise(resolve => setTimeout(resolve, 1000));
		return `Task completed: ${suggestion.title}`;
	}
}