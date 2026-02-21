/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { expandEditStrategy, getModelProfile, getModelProfileByFamily, type EditStrategy, type ResolvedModelProfile } from '../../common/modelProfiles';

/** Minimal mock endpoint for testing. */
function mockEndpoint(family: string, model?: string): IChatEndpoint {
	return {
		family,
		model: model ?? family,
	} as IChatEndpoint;
}

describe('ModelProfiles', () => {

	describe('getModelProfileByFamily - prefix matching', () => {

		it('matches GPT-5.1 as openai-modern with apply-patch', () => {
			const profile = getModelProfileByFamily('gpt-5.1');
			expect(profile.editStrategy).toBe('apply-patch');
			expect(profile.notebookFormat).toBe('json');
			expect(profile.verbosity).toBe('low');
		});

		it('matches GPT-5.3-codex as openai-modern with apply-patch', () => {
			const profile = getModelProfileByFamily('gpt-5.3-codex');
			expect(profile.editStrategy).toBe('apply-patch');
			expect(profile.verbosity).toBe('low');
		});

		it('matches GPT-5 as openai-modern with apply-patch-with-insert-edit', () => {
			const profile = getModelProfileByFamily('gpt-5');
			expect(profile.editStrategy).toBe('apply-patch-with-insert-edit');
			expect(profile.notebookFormat).toBe('json');
		});

		it('matches GPT-5-mini with low verbosity', () => {
			const profile = getModelProfileByFamily('gpt-5-mini');
			expect(profile.editStrategy).toBe('apply-patch');
			expect(profile.verbosity).toBe('low');
		});

		it('matches GPT-5-codex as apply-patch-with-insert-edit', () => {
			const profile = getModelProfileByFamily('gpt-5-codex');
			expect(profile.editStrategy).toBe('apply-patch-with-insert-edit');
		});

		it('matches GPT-4o as legacy openai (insert-edit-only)', () => {
			const profile = getModelProfileByFamily('gpt-4o');
			expect(profile.editStrategy).toBe('insert-edit-only');
			expect(profile.notebookFormat).toBe('markdown');
		});

		it('matches claude as anthropic (multi-replace-string)', () => {
			const profile = getModelProfileByFamily('claude-sonnet-4');
			expect(profile.editStrategy).toBe('multi-replace-string');
			expect(profile.imageSupport.mcpResults).toBe(false);
			expect(profile.imageSupport.urls).toBe(true);
		});

		it('matches claude-3.5-sonnet with user-message instruction placement', () => {
			const profile = getModelProfileByFamily('claude-3.5-sonnet');
			expect(profile.instructionPlacement).toBe('user-message');
			expect(profile.editStrategy).toBe('multi-replace-string');
		});

		it('matches gemini-2 with replace-string healing', () => {
			const profile = getModelProfileByFamily('gemini-2.0-flash');
			expect(profile.editStrategy).toBe('replace-string');
			expect(profile.replaceStringHealing).toBe(true);
			expect(profile.replaceStringHint).toBe('strong');
		});

		it('matches gemini-3 without replace-string healing', () => {
			const profile = getModelProfileByFamily('gemini-3-pro');
			expect(profile.editStrategy).toBe('replace-string');
			expect(profile.replaceStringHealing).toBe(false);
		});

		it('matches grok-code as replace-string', () => {
			const profile = getModelProfileByFamily('grok-code-fast-1');
			expect(profile.editStrategy).toBe('replace-string');
			expect(profile.replaceStringHint).toBe('none');
		});

		it('matches o4-mini as apply-patch-with-insert-edit', () => {
			const profile = getModelProfileByFamily('o4-mini');
			expect(profile.editStrategy).toBe('apply-patch-with-insert-edit');
			expect(profile.notebookFormat).toBe('json');
		});

		it('returns default profile for unknown models', () => {
			const profile = getModelProfileByFamily('unknown-model');
			expect(profile.editStrategy).toBe('insert-edit-only');
			expect(profile.imageSupport.urls).toBe(true);
			expect(profile.imageSupport.mcpResults).toBe(true);
			expect(profile.notebookFormat).toBe('markdown');
		});

		it('longest prefix wins — gpt-5.1 beats gpt-5 beats gpt', () => {
			const gpt51 = getModelProfileByFamily('gpt-5.1-some-variant');
			const gpt5 = getModelProfileByFamily('gpt-5-some-variant');
			const gpt = getModelProfileByFamily('gpt-4o-mini');

			// gpt-5.1 gets apply-patch (modern)
			expect(gpt51.editStrategy).toBe('apply-patch');
			// gpt-5 gets apply-patch-with-insert-edit (modern but fallback)
			expect(gpt5.editStrategy).toBe('apply-patch-with-insert-edit');
			// gpt-4o gets insert-edit-only (legacy)
			expect(gpt.editStrategy).toBe('insert-edit-only');
		});
	});

	describe('getModelProfile - model object', () => {

		it('resolves profile from family for standard models', () => {
			const profile = getModelProfile(mockEndpoint('gpt-5.1'));
			expect(profile.editStrategy).toBe('apply-patch');
		});

		it('resolves profile from family for anthropic models', () => {
			const profile = getModelProfile(mockEndpoint('claude-sonnet-4'));
			expect(profile.editStrategy).toBe('multi-replace-string');
			expect(profile.imageSupport.mcpResults).toBe(false);
		});
	});

	describe('expandEditStrategy', () => {

		const cases: [EditStrategy, Partial<Record<keyof ReturnType<typeof expandEditStrategy>, boolean>>][] = [
			['apply-patch', { supportsApplyPatch: true, canUseApplyPatchExclusively: true, supportsSimplifiedApplyPatchInstructions: true, supportsReplaceString: false }],
			['apply-patch-with-insert-edit', { supportsApplyPatch: true, canUseApplyPatchExclusively: false, supportsSimplifiedApplyPatchInstructions: false }],
			['multi-replace-string', { supportsReplaceString: true, supportsMultiReplaceString: true, canUseReplaceStringExclusively: true, supportsApplyPatch: false }],
			['replace-string', { supportsReplaceString: true, supportsMultiReplaceString: false, canUseReplaceStringExclusively: true }],
			['insert-edit-only', { supportsApplyPatch: false, supportsReplaceString: false, canUseApplyPatchExclusively: false, canUseReplaceStringExclusively: false }],
		];

		for (const [strategy, expected] of cases) {
			it(`expands ${strategy} correctly`, () => {
				const caps = expandEditStrategy(strategy);
				for (const [key, value] of Object.entries(expected)) {
					expect(caps[key as keyof typeof caps]).toBe(value);
				}
			});
		}
	});

	describe('profile inheritance', () => {

		it('gpt-5.2-codex inherits from _openai-modern via _openai-legacy', () => {
			const profile = getModelProfileByFamily('gpt-5.2-codex');
			// From _openai-modern
			expect(profile.editStrategy).toBe('apply-patch');
			expect(profile.notebookFormat).toBe('json');
			// Inherited from _openai-legacy via _openai-modern
			expect(profile.imageSupport.urls).toBe(true);
			expect(profile.imageSupport.mcpResults).toBe(true);
		});

		it('claude inherits from _anthropic base', () => {
			const profile = getModelProfileByFamily('claude-opus-4.6');
			expect(profile.editStrategy).toBe('multi-replace-string');
			expect(profile.imageSupport.mcpResults).toBe(false);
			expect(profile.replaceStringHint).toBe('none');
		});

		it('gemini-2 overrides replaceStringHealing from _gemini base', () => {
			const base = getModelProfileByFamily('gemini-3-pro');
			const gemini2 = getModelProfileByFamily('gemini-2.0-flash');
			expect(base.replaceStringHealing).toBe(false);
			expect(gemini2.replaceStringHealing).toBe(true);
		});
	});

	describe('behavioral equivalence with old chatModelCapabilities', () => {

		function checkProfile(family: string, expected: Partial<ResolvedModelProfile>): void {
			const profile = getModelProfileByFamily(family);
			for (const [key, value] of Object.entries(expected)) {
				if (typeof value === 'object' && value !== null) {
					expect(profile[key as keyof ResolvedModelProfile]).toEqual(value);
				} else {
					expect(profile[key as keyof ResolvedModelProfile]).toBe(value);
				}
			}
		}

		it('claude-3.5-sonnet: user-message placement', () => {
			checkProfile('claude-3.5-sonnet', {
				instructionPlacement: 'user-message',
				editStrategy: 'multi-replace-string',
			});
		});

		it('gpt-4o: insert-edit-only, markdown notebooks', () => {
			checkProfile('gpt-4o', {
				editStrategy: 'insert-edit-only',
				notebookFormat: 'markdown',
			});
		});

		it('gpt-5.1: apply-patch, json notebooks, low verbosity', () => {
			checkProfile('gpt-5.1', {
				editStrategy: 'apply-patch',
				notebookFormat: 'json',
				verbosity: 'low',
			});
		});

		it('gpt-5-mini: low verbosity', () => {
			checkProfile('gpt-5-mini', {
				verbosity: 'low',
			});
		});

		it('gemini: replace-string with strong hint', () => {
			checkProfile('gemini-2.0-flash', {
				editStrategy: 'replace-string',
				replaceStringHint: 'strong',
				replaceStringHealing: true,
			});
		});

		it('grok-code: replace-string without strong hint', () => {
			checkProfile('grok-code-fast-1', {
				editStrategy: 'replace-string',
				replaceStringHint: 'none',
				replaceStringHealing: false,
			});
		});
	});
});
