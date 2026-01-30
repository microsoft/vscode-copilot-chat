/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelChat } from 'vscode';
import { getCachedSha256Hash } from '../../../util/common/crypto';
import type { IChatEndpoint } from '../../networking/common/networking';

const HIDDEN_MODEL_A_HASHES = [
	'a99dd17dfee04155d863268596b7f6dd36d0a6531cd326348dbe7416142a21a3',
	'6b0f165d0590bf8d508540a796b4fda77bf6a0a4ed4e8524d5451b1913100a95'
];

const HIDDEN_MODEL_C_HASHES = [
	'2daf0e6c79009f9234ed9baa5bb930898e2847810617e118518d88e4d3140a2e',
	'854910cb8a637565e3933f64549ac7e83dd55f6721e98f8324eb2065a84e09f8'
];

const VSC_MODEL_HASHES_A: string[] = [];

const VSC_MODEL_HASHES_B = [
	'6db59e9bfe6e2ce608c0ee0ade075c64e4d054f05305e3034481234703381bb5',
	'6b0f165d0590bf8d508540a796b4fda77bf6a0a4ed4e8524d5451b1913100a95',
	'7b667eee9b3517fb9aae7061617fd9cec524859fcd6a20a605bfb142a6b0f14e',
	'1d28f8e6e5af58c60e9a52385314a3c7bc61f7226e1444e31fe60c58c30e8235',
	'e7cfc1a7adaf9e419044e731b7a9e21940a5280a438b472db0c46752dd70eab3',
	'3104045f9b69dbb7a3d76cc8a0aa89eb05e10677c4dd914655ea87f4be000f4e',
];

const HIDDEN_MODEL_B_HASHES = [
	'31a2d5282683edb3a22c565f199aa96fb9ffb3107af35aad92ee1cd567cfc25d',
	'dd832404e8eeb90793f0369b96ed1702e0e22487a58eb4c1f285a4af5c4f6f21',
	'131e2083b68bde4fe879efc38ed9651b1623f8735eeb42157fa3b63ef943fdc6',
	'768e03eb8c0003f009745eb72538a435874c5b52a3e4cc71714ca06ceca60d29',
];

// subset to allow replace string instead of apply patch.
const VSC_MODEL_HASHES_SUBSET_C = [
	'6db59e9bfe6e2ce608c0ee0ade075c64e4d054f05305e3034481234703381bb5',
	'6b0f165d0590bf8d508540a796b4fda77bf6a0a4ed4e8524d5451b1913100a95',
	'7b667eee9b3517fb9aae7061617fd9cec524859fcd6a20a605bfb142a6b0f14e',
	'1d28f8e6e5af58c60e9a52385314a3c7bc61f7226e1444e31fe60c58c30e8235',
	'e7cfc1a7adaf9e419044e731b7a9e21940a5280a438b472db0c46752dd70eab3',
	'3104045f9b69dbb7a3d76cc8a0aa89eb05e10677c4dd914655ea87f4be000f4e',
];


const HIDDEN_MODEL_E_HASHES: string[] = [
	'6013de0381f648b7f21518885c02b40b7583adfb33c6d9b64d3aed52c3934798'
];

const HIDDEN_MODEL_F_HASHES: string[] = [
	'ab45e8474269b026f668d49860b36850122e18a50d5ea38f3fefdae08261865c',
	'9542d5c077c2bc379f92be32272b14be8b94a8841323465db0d5b3d6f4f0dab0',
];

function getModelId(model: LanguageModelChat | IChatEndpoint): string {
	return 'id' in model ? model.id : model.model;
}

export function isHiddenModelA(model: LanguageModelChat | IChatEndpoint) {
	const h = getCachedSha256Hash(model.family);
	return HIDDEN_MODEL_A_HASHES.includes(h);
}

export function isHiddenModelC(modelFamily: string) {
	const h = getCachedSha256Hash(modelFamily);
	return HIDDEN_MODEL_C_HASHES.includes(h);
}

export function isHiddenModelB(modelFamily: string) {
	const h = getCachedSha256Hash(modelFamily);
	return HIDDEN_MODEL_B_HASHES.includes(h);
}

export function isHiddenModelE(model: LanguageModelChat | IChatEndpoint) {
	const h = getCachedSha256Hash(model.family);
	return HIDDEN_MODEL_E_HASHES.includes(h);
}

export function isHiddenModelF(model: LanguageModelChat | IChatEndpoint) {
	const h = getCachedSha256Hash(model.family);
	return HIDDEN_MODEL_F_HASHES.includes(h);
}

export function isHiddenModelG(model: LanguageModelChat | IChatEndpoint) {
	const family_hash = getCachedSha256Hash(model.family);
	return family_hash === '0f20a0190d87a4c4659060f79fec24fb0bef76808950c6b8fd4b52daf7fc23d5';
}

export function isVSCModelA(model: LanguageModelChat | IChatEndpoint) {

	const ID_hash = getCachedSha256Hash(getModelId(model));
	const family_hash = getCachedSha256Hash(model.family);
	return VSC_MODEL_HASHES_A.includes(ID_hash) || VSC_MODEL_HASHES_A.includes(family_hash);
}

export function isVSCModelB(model: LanguageModelChat | IChatEndpoint) {
	const ID_hash = getCachedSha256Hash(getModelId(model));
	const family_hash = getCachedSha256Hash(model.family);
	return VSC_MODEL_HASHES_B.includes(ID_hash) || VSC_MODEL_HASHES_B.includes(family_hash);
}

export function isVSCModelC(model: LanguageModelChat | IChatEndpoint) {
	const ID_hash = getCachedSha256Hash(getModelId(model));
	const family_hash = getCachedSha256Hash(model.family);
	return VSC_MODEL_HASHES_SUBSET_C.includes(ID_hash) || VSC_MODEL_HASHES_SUBSET_C.includes(family_hash);
}

/**
 * Returns whether the instructions should be given in a user message instead
 * of a system message when talking to the model.
 */
export function modelPrefersInstructionsInUserMessage(modelFamily: string) {
	return modelFamily.includes('claude-3.5-sonnet');
}

/**
 * Returns whether the instructions should be presented after the history
 * for the given model.
 */
export function modelPrefersInstructionsAfterHistory(modelFamily: string) {
	return modelFamily.includes('claude-3.5-sonnet');
}

/**
 * Model supports apply_patch as an edit tool.
 */
export function modelSupportsApplyPatch(model: LanguageModelChat | IChatEndpoint): boolean {
	// only using replace string as edit tool, disable apply_patch for VSC Model C
	if (isVSCModelC(model)) {
		return false;
	}
	return (model.family.startsWith('gpt') && !model.family.includes('gpt-4o')) || model.family === 'o4-mini' || isHiddenModelC(model.family) || isVSCModelA(model) || isVSCModelB(model) || isHiddenModelB(model.family);
}

/**
 * Model prefers JSON notebook representation.
 */
export function modelPrefersJsonNotebookRepresentation(model: LanguageModelChat | IChatEndpoint): boolean {
	return (model.family.startsWith('gpt') && !model.family.includes('gpt-4o')) || model.family === 'o4-mini' || isHiddenModelC(model.family) || isHiddenModelB(model.family);
}

/**
 * Model supports replace_string_in_file as an edit tool.
 */
export function modelSupportsReplaceString(model: LanguageModelChat | IChatEndpoint): boolean {
	return model.family.toLowerCase().includes('gemini') || model.family.includes('grok-code') || modelSupportsMultiReplaceString(model) || isHiddenModelF(model);
}

/**
 * Model supports multi_replace_string_in_file as an edit tool.
 */
export function modelSupportsMultiReplaceString(model: LanguageModelChat | IChatEndpoint): boolean {
	return isAnthropicFamily(model) || isHiddenModelE(model) || isVSCModelC(model);
}

/**
 * The model is capable of using replace_string_in_file exclusively,
 * without needing insert_edit_into_file.
 */
export function modelCanUseReplaceStringExclusively(model: LanguageModelChat | IChatEndpoint): boolean {
	return isAnthropicFamily(model) || model.family.includes('grok-code') || isHiddenModelE(model) || model.family.toLowerCase().includes('gemini-3') || isVSCModelC(model) || isHiddenModelF(model);
}

/**
 * We should attempt to automatically heal incorrect edits the model may emit.
 * @note whether this is respected is currently controlled via EXP
 */
export function modelShouldUseReplaceStringHealing(model: LanguageModelChat | IChatEndpoint) {
	return model.family.includes('gemini-2');
}

/**
 * The model can accept image urls as the `image_url` parameter in mcp tool results.
 */
export function modelCanUseMcpResultImageURL(model: LanguageModelChat | IChatEndpoint): boolean {
	return !isAnthropicFamily(model) && !isHiddenModelE(model);
}

/**
 * The model can accept image urls as the `image_url` parameter in requests.
 */
export function modelCanUseImageURL(model: LanguageModelChat | IChatEndpoint): boolean {
	return true;
}

/**
 * The model is capable of using apply_patch as an edit tool exclusively,
 * without needing insert_edit_into_file.
 */
export function modelCanUseApplyPatchExclusively(model: LanguageModelChat | IChatEndpoint): boolean {
	// only using replace string as edit tool, disable apply_patch for VSC Model C
	if (isVSCModelC(model)) {
		return false;
	}
	return isGpt5PlusFamily(model) || isVSCModelA(model) || isVSCModelB(model);
}

/**
 * Whether, when replace_string and insert_edit tools are both available,
 * verbiage should be added in the system prompt directing the model to prefer
 * replace_string.
 */
export function modelNeedsStrongReplaceStringHint(model: LanguageModelChat | IChatEndpoint): boolean {
	return model.family.toLowerCase().includes('gemini') || isHiddenModelF(model);
}

/**
 * Model can take the simple, modern apply_patch instructions.
 */
export function modelSupportsSimplifiedApplyPatchInstructions(model: LanguageModelChat | IChatEndpoint): boolean {
	return isGpt5PlusFamily(model) || isVSCModelA(model) || isVSCModelB(model);
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
	return !!family.startsWith('gpt-5') || isHiddenModelC(family) || isHiddenModelB(family);
}

/**
 * Matches gpt-5-codex, gpt-5.1-codex, gpt-5.1-codex-mini, and any future models in this general family
 */
export function isGptCodexFamily(model: LanguageModelChat | IChatEndpoint | string | undefined): boolean {
	if (!model) {
		return false;
	}

	const family = typeof model === 'string' ? model : model.family;
	return (!!family.startsWith('gpt-') && family.includes('-codex')) || isHiddenModelC(family);
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
	return !!family.startsWith('gpt-') || isHiddenModelC(family);
}

/**
 * Any GPT-5.1+ model
 */
export function isGpt51Family(model: LanguageModelChat | IChatEndpoint | string | undefined): boolean {
	if (!model) {
		return false;
	}

	const family = typeof model === 'string' ? model : model.family;
	return !!family.match(/^gpt-5\.\d+/i) || isHiddenModelC(family);
}

/**
 * This takes a sync shortcut and should only be called when a model hash would have already been computed while rendering the prompt.
 */
export function getVerbosityForModelSync(model: IChatEndpoint): 'low' | 'medium' | 'high' | undefined {
	if (model.family === 'gpt-5.1' || model.family === 'gpt-5-mini') {
		return 'low';
	}

	return undefined;
}
