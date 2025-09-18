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

export enum TaskCategory {
	Testing = 'testing',
	Documentation = 'documentation',
	Refactoring = 'refactoring',
	Analysis = 'analysis',
	Setup = 'setup',
	Research = 'research',
	CodeGeneration = 'codeGeneration'
}

export enum TaskPriority {
	High = 'high',
	Medium = 'medium',
	Low = 'low'
}

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