/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { createServiceIdentifier } from '../../../../util/common/services';
import { URI } from '../../../../util/vs/base/common/uri';
import { MainTaskContext, ParallelTaskSuggestion, TaskOpportunity, TaskPriority } from '../common/types';
import { IParallelTaskService } from './parallelTaskService';

export const ITaskOpportunityDetector = createServiceIdentifier<ITaskOpportunityDetector>('ITaskOpportunityDetector');

export interface ITaskOpportunityDetector {
	readonly _serviceBrand: undefined;

	detectOpportunitiesDuringExecution(
		mainTask: string,
		workspaceChanges: URI[],
		currentTools: vscode.LanguageModelToolInformation[]
	): Promise<TaskOpportunity[]>;

	shouldSuggestBackgroundTasks(context: MainTaskContext): Promise<boolean>;
	getRelevantSuggestions(suggestions: ParallelTaskSuggestion[], mainTask: string): ParallelTaskSuggestion[];
}

export class TaskOpportunityDetector implements ITaskOpportunityDetector {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IParallelTaskService private readonly parallelTaskService: IParallelTaskService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

	async detectOpportunitiesDuringExecution(
		mainTask: string,
		workspaceChanges: URI[],
		currentTools: vscode.LanguageModelToolInformation[]
	): Promise<TaskOpportunity[]> {
		const context: MainTaskContext = {
			request: mainTask,
			workspaceFiles: await this.getWorkspaceFiles(),
			openFiles: await this.getOpenFiles(),
			selectedFiles: workspaceChanges,
			frameworksUsed: await this.detectFrameworks(),
			recentChanges: workspaceChanges
		};

		const suggestions = await this.parallelTaskService.generateSuggestions(context);

		// Filter for high-value background tasks
		const relevantSuggestions = suggestions.filter(s =>
			s.canRunInBackground &&
			s.priority !== TaskPriority.Low &&
			this.isRelevantToCurrentWork(s, mainTask)
		);

		// Convert to opportunities with confidence scores
		return relevantSuggestions.map(suggestion => ({
			triggerCondition: this.determineTriggerCondition(suggestion, mainTask, currentTools),
			confidence: this.calculateConfidence(suggestion, context),
			reason: this.generateReason(suggestion, mainTask),
			suggestion
		}));
	}

	async shouldSuggestBackgroundTasks(context: MainTaskContext): Promise<boolean> {
		// Suggest background tasks if:
		// 1. The main task is complex (longer description)
		// 2. Multiple files are involved
		// 3. The workspace has sufficient content for parallel work

		const taskComplexity = context.request.split(' ').length > 5;
		const multipleFiles = context.selectedFiles.length > 1;
		const sufficientWorkspace = context.workspaceFiles.length > 10;

		return taskComplexity || multipleFiles || sufficientWorkspace;
	}

	getRelevantSuggestions(suggestions: ParallelTaskSuggestion[], mainTask: string): ParallelTaskSuggestion[] {
		return suggestions
			.filter(s => this.isRelevantToCurrentWork(s, mainTask))
			.sort((a, b) => this.calculateRelevanceScore(b, mainTask) - this.calculateRelevanceScore(a, mainTask))
			.slice(0, 5); // Top 5 most relevant
	}

	private isRelevantToCurrentWork(suggestion: ParallelTaskSuggestion, mainTask: string): boolean {
		const taskKeywords = this.extractKeywords(mainTask.toLowerCase());
		const suggestionText = (suggestion.title + ' ' + suggestion.description).toLowerCase();

		// Check for keyword overlap
		const keywordMatch = taskKeywords.some(keyword =>
			suggestionText.includes(keyword) ||
			suggestion.dependencies.some(dep => dep.toLowerCase().includes(keyword))
		);

		// Check for contextual relevance
		const contextualMatch = this.checkContextualRelevance(suggestion, mainTask);

		return keywordMatch || contextualMatch;
	}

	private determineTriggerCondition(
		suggestion: ParallelTaskSuggestion,
		mainTask: string,
		currentTools: vscode.LanguageModelToolInformation[]
	): string {
		// Analyze what triggers should activate this suggestion
		if (suggestion.category === 'testing' && this.isImplementationTask(mainTask)) {
			return 'after_code_creation';
		}

		if (suggestion.category === 'documentation' && this.hasFileCreationTools(currentTools)) {
			return 'after_file_modification';
		}

		if (suggestion.category === 'analysis' && suggestion.canRunInBackground) {
			return 'immediate';
		}

		return 'on_task_completion';
	}

	private calculateConfidence(suggestion: ParallelTaskSuggestion, context: MainTaskContext): number {
		let confidence = 0.5; // Base confidence

		// Increase confidence based on various factors
		if (suggestion.canRunInBackground) {
			confidence += 0.2;
		}

		if (suggestion.priority === TaskPriority.High) {
			confidence += 0.2;
		}

		if (suggestion.filesInvolved && suggestion.filesInvolved.length > 0) {
			confidence += 0.1;
		}

		// Contextual relevance
		if (this.isContextuallyRelevant(suggestion, context)) {
			confidence += 0.2;
		}

		return Math.min(confidence, 1.0);
	}

	private generateReason(suggestion: ParallelTaskSuggestion, mainTask: string): string {
		const taskType = this.getTaskType(mainTask);

		switch (suggestion.category) {
			case 'testing':
				return `Testing can be generated in parallel while you focus on ${taskType}`;
			case 'documentation':
				return `Documentation can be updated based on the changes you're making`;
			case 'analysis':
				return `Code analysis can run in the background to identify potential issues`;
			case 'refactoring':
				return `Code cleanup can be performed after your main changes are complete`;
			default:
				return `This task complements your main work and can run independently`;
		}
	}

	private calculateRelevanceScore(suggestion: ParallelTaskSuggestion, mainTask: string): number {
		let score = 0;

		// Priority contributes to relevance
		switch (suggestion.priority) {
			case TaskPriority.High: score += 30; break;
			case TaskPriority.Medium: score += 20; break;
			case TaskPriority.Low: score += 10; break;
		}

		// Background capability increases relevance
		if (suggestion.canRunInBackground) {
			score += 20;
		}

		// Keyword matching
		const keywordMatches = this.countKeywordMatches(suggestion, mainTask);
		score += keywordMatches * 5;

		return score;
	}

	private extractKeywords(text: string): string[] {
		// Extract meaningful keywords from the task description
		const commonWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
		return text
			.split(/\s+/)
			.filter(word => word.length > 2 && !commonWords.includes(word))
			.slice(0, 10); // Limit to first 10 keywords
	}

	private checkContextualRelevance(suggestion: ParallelTaskSuggestion, mainTask: string): boolean {
		// Check if the suggestion is contextually relevant even without keyword matches
		const taskLower = mainTask.toLowerCase();

		if (taskLower.includes('implement') || taskLower.includes('create') || taskLower.includes('add')) {
			return suggestion.category === 'testing' || suggestion.category === 'documentation';
		}

		if (taskLower.includes('fix') || taskLower.includes('debug') || taskLower.includes('error')) {
			return suggestion.category === 'analysis' || suggestion.category === 'testing';
		}

		if (taskLower.includes('refactor') || taskLower.includes('improve')) {
			return suggestion.category === 'refactoring' || suggestion.category === 'analysis';
		}

		return false;
	}

	private isImplementationTask(mainTask: string): boolean {
		const implementationKeywords = ['implement', 'create', 'build', 'develop', 'add', 'write'];
		return implementationKeywords.some(keyword => mainTask.toLowerCase().includes(keyword));
	}

	private hasFileCreationTools(tools: vscode.LanguageModelToolInformation[]): boolean {
		const fileTools = ['create_file', 'replace_string_in_file', 'multi_replace_string_in_file'];
		return tools.some(tool => fileTools.includes(tool.name));
	}

	private isContextuallyRelevant(suggestion: ParallelTaskSuggestion, context: MainTaskContext): boolean {
		// Check if suggestion makes sense in the current context
		if (suggestion.category === 'testing' && context.selectedFiles.some(f => f.path.endsWith('.test.ts'))) {
			return true;
		}

		if (suggestion.category === 'documentation' && context.recentChanges.length > 0) {
			return true;
		}

		return false;
	}

	private getTaskType(mainTask: string): string {
		if (this.isImplementationTask(mainTask)) {
			return 'implementation';
		}
		if (mainTask.toLowerCase().includes('fix')) {
			return 'bug fixing';
		}
		if (mainTask.toLowerCase().includes('refactor')) {
			return 'refactoring';
		}
		return 'development work';
	}

	private countKeywordMatches(suggestion: ParallelTaskSuggestion, mainTask: string): number {
		const taskKeywords = this.extractKeywords(mainTask.toLowerCase());
		const suggestionText = (suggestion.title + ' ' + suggestion.description).toLowerCase();

		return taskKeywords.filter(keyword => suggestionText.includes(keyword)).length;
	}

	private async getWorkspaceFiles(): Promise<URI[]> {
		// In a real implementation, this would scan the workspace
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		return workspaceFolders; // Simplified for now
	}

	private async getOpenFiles(): Promise<URI[]> {
		return this.workspaceService.textDocuments.map(doc => URI.from(doc.uri));
	}

	private async detectFrameworks(): Promise<string[]> {
		// Detect frameworks based on workspace content
		const frameworks: string[] = [];
		const textDocs = this.workspaceService.textDocuments;

		if (textDocs.some(doc => doc.uri.path.includes('package.json'))) {
			frameworks.push('node', 'javascript');
		}

		if (textDocs.some(doc => doc.uri.path.includes('tsconfig.json'))) {
			frameworks.push('typescript');
		}

		return frameworks;
	}
}