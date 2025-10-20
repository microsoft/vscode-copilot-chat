/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { URI } from '../../../../util/vs/base/common/uri';
import { Location, Position, Range } from '../../../../vscodeTypes';
import { CopilotCLIChatSessionParticipant } from '../copilotCLIChatSessionsContribution';

describe('CopilotCLIChatSessionParticipant', () => {
	describe('resolvePrompt', () => {
		it('returns original prompt when no references', () => {
			const participant = createParticipant();
			const request = createMockRequest('Hello world', []);

			// Access the private method via reflection for testing
			const result = (participant as any).resolvePrompt(request);

			expect(result).toBe('Hello world');
		});

		it('returns original prompt when prompt starts with slash command', () => {
			const participant = createParticipant();
			const request = createMockRequest('/fix this code', []);

			const result = (participant as any).resolvePrompt(request);

			expect(result).toBe('/fix this code');
		});

		it('returns original prompt with explicit file references (no reminder tag)', () => {
			const participant = createParticipant();
			const fileUri = URI.file('/path/to/file.ts');
			const references: vscode.ChatPromptReference[] = [
				{
					id: 'vscode.file',
					name: 'file',
					value: fileUri,
					range: [0, 10]
				}
			];
			const request = createMockRequest('#file.ts explain this', references);

			const result = (participant as any).resolvePrompt(request);

			// Should return original prompt without modification
			expect(result).toBe('#file.ts explain this');
			// Should NOT contain <reminder> tag
			expect(result).not.toContain('<reminder>');
		});

		it('returns original prompt with location references (no reminder tag)', () => {
			const participant = createParticipant();
			const location = new Location(
				URI.file('/path/to/file.ts'),
				new Range(new Position(10, 0), new Position(10, 10))
			);
			const references: vscode.ChatPromptReference[] = [
				{
					id: 'vscode.location',
					name: 'file',
					value: location,
					range: [0, 15]
				}
			];
			const request = createMockRequest('#file.ts:10 what is this', references);

			const result = (participant as any).resolvePrompt(request);

			// Should return original prompt without modification
			expect(result).toBe('#file.ts:10 what is this');
			// Should NOT contain <reminder> tag
			expect(result).not.toContain('<reminder>');
		});

		it('returns original prompt when references include implicit references', () => {
			const participant = createParticipant();
			const fileUri = URI.file('/path/to/file.ts');
			const references: vscode.ChatPromptReference[] = [
				// Implicit reference (should be filtered out)
				{
					id: 'vscode.prompt.instructions.root',
					name: 'instructions',
					value: { type: 'string', value: 'some instructions' },
					range: undefined
				},
				// Explicit reference
				{
					id: 'vscode.file',
					name: 'file',
					value: fileUri,
					range: [0, 10]
				}
			];
			const request = createMockRequest('#file.ts check this', references);

			const result = (participant as any).resolvePrompt(request);

			// Should return original prompt without modification
			expect(result).toBe('#file.ts check this');
			// Should NOT contain <reminder> tag even though there are explicit references
			expect(result).not.toContain('<reminder>');
			// Should NOT contain prompt instructions
			expect(result).not.toContain('instructions');
		});

		it('returns original prompt with multiple explicit references (no reminder tag)', () => {
			const participant = createParticipant();
			const references: vscode.ChatPromptReference[] = [
				{
					id: 'vscode.file',
					name: 'file1',
					value: URI.file('/path/to/file1.ts'),
					range: [0, 10]
				},
				{
					id: 'vscode.file',
					name: 'file2',
					value: URI.file('/path/to/file2.ts'),
					range: [11, 21]
				}
			];
			const request = createMockRequest('#file1.ts #file2.ts compare these', references);

			const result = (participant as any).resolvePrompt(request);

			// Should return original prompt without modification
			expect(result).toBe('#file1.ts #file2.ts compare these');
			// Should NOT contain <reminder> tag
			expect(result).not.toContain('<reminder>');
		});

		it('filters out only implicit references with vscode.prompt.instructions prefix', () => {
			const participant = createParticipant();
			const references: vscode.ChatPromptReference[] = [
				{
					id: 'vscode.prompt.instructions.root',
					name: 'instructions',
					value: { type: 'string', value: 'instructions 1' },
					range: undefined
				},
				{
					id: 'vscode.prompt.instructions.child',
					name: 'instructions',
					value: { type: 'string', value: 'instructions 2' },
					range: undefined
				},
				{
					id: 'vscode.file',
					name: 'file',
					value: URI.file('/path/to/file.ts'),
					range: [0, 10]
				},
				{
					id: 'vscode.prompt.file',
					name: 'prompt',
					value: URI.file('/path/to/prompt.md'),
					range: [11, 25]
				}
			];
			const request = createMockRequest('#file.ts #prompt.md use these', references);

			const result = (participant as any).resolvePrompt(request);

			// Should return original prompt
			expect(result).toBe('#file.ts #prompt.md use these');
			// Should NOT contain any reminder or instructions
			expect(result).not.toContain('<reminder>');
			expect(result).not.toContain('instructions');
		});
	});
});

// Helper functions
function createParticipant(): CopilotCLIChatSessionParticipant {
	// Create a minimal participant instance for testing
	const mockAgentManager = {} as any;
	const mockSessionService = {} as any;
	const mockSessionItemProvider = {} as any;
	return new CopilotCLIChatSessionParticipant(
		'copilot-cli',
		mockAgentManager,
		mockSessionService,
		mockSessionItemProvider
	);
}

function createMockRequest(
	prompt: string,
	references: vscode.ChatPromptReference[]
): vscode.ChatRequest {
	return {
		prompt,
		command: undefined,
		references,
		location: 1, // ChatLocation.Panel
		attempt: 0,
		enableCommandDetection: true,
		isParticipantDetected: false,
		toolReferences: [],
		toolInvocationToken: null as any,
		model: undefined,
		tools: [],
		id: 'test-id',
		sessionId: 'test-session-id',
		location2: undefined
	} as any;
}
