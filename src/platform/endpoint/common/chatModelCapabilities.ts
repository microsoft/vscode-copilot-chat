/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelChat } from 'vscode';
import { encodeHex, VSBuffer } from '../../../util/vs/base/common/buffer';
import type { IChatEndpoint } from '../../networking/common/networking';

const _cachedHashes = new Map<string, string>();

async function getSha256Hash(text: string): Promise<string> {
	if (_cachedHashes.has(text)) {
		return _cachedHashes.get(text)!;
	}

	const encoder = new TextEncoder();
	const data = encoder.encode(text);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hash = encodeHex(VSBuffer.wrap(new Uint8Array(hashBuffer)));
	_cachedHashes.set(text, hash);
	return hash;
}

const HIDDEN_MODEL_A_HASHES = [
	'a99dd17dfee04155d863268596b7f6dd36d0a6531cd326348dbe7416142a21a3',
	'6b0f165d0590bf8d508540a796b4fda77bf6a0a4ed4e8524d5451b1913100a95'
];

export async function isHiddenModelA(model: LanguageModelChat | IChatEndpoint) {
	const h = await getSha256Hash(model.family);
	return HIDDEN_MODEL_A_HASHES.includes(h);
}

export async function isHiddenModelB(model: LanguageModelChat | IChatEndpoint) {
	return await getSha256Hash(model.family) === '4243b479ae1f345e3b3beff413f628c1c3edf2b54bc75859e736f0254231aafb';
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
export async function modelSupportsApplyPatch(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	return (model.family.includes('gpt') && !model.family.includes('gpt-4o')) || model.family === 'o4-mini' || await isHiddenModelA(model);
}

/**
 * Model prefers JSON notebook representation.
 */
export function modelPrefersJsonNotebookRepresentation(model: LanguageModelChat | IChatEndpoint): boolean {
	return (model.family.includes('gpt') && !model.family.includes('gpt-4o')) || model.family === 'o4-mini';
}

/**
 * Model supports replace_string_in_file as an edit tool.
 */
export async function modelSupportsReplaceString(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	return model.family.startsWith('claude') || model.family.startsWith('Anthropic') || model.family.includes('gemini') || await isHiddenModelB(model);
}

/**
 * Model supports multi_replace_string_in_file as an edit tool.
 */
export async function modelSupportsMultiReplaceString(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	return await modelSupportsReplaceString(model) && !model.family.includes('gemini');
}

/**
 * The model is capable of using replace_string_in_file exclusively,
 * without needing insert_edit_into_file.
 */
export async function modelCanUseReplaceStringExclusively(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	return model.family.startsWith('claude') || model.family.startsWith('Anthropic') || await isHiddenModelB(model);
}

/**
 * The model can accept image urls as the `image_url` parameter in mcp tool results.
 */
export async function modelCanUseMcpResultImageURL(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	return !model.family.startsWith('claude') && !model.family.startsWith('Anthropic') && !await isHiddenModelB(model);
}

/**
 * The model can accept image urls as the `image_url` parameter in requests.
 */
export function modelCanUseImageURL(model: LanguageModelChat | IChatEndpoint): boolean {
	return !model.family.startsWith('gemini');
}


/**
 * The model is capable of using apply_patch as an edit tool exclusively,
 * without needing insert_edit_into_file.
 */
export function modelCanUseApplyPatchExclusively(model: LanguageModelChat | IChatEndpoint): boolean {
	return model.family.startsWith('gpt-5');
}

/**
 * Whether, when replace_string and insert_edit tools are both available,
 * verbiage should be added in the system prompt directing the model to prefer
 * replace_string.
 */
export function modelNeedsStrongReplaceStringHint(model: LanguageModelChat | IChatEndpoint): boolean {
	return model.family.toLowerCase().includes('gemini');
}

/**
 * Model can take the simple, modern apply_patch instructions.
 */
export function modelSupportsSimplifiedApplyPatchInstructions(model: LanguageModelChat | IChatEndpoint): boolean {
	return model.family.startsWith('gpt-5');
}
