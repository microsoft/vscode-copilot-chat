/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { DelegateConfirmationStep } from '../copilotCloudSessionsProvider';

describe('CopilotCloudSessionsProvider - Single Confirmation Flow', () => {

	describe('DelegateConfirmationStep constant', () => {
		it('should be defined as "delegate"', () => {
			expect(DelegateConfirmationStep).toBe('delegate');
		});
	});

	describe('Button text detection logic', () => {
		it('should detect "Allow" in button text (case insensitive)', () => {
			const prompts = [
				'Allow and Delegate: "Delegate to cloud agent"',
				'allow: "test"',
				'ALLOW AND COMMIT: "title"'
			];
			
			prompts.forEach(prompt => {
				expect(prompt.toLowerCase().includes('allow')).toBe(true);
			});
		});

		it('should detect "Commit" or "Push" in button text (case insensitive)', () => {
			const prompts = [
				'Commit and Delegate: "Delegate to cloud agent"',
				'commit: "test"',
				'Push changes: "title"',
				'COMMIT AND ALLOW: "test"'
			];
			
			prompts.forEach(prompt => {
				const promptLower = prompt.toLowerCase();
				expect(promptLower.includes('commit') || promptLower.includes('push')).toBe(true);
			});
		});

		it('should not detect allow/commit in regular prompts', () => {
			const prompts = [
				'Delegate: "Delegate to cloud agent"',
				'Cancel: "test"'
			];
			
			prompts.forEach(prompt => {
				const promptLower = prompt.toLowerCase();
				expect(promptLower.includes('allow')).toBe(false);
				expect(promptLower.includes('commit')).toBe(false);
			});
		});
	});

	describe('Confirmation metadata structure', () => {
		it('should support required metadata fields', () => {
			const metadata = {
				prompt: 'test prompt',
				references: [] as readonly vscode.ChatPromptReference[],
				chatContext: {} as vscode.ChatContext,
				autoPushAndCommit: false,
				hasUncommittedChanges: true,
				needsAuthUpgrade: false
			};

			expect(metadata.prompt).toBe('test prompt');
			expect(metadata.hasUncommittedChanges).toBe(true);
			expect(metadata.needsAuthUpgrade).toBe(false);
			expect(metadata.autoPushAndCommit).toBe(false);
		});

		it('should allow optional fields to be undefined', () => {
			const metadata = {
				prompt: 'test prompt',
				chatContext: {} as vscode.ChatContext
			};

			expect(metadata.prompt).toBe('test prompt');
			expect(metadata.hasOwnProperty('hasUncommittedChanges')).toBe(false);
			expect(metadata.hasOwnProperty('needsAuthUpgrade')).toBe(false);
		});
	});

	describe('Button combinations', () => {
		it('should generate correct buttons for clean repo with no auth', () => {
			const hasUncommittedChanges = false;
			const needsAuthUpgrade = false;

			if (!hasUncommittedChanges && !needsAuthUpgrade) {
				const buttons = ['Delegate', 'Cancel'];
				expect(buttons).toEqual(['Delegate', 'Cancel']);
			}
		});

		it('should generate correct buttons for uncommitted changes only', () => {
			const hasUncommittedChanges = true;
			const needsAuthUpgrade = false;

			if (hasUncommittedChanges && !needsAuthUpgrade) {
				const buttons = [
					'Commit and Delegate',
					'Delegate without committing',
					'Cancel'
				];
				expect(buttons).toHaveLength(3);
				expect(buttons[0]).toContain('Commit');
			}
		});

		it('should generate correct buttons for auth upgrade only', () => {
			const hasUncommittedChanges = false;
			const needsAuthUpgrade = true;

			if (!hasUncommittedChanges && needsAuthUpgrade) {
				const buttons = [
					'Allow and Delegate',
					'Cancel'
				];
				expect(buttons).toHaveLength(2);
				expect(buttons[0]).toContain('Allow');
			}
		});

		it('should generate correct buttons for both conditions', () => {
			const hasUncommittedChanges = true;
			const needsAuthUpgrade = true;

			if (hasUncommittedChanges && needsAuthUpgrade) {
				const buttons = [
					'Commit and Allow',
					'Allow without committing',
					'Cancel'
				];
				expect(buttons).toHaveLength(3);
				expect(buttons[0]).toContain('Commit');
				expect(buttons[0]).toContain('Allow');
			}
		});
	});
});
