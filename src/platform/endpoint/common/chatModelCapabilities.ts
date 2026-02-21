/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelChat } from 'vscode';
import type { IChatEndpoint } from '../../networking/common/networking';
import { expandEditStrategy, getModelProfile, getModelProfileByFamily, isHiddenModelG } from './modelProfiles';

// Re-export hash-based model identifiers from modelProfiles — prompt resolvers still need these
export { isHiddenModelF, isVSCModelA, isVSCModelB } from './modelProfiles';

export function isGpt53Codex(model: LanguageModelChat | IChatEndpoint | string): boolean {
	const family = typeof model === 'string' ? model : model.family;
	return family.startsWith('gpt-5.3-codex');
}

export function isGpt52CodexFamily(model: LanguageModelChat | IChatEndpoint | string): boolean {
	const family = typeof model === 'string' ? model : model.family;
	return family === 'gpt-5.2-codex';
}

export function isGpt52Family(model: LanguageModelChat | IChatEndpoint | string): boolean {
	const family = typeof model === 'string' ? model : model.family;
	return family === 'gpt-5.2';
}

/**
 * Returns whether the instructions should be given in a user message instead
 * of a system message when talking to the model.
 */
export function modelPrefersInstructionsInUserMessage(modelFamily: string): boolean {
	return getModelProfileByFamily(modelFamily).instructionPlacement === 'user-message';
}

/**
 * Returns whether the instructions should be presented after the history
 * for the given model.
 */
export function modelPrefersInstructionsAfterHistory(modelFamily: string): boolean {
	const placement = getModelProfileByFamily(modelFamily).instructionPlacement;
	return placement === 'system-after-history' || placement === 'user-message';
}

/**
 * Model supports apply_patch as an edit tool.
 */
export function modelSupportsApplyPatch(model: LanguageModelChat | IChatEndpoint): boolean {
	return expandEditStrategy(getModelProfile(model).editStrategy).supportsApplyPatch;
}

/**
 * Model prefers JSON notebook representation.
 */
export function modelPrefersJsonNotebookRepresentation(model: LanguageModelChat | IChatEndpoint): boolean {
	return getModelProfile(model).notebookFormat === 'json';
}

/**
 * Model supports replace_string_in_file as an edit tool.
 */
export function modelSupportsReplaceString(model: LanguageModelChat | IChatEndpoint): boolean {
	return expandEditStrategy(getModelProfile(model).editStrategy).supportsReplaceString;
}

/**
 * Model supports multi_replace_string_in_file as an edit tool.
 */
export function modelSupportsMultiReplaceString(model: LanguageModelChat | IChatEndpoint): boolean {
	return expandEditStrategy(getModelProfile(model).editStrategy).supportsMultiReplaceString;
}

/**
 * The model is capable of using replace_string_in_file exclusively,
 * without needing insert_edit_into_file.
 */
export function modelCanUseReplaceStringExclusively(model: LanguageModelChat | IChatEndpoint): boolean {
	return expandEditStrategy(getModelProfile(model).editStrategy).canUseReplaceStringExclusively;
}

/**
 * We should attempt to automatically heal incorrect edits the model may emit.
 * @note whether this is respected is currently controlled via EXP
 */
export function modelShouldUseReplaceStringHealing(model: LanguageModelChat | IChatEndpoint): boolean {
	return getModelProfile(model).replaceStringHealing;
}

/**
 * The model can accept image urls as the `image_url` parameter in mcp tool results.
 */
export function modelCanUseMcpResultImageURL(model: LanguageModelChat | IChatEndpoint): boolean {
	return getModelProfile(model).imageSupport.mcpResults;
}

/**
 * The model can accept image urls as the `image_url` parameter in requests.
 */
export function modelCanUseImageURL(model: LanguageModelChat | IChatEndpoint): boolean {
	return getModelProfile(model).imageSupport.urls;
}

/**
 * The model is capable of using apply_patch as an edit tool exclusively,
 * without needing insert_edit_into_file.
 */
export function modelCanUseApplyPatchExclusively(model: LanguageModelChat | IChatEndpoint): boolean {
	return expandEditStrategy(getModelProfile(model).editStrategy).canUseApplyPatchExclusively;
}

/**
 * Whether, when replace_string and insert_edit tools are both available,
 * verbiage should be added in the system prompt directing the model to prefer
 * replace_string.
 */
export function modelNeedsStrongReplaceStringHint(model: LanguageModelChat | IChatEndpoint): boolean {
	return getModelProfile(model).replaceStringHint === 'strong';
}

/**
 * Model can take the simple, modern apply_patch instructions.
 */
export function modelSupportsSimplifiedApplyPatchInstructions(model: LanguageModelChat | IChatEndpoint): boolean {
	return expandEditStrategy(getModelProfile(model).editStrategy).supportsSimplifiedApplyPatchInstructions;
}

export function isAnthropicFamily(model: LanguageModelChat | IChatEndpoint): boolean {
	return model.family.startsWith('claude') || model.family.startsWith('Anthropic') || isHiddenModelG(model);
}

export function isGeminiFamily(model: LanguageModelChat | IChatEndpoint): boolean {
	return model.family.toLowerCase().startsWith('gemini');
}

export function isGpt5PlusFamily(model: LanguageModelChat | IChatEndpoint | string | undefined): boolean {
	if (!model) {
		return false;
	}

	const family = typeof model === 'string' ? model : model.family;
	return !!family.startsWith('gpt-5');
}

/**
 * Matches gpt-5-codex, gpt-5.1-codex, gpt-5.1-codex-mini, and any future models in this general family
 */
export function isGptCodexFamily(model: LanguageModelChat | IChatEndpoint | string | undefined): boolean {
	if (!model) {
		return false;
	}

	const family = typeof model === 'string' ? model : model.family;
	return (!!family.startsWith('gpt-') && family.includes('-codex'));
}

/**
 * GPT-5, -mini, -codex, not 5.1+
 */
export function isGpt5Family(model: LanguageModelChat | IChatEndpoint | string | undefined): boolean {
	if (!model) {
		return false;
	}

	const family = typeof model === 'string' ? model : model.family;
	return family === 'gpt-5' || family === 'gpt-5-mini' || family === 'gpt-5-codex';
}

export function isGptFamily(model: LanguageModelChat | IChatEndpoint | string | undefined): boolean {
	if (!model) {
		return false;
	}

	const family = typeof model === 'string' ? model : model.family;
	return !!family.startsWith('gpt-');
}

/**
 * Any GPT-5.1+ model
 */
export function isGpt51Family(model: LanguageModelChat | IChatEndpoint | string | undefined): boolean {
	if (!model) {
		return false;
	}

	const family = typeof model === 'string' ? model : model.family;
	return !!family.startsWith('gpt-5.1');
}

/**
 * This takes a sync shortcut and should only be called when a model hash would have already been computed while rendering the prompt.
 */
export function getVerbosityForModelSync(model: IChatEndpoint): 'low' | 'medium' | 'high' | undefined {
	return getModelProfile(model).verbosity;
}
