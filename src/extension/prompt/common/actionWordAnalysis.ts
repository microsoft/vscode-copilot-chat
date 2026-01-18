/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Action words that require full completion of tasks.
 * These words indicate the user wants a complete solution, not just analysis or partial steps.
 */
export const ACTION_WORDS = {
	// Implementation & Creation
	implement: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },
	create: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },
	build: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },
	add: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },
	make: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },
	generate: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },
	develop: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },
	setup: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },
	initialize: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },
	scaffold: { category: 'create', requiresVerification: true, requiresRootCauseFix: false },

	// Bug Fixing & Debugging
	fix: { category: 'fix', requiresVerification: true, requiresRootCauseFix: true },
	solve: { category: 'fix', requiresVerification: true, requiresRootCauseFix: true },
	debug: { category: 'fix', requiresVerification: true, requiresRootCauseFix: true },
	resolve: { category: 'fix', requiresVerification: true, requiresRootCauseFix: true },
	repair: { category: 'fix', requiresVerification: true, requiresRootCauseFix: true },
	correct: { category: 'fix', requiresVerification: true, requiresRootCauseFix: true },
	patch: { category: 'fix', requiresVerification: true, requiresRootCauseFix: true },

	// Modification & Refactoring
	refactor: { category: 'modify', requiresVerification: true, requiresRootCauseFix: false },
	update: { category: 'modify', requiresVerification: true, requiresRootCauseFix: false },
	modify: { category: 'modify', requiresVerification: true, requiresRootCauseFix: false },
	change: { category: 'modify', requiresVerification: true, requiresRootCauseFix: false },
	improve: { category: 'modify', requiresVerification: true, requiresRootCauseFix: false },
	optimize: { category: 'modify', requiresVerification: true, requiresRootCauseFix: false },
	enhance: { category: 'modify', requiresVerification: true, requiresRootCauseFix: false },
	rewrite: { category: 'modify', requiresVerification: true, requiresRootCauseFix: false },

	// Configuration & Setup
	configure: { category: 'configure', requiresVerification: true, requiresRootCauseFix: false },
	install: { category: 'configure', requiresVerification: true, requiresRootCauseFix: false },
	enable: { category: 'configure', requiresVerification: true, requiresRootCauseFix: false },
	disable: { category: 'configure', requiresVerification: true, requiresRootCauseFix: false },

	// Deletion (requires caution)
	delete: { category: 'delete', requiresVerification: true, requiresRootCauseFix: false },
	remove: { category: 'delete', requiresVerification: true, requiresRootCauseFix: false },
} as const;

export type ActionWord = keyof typeof ACTION_WORDS;
export type ActionCategory = 'create' | 'fix' | 'modify' | 'configure' | 'delete';

/**
 * Subject words that indicate what is being acted upon
 */
export const SUBJECT_WORDS = {
	// Code Components
	function: 'code',
	method: 'code',
	class: 'code',
	interface: 'code',
	type: 'code',
	variable: 'code',
	constant: 'code',
	component: 'code',
	module: 'code',
	service: 'code',
	api: 'code',
	endpoint: 'code',

	// Issues & Problems
	bug: 'issue',
	error: 'issue',
	issue: 'issue',
	problem: 'issue',
	warning: 'issue',
	exception: 'issue',
	crash: 'issue',
	failure: 'issue',

	// Features & Functionality
	feature: 'feature',
	functionality: 'feature',
	behavior: 'feature',
	capability: 'feature',

	// Files & Structure
	file: 'file',
	folder: 'file',
	directory: 'file',
	project: 'file',

	// Tests
	test: 'test',
	tests: 'test',
	'unit test': 'test',
	'integration test': 'test',
} as const;

export type SubjectWord = keyof typeof SUBJECT_WORDS;

/**
 * Analyzes a request to detect action words and extract goals
 */
export interface RequestAnalysis {
	/** Detected action words in the request */
	actionWords: Array<{ word: ActionWord; position: number }>;
	/** Detected subject words in the request */
	subjectWords: Array<{ word: SubjectWord; position: number }>;
	/** Whether the request requires verification after completion */
	requiresVerification: boolean;
	/** Whether the request requires root cause analysis (for bug fixes) */
	requiresRootCauseFix: boolean;
	/** Whether the request involves potentially destructive actions */
	requiresCaution: boolean;
	/** Extracted goal summary */
	goal: string;
	/** Category of the primary action */
	primaryCategory: ActionCategory | undefined;
}

/**
 * Analyzes a user request to detect action words and extract goals
 */
export function analyzeRequest(request: string): RequestAnalysis {
	const lowerRequest = request.toLowerCase();

	// Detect action words
	const actionWords: Array<{ word: ActionWord; position: number }> = [];
	for (const key of Object.keys(ACTION_WORDS)) {
		const actionWord = key as ActionWord;
		const regex = new RegExp(`\\b${actionWord}\\b`, 'gi');
		let match;
		while ((match = regex.exec(lowerRequest)) !== null) {
			actionWords.push({ word: actionWord, position: match.index });
		}
	}

	// Detect subject words
	const subjectWords: Array<{ word: SubjectWord; position: number }> = [];
	for (const key of Object.keys(SUBJECT_WORDS)) {
		const subjectWord = key as SubjectWord;
		const regex = new RegExp(`\\b${subjectWord}\\b`, 'gi');
		let match;
		while ((match = regex.exec(lowerRequest)) !== null) {
			subjectWords.push({ word: subjectWord, position: match.index });
		}
	}

	// Sort by position
	actionWords.sort((a, b) => a.position - b.position);
	subjectWords.sort((a, b) => a.position - b.position);

	// Determine requirements
	let requiresVerification = false;
	let requiresRootCauseFix = false;
	let requiresCaution = false;
	let primaryCategory: ActionCategory | undefined;

	if (actionWords.length > 0) {
		const primaryAction = ACTION_WORDS[actionWords[0].word];
		primaryCategory = primaryAction.category;
		requiresVerification = primaryAction.requiresVerification;
		requiresRootCauseFix = primaryAction.requiresRootCauseFix;

		// Check if any action is in the delete category
		requiresCaution = actionWords.some(a => ACTION_WORDS[a.word].category === 'delete');

		// If multiple actions, combine requirements
		for (const action of actionWords) {
			const actionInfo = ACTION_WORDS[action.word];
			requiresVerification = requiresVerification || actionInfo.requiresVerification;
			requiresRootCauseFix = requiresRootCauseFix || actionInfo.requiresRootCauseFix;
		}
	}

	// Extract goal summary
	let goal = '';
	if (actionWords.length > 0 && subjectWords.length > 0) {
		const action = actionWords[0].word;
		const subject = subjectWords[0].word;
		goal = `${action} ${subject}`;
	} else if (actionWords.length > 0) {
		goal = actionWords[0].word;
	} else {
		// No specific action detected, use first sentence
		const firstSentence = request.split(/[.!?]/)[0];
		goal = firstSentence.substring(0, 100);
	}

	return {
		actionWords,
		subjectWords,
		requiresVerification,
		requiresRootCauseFix,
		requiresCaution,
		goal,
		primaryCategory,
	};
}

/**
 * Checks if a request should trigger full completion behavior
 */
export function shouldRequireFullCompletion(analysis: RequestAnalysis): boolean {
	// Require full completion if there are any action words
	return analysis.actionWords.length > 0;
}

/**
 * Gets a completion criteria description for the agent
 */
export function getCompletionCriteria(analysis: RequestAnalysis): string {
	const criteria: string[] = [];

	if (analysis.requiresRootCauseFix) {
		criteria.push('Identify the root cause of the issue');
		criteria.push('Fix the root cause, not just symptoms');
	}

	if (analysis.requiresVerification) {
		criteria.push('Verify the solution works correctly');
		criteria.push('Test that the symptom/issue no longer exists');
	}

	if (analysis.actionWords.length > 0) {
		criteria.push('Complete the full implementation');
		criteria.push('Do not stop at partial solutions or analysis');
	}

	if (analysis.requiresCaution) {
		criteria.push('Confirm destructive actions with the user');
	}

	return criteria.join('; ');
}
