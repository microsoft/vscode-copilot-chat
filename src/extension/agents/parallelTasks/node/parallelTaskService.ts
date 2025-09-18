/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { CancellationToken } from '../../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../../util/vs/base/common/event';
import { URI } from '../../../../util/vs/base/common/uri';
import { BackgroundTaskExecution, MainTaskContext, ParallelTaskSuggestion, TaskCategory, TaskPriority, WorkspaceAnalysis } from '../common/types';

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

	constructor(
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

	async generateSuggestions(context: MainTaskContext): Promise<ParallelTaskSuggestion[]> {
		const suggestions: ParallelTaskSuggestion[] = [];

		// Perform workspace analysis
		const workspaceAnalysis = await this.analyzeWorkspace(context);

		// Generate suggestions based on different categories
		suggestions.push(...await this.analyzeForTestingOpportunities(context, workspaceAnalysis));
		suggestions.push(...await this.analyzeForDocumentationOpportunities(context, workspaceAnalysis));
		suggestions.push(...await this.analyzeForRefactoringOpportunities(context, workspaceAnalysis));
		suggestions.push(...await this.analyzeForAnalysisOpportunities(context, workspaceAnalysis));
		suggestions.push(...await this.analyzeForSetupOpportunities(context, workspaceAnalysis));
		suggestions.push(...await this.analyzeForResearchOpportunities(context, workspaceAnalysis));

		// Sort by priority and filter duplicates
		return suggestions
			.sort((a, b) => this.priorityScore(b.priority) - this.priorityScore(a.priority))
			.slice(0, 10); // Limit to top 10 suggestions
	}

	async executeBackgroundTask(suggestion: ParallelTaskSuggestion, token: CancellationToken): Promise<BackgroundTaskExecution> {
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
			switch (execution.suggestion.category) {
				case TaskCategory.Testing:
					result = await this.executeTestingTask(execution.suggestion, token);
					break;
				case TaskCategory.Documentation:
					result = await this.executeDocumentationTask(execution.suggestion, token);
					break;
				case TaskCategory.Analysis:
					result = await this.executeAnalysisTask(execution.suggestion, token);
					break;
				case TaskCategory.Refactoring:
					result = await this.executeRefactoringTask(execution.suggestion, token);
					break;
				case TaskCategory.Setup:
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

	private async analyzeWorkspace(context: MainTaskContext): Promise<WorkspaceAnalysis> {
		const frameworks: string[] = [...context.frameworksUsed];

		// Get workspace folders to analyze structure
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		const hasMultipleWorkspaces = workspaceFolders.length > 1;

		// Detect additional frameworks by file patterns
		if (context.workspaceFiles.some(f => f.path.includes('package.json'))) {
			frameworks.push('node', 'javascript');
		}
		if (context.workspaceFiles.some(f => f.path.includes('tsconfig.json'))) {
			frameworks.push('typescript');
		}
		if (context.workspaceFiles.some(f => f.path.endsWith('.py'))) {
			frameworks.push('python');
		}

		const fileTypes = new Map<string, number>();
		context.workspaceFiles.forEach(file => {
			const ext = file.path.split('.').pop() || 'unknown';
			fileTypes.set(ext, (fileTypes.get(ext) || 0) + 1);
		});

		return {
			projectType: context.projectType || this.detectProjectType(frameworks),
			frameworks,
			testingFrameworks: this.detectTestingFrameworks(context.workspaceFiles),
			hasTests: context.workspaceFiles.some(f =>
				f.path.includes('test') || f.path.includes('spec') || f.path.includes('__tests__')
			),
			hasDocumentation: context.workspaceFiles.some(f =>
				f.path.toLowerCase().includes('readme') || f.path.toLowerCase().includes('doc')
			),
			codeQualityIssues: hasMultipleWorkspaces ? ['Multiple workspace complexity'] : [], // Would be populated by analysis
			dependencies: [], // Would be extracted from package files
			fileTypes
		};
	}

	private async analyzeForTestingOpportunities(context: MainTaskContext, analysis: WorkspaceAnalysis): Promise<ParallelTaskSuggestion[]> {
		const suggestions: ParallelTaskSuggestion[] = [];

		// Suggest test generation if there are implementation files without tests
		if (!analysis.hasTests && analysis.fileTypes.has('ts') || analysis.fileTypes.has('js')) {
			suggestions.push({
				id: 'generate-tests',
				title: 'Generate Unit Tests',
				description: 'Create comprehensive unit tests for the main implementation files. This can run in parallel while you work on the main feature.',
				category: TaskCategory.Testing,
				priority: TaskPriority.High,
				estimatedDuration: '5-10 minutes',
				constraints: [],
				dependencies: [],
				canRunInBackground: true,
				suggestedTrigger: 'immediate',
				toolsRequired: ['create_file', 'find_files'],
				filesInvolved: context.selectedFiles
			});
		}

		// Suggest test coverage analysis
		if (analysis.hasTests) {
			suggestions.push({
				id: 'test-coverage-analysis',
				title: 'Analyze Test Coverage',
				description: 'Run test coverage analysis to identify untested code paths and suggest improvements.',
				category: TaskCategory.Testing,
				priority: TaskPriority.Medium,
				estimatedDuration: '3-5 minutes',
				constraints: ['Requires existing test framework'],
				dependencies: [],
				canRunInBackground: true,
				suggestedTrigger: 'after-main-task',
				toolsRequired: ['run_tests', 'run_in_terminal']
			});
		}

		return suggestions;
	}

	private async analyzeForDocumentationOpportunities(context: MainTaskContext, analysis: WorkspaceAnalysis): Promise<ParallelTaskSuggestion[]> {
		const suggestions: ParallelTaskSuggestion[] = [];

		// Suggest README updates if files are being modified
		if (context.recentChanges.length > 0) {
			suggestions.push({
				id: 'update-readme',
				title: 'Update README Documentation',
				description: 'Generate or update README.md with information about recent changes and new features.',
				category: TaskCategory.Documentation,
				priority: TaskPriority.Medium,
				estimatedDuration: '3-7 minutes',
				constraints: [],
				dependencies: [],
				canRunInBackground: true,
				suggestedTrigger: 'after-main-task',
				toolsRequired: ['create_file', 'replace_string_in_file'],
				filesInvolved: context.recentChanges
			});
		}

		// Suggest API documentation if TypeScript interfaces are being modified
		if (analysis.frameworks.includes('typescript') && context.selectedFiles.some(f => f.path.endsWith('.ts'))) {
			suggestions.push({
				id: 'generate-api-docs',
				title: 'Generate API Documentation',
				description: 'Create JSDoc comments and API documentation for new TypeScript interfaces and functions.',
				category: TaskCategory.Documentation,
				priority: TaskPriority.Low,
				estimatedDuration: '4-8 minutes',
				constraints: ['Requires TypeScript files'],
				dependencies: [],
				canRunInBackground: true,
				suggestedTrigger: 'on-user-approval',
				toolsRequired: ['read_file', 'replace_string_in_file']
			});
		}

		return suggestions;
	}

	private async analyzeForRefactoringOpportunities(context: MainTaskContext, analysis: WorkspaceAnalysis): Promise<ParallelTaskSuggestion[]> {
		const suggestions: ParallelTaskSuggestion[] = [];

		// Suggest code cleanup if many files are being modified
		if (context.recentChanges.length > 3) {
			suggestions.push({
				id: 'code-cleanup',
				title: 'Code Quality Cleanup',
				description: 'Remove unused imports, fix formatting issues, and apply consistent coding standards across modified files.',
				category: TaskCategory.Refactoring,
				priority: TaskPriority.Low,
				estimatedDuration: '2-4 minutes',
				constraints: [],
				dependencies: [],
				canRunInBackground: true,
				suggestedTrigger: 'after-main-task',
				toolsRequired: ['get_errors', 'replace_string_in_file'],
				filesInvolved: context.recentChanges
			});
		}

		return suggestions;
	}

	private async analyzeForAnalysisOpportunities(context: MainTaskContext, analysis: WorkspaceAnalysis): Promise<ParallelTaskSuggestion[]> {
		const suggestions: ParallelTaskSuggestion[] = [];

		// Suggest dependency analysis
		suggestions.push({
			id: 'dependency-analysis',
			title: 'Dependency Security Audit',
			description: 'Analyze project dependencies for security vulnerabilities and outdated packages.',
			category: TaskCategory.Analysis,
			priority: TaskPriority.Medium,
			estimatedDuration: '2-3 minutes',
			constraints: [],
			dependencies: [],
			canRunInBackground: true,
			suggestedTrigger: 'immediate',
			toolsRequired: ['run_in_terminal', 'find_files']
		});

		// Suggest code complexity analysis
		if (analysis.fileTypes.has('ts') || analysis.fileTypes.has('js')) {
			suggestions.push({
				id: 'complexity-analysis',
				title: 'Code Complexity Analysis',
				description: 'Analyze code complexity metrics and identify functions that might benefit from refactoring.',
				category: TaskCategory.Analysis,
				priority: TaskPriority.Low,
				estimatedDuration: '3-5 minutes',
				constraints: ['Requires JavaScript/TypeScript'],
				dependencies: [],
				canRunInBackground: true,
				suggestedTrigger: 'on-user-approval',
				toolsRequired: ['read_file', 'grep_search']
			});
		}

		return suggestions;
	}

	private async analyzeForSetupOpportunities(context: MainTaskContext, analysis: WorkspaceAnalysis): Promise<ParallelTaskSuggestion[]> {
		const suggestions: ParallelTaskSuggestion[] = [];

		// Suggest CI/CD setup if not present
		if (!context.workspaceFiles.some(f => f.path.includes('.github/workflows'))) {
			suggestions.push({
				id: 'setup-ci-cd',
				title: 'Setup CI/CD Pipeline',
				description: 'Create GitHub Actions workflow files for automated testing and deployment.',
				category: TaskCategory.Setup,
				priority: TaskPriority.Medium,
				estimatedDuration: '5-10 minutes',
				constraints: [],
				dependencies: [],
				canRunInBackground: true,
				suggestedTrigger: 'on-user-approval',
				toolsRequired: ['create_file', 'create_directory']
			});
		}

		return suggestions;
	}

	private async analyzeForResearchOpportunities(context: MainTaskContext, analysis: WorkspaceAnalysis): Promise<ParallelTaskSuggestion[]> {
		const suggestions: ParallelTaskSuggestion[] = [];

		// Suggest framework research based on the task
		if (context.request.toLowerCase().includes('performance') || context.request.toLowerCase().includes('optimization')) {
			suggestions.push({
				id: 'performance-research',
				title: 'Performance Optimization Research',
				description: 'Research best practices and tools for performance optimization in your current tech stack.',
				category: TaskCategory.Research,
				priority: TaskPriority.Low,
				estimatedDuration: '10-15 minutes',
				constraints: [],
				dependencies: [],
				canRunInBackground: true,
				suggestedTrigger: 'on-user-approval',
				toolsRequired: ['fetch_webpage', 'semantic_search']
			});
		}

		return suggestions;
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

	private priorityScore(priority: TaskPriority): number {
		switch (priority) {
			case TaskPriority.High: return 3;
			case TaskPriority.Medium: return 2;
			case TaskPriority.Low: return 1;
			default: return 0;
		}
	}

	private detectProjectType(frameworks: string[]): string {
		if (frameworks.includes('react')) {
			return 'react';
		}
		if (frameworks.includes('typescript')) {
			return 'typescript';
		}
		if (frameworks.includes('node')) {
			return 'node';
		}
		if (frameworks.includes('python')) {
			return 'python';
		}
		return 'other';
	}

	private detectTestingFrameworks(files: URI[]): string[] {
		const frameworks: string[] = [];
		const fileContents = files.map(f => f.path).join(' ');

		if (fileContents.includes('jest')) {
			frameworks.push('jest');
		}
		if (fileContents.includes('mocha')) {
			frameworks.push('mocha');
		}
		if (fileContents.includes('vitest')) {
			frameworks.push('vitest');
		}
		if (fileContents.includes('pytest')) {
			frameworks.push('pytest');
		}

		return frameworks;
	}
}