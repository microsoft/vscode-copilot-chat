/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../../util/common/services';
import { ParallelTaskSuggestion } from '../common/types';

export const ITaskOpportunityDetector = createServiceIdentifier<ITaskOpportunityDetector>('ITaskOpportunityDetector');

export interface ITaskOpportunityDetector {
	readonly _serviceBrand: undefined;

	getRelevantSuggestions(suggestions: ParallelTaskSuggestion[], mainTask: string): ParallelTaskSuggestion[];
}

export class TaskOpportunityDetector implements ITaskOpportunityDetector {
	declare readonly _serviceBrand: undefined;

	constructor(
	) { }

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

	private calculateRelevanceScore(suggestion: ParallelTaskSuggestion, mainTask: string): number {
		let score = 0;

		// Priority contributes to relevance
		switch (suggestion.priority) {
			case 'high': score += 30; break;
			case 'medium': score += 20; break;
			case 'low': score += 10; break;
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

	private countKeywordMatches(suggestion: ParallelTaskSuggestion, mainTask: string): number {
		const taskKeywords = this.extractKeywords(mainTask.toLowerCase());
		const suggestionText = (suggestion.title + ' ' + suggestion.description).toLowerCase();

		return taskKeywords.filter(keyword => suggestionText.includes(keyword)).length;
	}
}