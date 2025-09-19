/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../util/vs/base/common/uri';

export interface MainTaskContext {
	request: string;
	workspaceFiles: URI[];
	openFiles: URI[];
	selectedFiles: URI[];
	projectType?: string;
	frameworksUsed: string[];
	recentChanges: URI[];
}

export interface ParallelTaskSuggestion {
	id: string;
	title: string;
	description: string;
	category?: string; // Made optional and flexible - model can define any category
	priority: 'high' | 'medium' | 'low'; // Simplified to string literals
	estimatedDuration: string;
	constraints: string[];
	dependencies: string[];
	canRunInBackground: boolean;
	suggestedTrigger: 'immediate' | 'after-main-task' | 'on-user-approval';
	toolsRequired?: string[];
	filesInvolved?: URI[];
	// New fields for model-driven approach
	reasoning?: string; // Why this task was suggested
	expectedOutcome?: string; // What the task should achieve
}

export interface BackgroundTaskExecution {
	id: string;
	suggestion: ParallelTaskSuggestion;
	status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
	startTime?: number;
	endTime?: number;
	result?: string;
	error?: string;
	progress?: number;
}

// Remove hardcoded enums - let the model decide categories and priorities
// export enum TaskCategory - REMOVED
// export enum TaskPriority - REMOVED

export interface TaskOpportunity {
	triggerCondition: string;
	confidence: number;
	reason: string;
	suggestion: ParallelTaskSuggestion;
}

export interface WorkspaceAnalysis {
	projectType: string;
	frameworks: string[];
	testingFrameworks: string[];
	hasTests: boolean;
	hasDocumentation: boolean;
	codeQualityIssues: string[];
	dependencies: string[];
	fileTypes: Map<string, number>;
}