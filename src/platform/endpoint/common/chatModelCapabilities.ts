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

const VSC_MODEL_HASHES = [
	'7b667eee9b3517fb9aae7061617fd9cec524859fcd6a20a605bfb142a6b0f14e',
	'e7cfc1a7adaf9e419044e731b7a9e21940a5280a438b472db0c46752dd70eab3',
	'878722e35e24b005604c37aa5371ae100e82465fbfbdf6fe3c1fdaf7c92edc96',
	'1d28f8e6e5af58c60e9a52385314a3c7bc61f7226e1444e31fe60c58c30e8235',
	'3104045f9b69dbb7a3d76cc8a0aa89eb05e10677c4dd914655ea87f4be000f4e',
	'b576d46942ee2c45ecd979cbbcb62688ae3171a07ac83f53b783787f345e3dd7',
];

function getModelId(model: LanguageModelChat | IChatEndpoint): string {
	return 'id' in model ? model.id : model.model;
}

export async function isHiddenModelA(model: LanguageModelChat | IChatEndpoint) {
	const h = await getCachedSha256Hash(model.family);
	return HIDDEN_MODEL_A_HASHES.includes(h);
}

export async function isVSCModel(model: LanguageModelChat | IChatEndpoint) {
	const h = await getCachedSha256Hash(getModelId(model));
	return VSC_MODEL_HASHES.includes(h);
}

export async function isHiddenModelC(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	const h = await getCachedSha256Hash(getModelId(model));
	return h === '56acb47d94a1d23305a6a804bc705e9f35ce908480d9a0dcef28d827413a7971';
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
	return (model.family.includes('gpt') && !model.family.includes('gpt-4o')) || model.family === 'o4-mini' || await isHiddenModelA(model) || await isHiddenModelC(model);
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
	return model.family.includes('gemini') || model.family.includes('grok-code') || await modelSupportsMultiReplaceString(model);
}

/**
 * Model supports multi_replace_string_in_file as an edit tool.
 */
export async function modelSupportsMultiReplaceString(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	return model.family.startsWith('claude') || model.family.startsWith('Anthropic');
}

/**
 * The model is capable of using replace_string_in_file exclusively,
 * without needing insert_edit_into_file.
 */
export async function modelCanUseReplaceStringExclusively(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	return model.family.startsWith('claude') || model.family.startsWith('Anthropic') || model.family.includes('grok-code');
}

/**
 * We should attempt to automatically heal incorrect edits the model may emit.
 * @note whether this is respected is currently controlled via EXP
 */
export function modelShouldUseReplaceStringHealing(model: LanguageModelChat | IChatEndpoint) {
	return model.family.includes('gemini');
}

/**
 * The model can accept image urls as the `image_url` parameter in mcp tool results.
 */
export async function modelCanUseMcpResultImageURL(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	return !model.family.startsWith('claude') && !model.family.startsWith('Anthropic');
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
export async function modelCanUseApplyPatchExclusively(model: LanguageModelChat | IChatEndpoint): Promise<boolean> {
	return model.family.startsWith('gpt-5') || await isHiddenModelC(model);
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
