/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { IWorkspaceService } from '../../../../platform/workspace/common/workspaceService';
import { URI } from '../../../../util/vs/base/common/uri';
import { LanguageModelTextPart, LanguageModelToolResult } from '../../../../vscodeTypes';
import { ToolName } from '../../../tools/common/toolNames';
import { ICopilotTool, ToolRegistry } from '../../../tools/common/toolsRegistry';
import { IParallelTaskService } from './parallelTaskService';

// Import types directly - inline definitions until module resolution is fixed
interface MainTaskContext {
	request: string;
	workspaceFiles: URI[];
	openFiles: URI[];
	selectedFiles: URI[];
	projectType?: string;
	frameworksUsed: string[];
	recentChanges: URI[];
}

interface ParallelTaskSuggestion {
	id: string;
	title: string;
	description: string;
	category: TaskCategory;
	priority: TaskPriority;
	estimatedDuration: string;
	constraints: string[];
	dependencies: string[];
	canRunInBackground: boolean;
	suggestedTrigger: 'immediate' | 'after-main-task' | 'on-user-approval';
	toolsRequired?: string[];
	filesInvolved?: URI[];
}

enum TaskCategory {
	Testing = 'testing',
	Documentation = 'documentation',
	Refactoring = 'refactoring',
	Analysis = 'analysis',
	Setup = 'setup',
	Research = 'research',
	CodeGeneration = 'codeGeneration'
}

enum TaskPriority {
	High = 'high',
	Medium = 'medium',
	Low = 'low'
}

interface IParallelTaskSuggestToolParams {
	mainTaskDescription: string;
	workspaceType?: 'typescript' | 'javascript' | 'react' | 'node' | 'python' | 'java' | 'csharp' | 'other';
	includeCategories?: Array<'testing' | 'documentation' | 'refactoring' | 'analysis' | 'setup' | 'research' | 'codeGeneration'>;
	maxSuggestions?: number;
}

export class ParallelTaskSuggestTool implements ICopilotTool<IParallelTaskSuggestToolParams> {
	public static readonly toolName = ToolName.SuggestParallelTasks;

	constructor(
		@IParallelTaskService private readonly parallelTaskService: IParallelTaskService,
		@IWorkspaceService private readonly workspaceService: IWorkspaceService,
	) { }

	async invoke(options: vscode.LanguageModelToolInvocationOptions<IParallelTaskSuggestToolParams>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
		const args = options.input;

		if (!args.mainTaskDescription) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart('Error: mainTaskDescription is required to suggest parallel tasks.')
			]);
		}

		try {
			// Build context for task analysis
			const context = await this.buildMainTaskContext(args.mainTaskDescription, args.workspaceType);

			// Generate suggestions
			const suggestions = await this.parallelTaskService.generateSuggestions(context);

			// Filter by requested categories if specified
			let filteredSuggestions = suggestions;
			if (args.includeCategories && args.includeCategories.length > 0) {
				filteredSuggestions = suggestions.filter((s: ParallelTaskSuggestion) =>
					args.includeCategories!.includes(s.category as any)
				);
			}

			// Limit number of suggestions
			const maxSuggestions = args.maxSuggestions || 5;
			const limitedSuggestions = filteredSuggestions.slice(0, maxSuggestions);

			if (limitedSuggestions.length === 0) {
				return new LanguageModelToolResult([
					new LanguageModelTextPart('No parallel tasks could be identified for the current context. This might be because:\n' +
						'- The main task is too simple or specific\n' +
						'- The workspace doesn\'t have enough files to suggest meaningful parallel work\n' +
						'- The requested task categories don\'t apply to this type of work')
				]);
			}

			// Format the response with both text and command buttons
			const textResponse = this.formatSuggestions(limitedSuggestions);
			const buttonCommands = this.createCommandButtons(limitedSuggestions);

			// Return both text and structured data for button rendering
			const result = new LanguageModelToolResult([
				new LanguageModelTextPart(textResponse + '\n\n' + buttonCommands)
			]);

			return result;

		} catch (error) {
			return new LanguageModelToolResult([
				new LanguageModelTextPart(`Error generating parallel task suggestions: ${error instanceof Error ? error.message : String(error)}`)
			]);
		}
	}

	private async buildMainTaskContext(mainTaskDescription: string, workspaceType?: string): Promise<MainTaskContext> {
		// Get real workspace files
		const workspaceFolders = this.workspaceService.getWorkspaceFolders();
		const workspaceFiles: URI[] = [];

		// Get open files (simplified since we can't use tabs service)
		const openFiles: URI[] = [];
		try {
			// Would get from tabs service in real implementation
			// For now, use text documents from workspace service
			for (const doc of this.workspaceService.textDocuments) {
				openFiles.push(URI.from(doc.uri));
			}
		} catch (error) {
			// Fallback if not available
			console.warn('Could not get open files:', error);
		}

		// Get selected files (currently open or recently modified)
		const selectedFiles: URI[] = [...openFiles];

		// Detect frameworks based on workspace content
		const frameworksUsed = this.detectFrameworks(workspaceFolders);
		if (workspaceType && !frameworksUsed.includes(workspaceType)) {
			frameworksUsed.push(workspaceType);
		}

		// Get recent changes (for now, use selected files)
		const recentChanges = selectedFiles;

		return {
			request: mainTaskDescription,
			workspaceFiles,
			openFiles,
			selectedFiles,
			projectType: workspaceType || this.detectProjectType(frameworksUsed),
			frameworksUsed,
			recentChanges
		};
	} private formatSuggestions(suggestions: readonly ParallelTaskSuggestion[]): string {
		const lines: string[] = [
			'## Parallel Task Suggestions',
			'',
			'The following tasks can be executed in parallel while you work on the main task:',
			''
		];

		suggestions.forEach((suggestion, index) => {
			const priorityIcon = this.getPriorityIcon(suggestion.priority);
			const categoryBadge = this.getCategoryBadge(suggestion.category);
			const backgroundIcon = suggestion.canRunInBackground ? '🔄' : '⚪';
			const triggerIcon = this.getTriggerIcon(suggestion.suggestedTrigger);

			lines.push(`### ${index + 1}. ${suggestion.title} ${priorityIcon} ${backgroundIcon}`);
			lines.push(`**Category:** ${categoryBadge} | **Duration:** ${suggestion.estimatedDuration}`);
			lines.push(`**Background:** ${suggestion.canRunInBackground ? 'Yes' : 'No'} | **Trigger:** ${triggerIcon} ${suggestion.suggestedTrigger}`);
			lines.push('');
			lines.push(suggestion.description);
			lines.push('');

			if (suggestion.constraints.length > 0) {
				lines.push('**Constraints:**');
				suggestion.constraints.forEach((constraint: string) => {
					lines.push(`- ${constraint}`);
				});
				lines.push('');
			}

			if (suggestion.dependencies.length > 0) {
				lines.push(`**Dependencies:** ${suggestion.dependencies.join(', ')}`);
				lines.push('');
			}

			if (suggestion.filesInvolved && suggestion.filesInvolved.length > 0) {
				lines.push(`**Files involved:** ${suggestion.filesInvolved.length} file(s)`);
				lines.push('');
			}

			lines.push('---');
			lines.push('');
		});

		// Add execution guidance
		const backgroundTasks = suggestions.filter(s => s.canRunInBackground);
		const immediateTasks = backgroundTasks.filter(s => s.suggestedTrigger === 'immediate');

		lines.push('');
		lines.push('## Execution Options');
		lines.push('');

		if (immediateTasks.length > 0) {
			lines.push(`🚀 **${immediateTasks.length} task(s) can start immediately** while you work on the main task.`);
			lines.push('');
		}

		if (backgroundTasks.length > 0) {
			lines.push(`🔄 **${backgroundTasks.length} task(s) can run in background** with minimal interruption.`);
			lines.push('');
			lines.push('To execute background tasks, you can:');
			lines.push('1. Use the `execute_background_tasks` tool with these suggestions');
			lines.push('2. Choose execution mode: `immediate`, `queued`, or `user-approval`');
			lines.push('3. Monitor progress and get notified when tasks complete');
			lines.push('');
		}

		lines.push('💡 **Tip:** These tasks are designed to work independently and complement your main work.');
		lines.push('Would you like me to execute any of these parallel tasks automatically?');

		return lines.join('\n');
	}

	private createCommandButtons(suggestions: readonly ParallelTaskSuggestion[]): string {
		// Create a simple markdown format with button hints that the agent can interpret
		const lines: string[] = [
			'',
			'## Quick Actions',
			'',
			'**Execute Individual Tasks:**',
			''
		];

		// Group tasks by category
		const tasksByCategory = new Map<string, ParallelTaskSuggestion[]>();
		for (const suggestion of suggestions) {
			if (!tasksByCategory.has(suggestion.category)) {
				tasksByCategory.set(suggestion.category, []);
			}
			tasksByCategory.get(suggestion.category)!.push(suggestion);
		}

		// Create buttons organized by category
		for (const [category, tasks] of tasksByCategory) {
			lines.push(`**${category}:**`);
			for (const task of tasks) {
				const priorityIcon = this.getPriorityIcon(task.priority);
				const backgroundIcon = task.canRunInBackground ? '🔄' : '⚪';

				// Create a button-style markdown with embedded command data
				lines.push(`- 🎯 **${task.title}** ${priorityIcon} ${backgroundIcon} *(${task.estimatedDuration})*`);
				lines.push(`  \`[Execute Task]\` → *${task.description.substring(0, 80)}...*`);

				// Hidden data for potential button creation (the agent could parse this)
				lines.push(`  <!-- BUTTON_DATA: ${JSON.stringify({
					title: `Execute: ${task.title}`,
					command: 'github.copilot.executeParallelTask',
					arguments: [{
						title: task.title,
						description: task.description,
						category: task.category,
						priority: task.priority,
						canRunInBackground: task.canRunInBackground,
						estimatedDuration: task.estimatedDuration
					}]
				})} -->`);
			}
			lines.push('');
		}

		lines.push('💡 *Use the Execute Background Tasks tool to run multiple selected tasks in parallel.*');
		lines.push('');

		return lines.join('\n');
	}

	private getPriorityIcon(priority: TaskPriority): string {
		switch (priority) {
			case TaskPriority.High: return '🔴';
			case TaskPriority.Medium: return '🟡';
			case TaskPriority.Low: return '🟢';
			default: return '';
		}
	}

	private getCategoryBadge(category: TaskCategory): string {
		switch (category) {
			case TaskCategory.Testing: return '🧪 Testing';
			case TaskCategory.Documentation: return '📚 Documentation';
			case TaskCategory.Refactoring: return '🔧 Refactoring';
			case TaskCategory.Analysis: return '🔍 Analysis';
			case TaskCategory.Setup: return '⚙️ Setup';
			case TaskCategory.Research: return '🔬 Research';
			case TaskCategory.CodeGeneration: return '💻 Code Generation';
			default: return category;
		}
	}

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<IParallelTaskSuggestToolParams>, token: vscode.CancellationToken): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: 'Analyzing task for parallel work opportunities...'
		};
	}

	private getTriggerIcon(trigger: string): string {
		switch (trigger) {
			case 'immediate': return '⚡';
			case 'after-main-task': return '⏳';
			case 'on-user-approval': return '👋';
			default: return '📋';
		}
	}

	private detectFrameworks(workspaceFolders: URI[]): string[] {
		const frameworks: string[] = [];
		// Simple framework detection based on folder structure
		// In a real implementation, this would analyze actual files
		return frameworks;
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
		return 'other';
	}
}

// Register the tool with the tool registry
ToolRegistry.registerTool(ParallelTaskSuggestTool);