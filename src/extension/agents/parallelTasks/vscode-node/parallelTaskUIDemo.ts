/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Demo of how parallel task suggestions could be rendered as interactive buttons
 * This shows the UI pattern without the full parallel task infrastructure
 */

interface DemoParallelTask {
	id: string;
	title: string;
	description: string;
	category: 'Testing' | 'Documentation' | 'Security' | 'Setup' | 'Analysis';
	priority: 'High' | 'Medium' | 'Low';
	estimatedDuration: string;
	canRunInBackground: boolean;
}

// Demo data for authentication implementation
const DEMO_PARALLEL_TASKS: DemoParallelTask[] = [
	{
		id: 'setup-testing',
		title: 'Testing Framework Setup',
		description: 'Set up Jest and Supertest for API testing while implementing core auth features',
		category: 'Testing',
		priority: 'High',
		estimatedDuration: '10-15 min',
		canRunInBackground: true
	},
	{
		id: 'api-docs',
		title: 'API Documentation',
		description: 'Create comprehensive documentation for authentication endpoints',
		category: 'Documentation',
		priority: 'Medium',
		estimatedDuration: '15-20 min',
		canRunInBackground: true
	},
	{
		id: 'security-analysis',
		title: 'Security Analysis',
		description: 'Review and implement security best practices (rate limiting, CORS, helmet)',
		category: 'Security',
		priority: 'High',
		estimatedDuration: '20-25 min',
		canRunInBackground: false
	},
	{
		id: 'env-config',
		title: 'Environment Configuration',
		description: 'Set up environment variables and configuration management',
		category: 'Setup',
		priority: 'Medium',
		estimatedDuration: '8-10 min',
		canRunInBackground: true
	},
	{
		id: 'logging-setup',
		title: 'Logging Setup',
		description: 'Implement structured logging for authentication events',
		category: 'Setup',
		priority: 'Low',
		estimatedDuration: '12-15 min',
		canRunInBackground: true
	},
	{
		id: 'input-validation',
		title: 'Input Validation',
		description: 'Create comprehensive validation schemas for all auth endpoints',
		category: 'Security',
		priority: 'High',
		estimatedDuration: '15-18 min',
		canRunInBackground: false
	}
];

function createParallelTaskCommand(task: DemoParallelTask): vscode.Command {
	return {
		command: 'github.copilot.executeParallelTask',
		arguments: [task],
		title: `Execute: ${task.title}`,
		tooltip: `${task.description} (${task.estimatedDuration})`
	};
}

function getPriorityIcon(priority: string): string {
	switch (priority) {
		case 'High': return '🔴';
		case 'Medium': return '🟡';
		case 'Low': return '🟢';
		default: return '';
	}
}

function getCategoryIcon(category: string): string {
	switch (category) {
		case 'Testing': return '🧪';
		case 'Documentation': return '📚';
		case 'Security': return '🔒';
		case 'Setup': return '⚙️';
		case 'Analysis': return '📊';
		default: return '';
	}
}

/**
 * Demo function that shows how to render parallel task suggestions with interactive buttons
 */
export function renderParallelTasksDemo(stream: vscode.ChatResponseStream, mainTask: string = 'implement user authentication'): void {
	// Header
	stream.markdown('## Parallel Task Opportunities\n\n');
	stream.markdown(`I found **${DEMO_PARALLEL_TASKS.length} parallel task opportunities** for: *${mainTask}*\n\n`);

	// Group tasks by category
	const tasksByCategory = new Map<string, DemoParallelTask[]>();
	for (const task of DEMO_PARALLEL_TASKS) {
		if (!tasksByCategory.has(task.category)) {
			tasksByCategory.set(task.category, []);
		}
		tasksByCategory.get(task.category)!.push(task);
	}

	// Render each category
	for (const [category, tasks] of tasksByCategory) {
		const categoryIcon = getCategoryIcon(category);
		stream.markdown(`### ${categoryIcon} ${category}\n\n`);

		for (const task of tasks) {
			const priorityIcon = getPriorityIcon(task.priority);
			const backgroundIcon = task.canRunInBackground ? '🔄' : '⚪';

			// Task description
			stream.markdown(
				`**${task.title}** ${priorityIcon} ${backgroundIcon} *(${task.estimatedDuration})*\n` +
				`${task.description}\n\n`
			);

			// Interactive button for this task
			stream.button(createParallelTaskCommand(task));
			stream.markdown('\n');
		}
		stream.markdown('\n');
	}

	// Summary and actions
	stream.markdown('---\n\n');
	stream.markdown('### 🚀 Quick Actions\n\n');

	const backgroundTasks = DEMO_PARALLEL_TASKS.filter(t => t.canRunInBackground);
	const highPriorityTasks = DEMO_PARALLEL_TASKS.filter(t => t.priority === 'High');

	stream.markdown(
		`- **${backgroundTasks.length} tasks** can run in background while you work\n` +
		`- **${highPriorityTasks.length} high-priority tasks** should be started first\n` +
		`- Estimated total time: **60-90 minutes** if run sequentially\n\n`
	);

	// Bulk action buttons
	stream.button({
		command: 'github.copilot.executeAllBackgroundTasks',
		arguments: [backgroundTasks],
		title: '🔄 Execute All Background Tasks',
		tooltip: 'Start all tasks that can run in the background'
	});

	stream.button({
		command: 'github.copilot.executeHighPriorityTasks',
		arguments: [highPriorityTasks],
		title: '🔴 Execute High Priority Tasks',
		tooltip: 'Start all high-priority tasks first'
	});

	stream.markdown('\n\n💡 **Tip:** Click individual task buttons above or use bulk actions to execute multiple tasks in parallel.\n');
}

/**
 * Demo command for testing - this would be registered in the extension
 */
export function registerParallelTaskDemoCommand(): vscode.Disposable {
	return vscode.commands.registerCommand('github.copilot.demo.parallelTasks', () => {
		// This would be called by a chat participant to demonstrate the UI
		vscode.window.showInformationMessage('Parallel Tasks Demo - check chat interface for UI');
	});
}