/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelChat } from 'vscode';
import { getCachedSha256Hash } from '../../../util/common/crypto';
import type { IChatEndpoint } from '../../networking/common/networking';

/**
 * Edit strategy — determines which edit tools are available and how they're used.
 *
 * - 'apply-patch': Model uses apply_patch exclusively (GPT-5.1+). Implies simplified instructions.
 * - 'apply-patch-with-insert-edit': Model uses apply_patch but also needs insert_edit fallback (GPT-5, o4-mini).
 * - 'multi-replace-string': Model uses multi_replace_string_in_file exclusively (Claude, hidden model E).
 * - 'replace-string': Model uses replace_string_in_file + insert_edit (Gemini, Grok).
 * - 'insert-edit-only': Model only uses insert_edit_into_file (GPT-4o, default).
 */
export type EditStrategy =
	| 'apply-patch'
	| 'apply-patch-with-insert-edit'
	| 'multi-replace-string'
	| 'replace-string'
	| 'insert-edit-only';

/**
 * Where system instructions are placed in the conversation.
 *
 * - 'system-before-history': System message before conversation history (default, most models).
 * - 'system-after-history': System message after conversation history.
 * - 'user-message': Instructions placed in a user message instead of system (claude-3.5-sonnet).
 */
export type InstructionPlacement =
	| 'system-before-history'
	| 'system-after-history'
	| 'user-message';

export interface ImageSupport {
	/** Can accept image URLs in requests. */
	readonly urls?: boolean;
	/** Can accept image URLs in MCP tool results. */
	readonly mcpResults?: boolean;
}

export interface ModelProfile {
	/** Base profile to inherit from. Only override what's different. */
	readonly extends?: string;

	/** Human-readable explanation of what's special about this model. */
	readonly description?: string;

	/** How this model edits code. See EditStrategy docs. */
	readonly editStrategy?: EditStrategy;

	/** Where to place instructions relative to conversation history. */
	readonly instructionPlacement?: InstructionPlacement;

	/** Whether the model needs extra prompt verbiage to prefer replace_string. */
	readonly replaceStringHint?: 'none' | 'strong';

	/** Whether to auto-heal incorrect replace_string edits. */
	readonly replaceStringHealing?: boolean;

	/** Image support flags. */
	readonly imageSupport?: ImageSupport;

	/** Notebook representation format. */
	readonly notebookFormat?: 'json' | 'markdown';

	/** Response verbosity hint. */
	readonly verbosity?: 'low' | 'medium' | 'high';
}

/** Fully resolved profile with all fields defined. */
export interface ResolvedModelProfile {
	readonly editStrategy: EditStrategy;
	readonly instructionPlacement: InstructionPlacement;
	readonly replaceStringHint: 'none' | 'strong';
	readonly replaceStringHealing: boolean;
	readonly imageSupport: Required<ImageSupport>;
	readonly notebookFormat: 'json' | 'markdown';
	readonly verbosity: 'low' | 'medium' | 'high' | undefined;
}

/** Edit capability flags expanded from an EditStrategy. */
export interface EditCapabilities {
	readonly supportsApplyPatch: boolean;
	readonly supportsReplaceString: boolean;
	readonly supportsMultiReplaceString: boolean;
	readonly canUseApplyPatchExclusively: boolean;
	readonly canUseReplaceStringExclusively: boolean;
	readonly supportsSimplifiedApplyPatchInstructions: boolean;
}

/**
 * Default profile for unknown models — insert-edit only, standard settings.
 */
const DEFAULT_PROFILE: ResolvedModelProfile = {
	editStrategy: 'insert-edit-only',
	instructionPlacement: 'system-before-history',
	replaceStringHint: 'none',
	replaceStringHealing: false,
	imageSupport: { urls: true, mcpResults: true },
	notebookFormat: 'markdown',
	verbosity: undefined,
};

// =========================================================================
// Hash arrays for hidden/unreleased models — kept from chatModelCapabilities.ts
// =========================================================================

const HIDDEN_MODEL_A_HASHES = [
	'a99dd17dfee04155d863268596b7f6dd36d0a6531cd326348dbe7416142a21a3',
	'6b0f165d0590bf8d508540a796b4fda77bf6a0a4ed4e8524d5451b1913100a95'
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

const HIDDEN_MODEL_G_HASH = 'b5452bf9c5a974c01d3f233a04f8e2e251227a76d7e314ccc9970116708d27d9';

// =========================================================================
// Hash-based model identification helpers (exported for prompt resolvers)
// =========================================================================

function getModelId(model: LanguageModelChat | IChatEndpoint): string {
	return 'id' in model ? model.id : model.model;
}

export function isHiddenModelF(model: LanguageModelChat | IChatEndpoint): boolean {
	const h = getCachedSha256Hash(model.family);
	return HIDDEN_MODEL_F_HASHES.includes(h);
}

export function isHiddenModelG(model: LanguageModelChat | IChatEndpoint): boolean {
	const family_hash = getCachedSha256Hash(model.family);
	return family_hash === HIDDEN_MODEL_G_HASH;
}

export function isVSCModelA(model: LanguageModelChat | IChatEndpoint): boolean {
	const ID_hash = getCachedSha256Hash(getModelId(model));
	const family_hash = getCachedSha256Hash(model.family);
	return VSC_MODEL_HASHES_A.includes(ID_hash) || VSC_MODEL_HASHES_A.includes(family_hash);
}

export function isVSCModelB(model: LanguageModelChat | IChatEndpoint): boolean {
	const ID_hash = getCachedSha256Hash(getModelId(model));
	const family_hash = getCachedSha256Hash(model.family);
	return VSC_MODEL_HASHES_B.includes(ID_hash) || VSC_MODEL_HASHES_B.includes(family_hash);
}

// =========================================================================
// MODEL PROFILES — the single source of truth for how every model behaves.
//
// To onboard a new model: add one entry here.
// Keys prefixed with '_' are base archetypes (not matched directly).
// Concrete model keys are matched against model.family using longest-prefix-first.
//
// Resolution: concrete profile → inherited base → DEFAULT_PROFILE
// =========================================================================

const MODEL_PROFILES: Record<string, ModelProfile> = {

	// =========================================================================
	// BASE ARCHETYPES (prefixed with _ so they're never matched directly)
	// =========================================================================

	'_anthropic': {
		description: 'Base Anthropic archetype — multi-replace-string, no MCP image URLs',
		editStrategy: 'multi-replace-string',
		instructionPlacement: 'system-before-history',
		replaceStringHint: 'none',
		replaceStringHealing: false,
		imageSupport: { urls: true, mcpResults: false },
		notebookFormat: 'markdown',
	},

	'_openai-legacy': {
		description: 'Base OpenAI archetype for GPT-4o era — insert-edit only',
		editStrategy: 'insert-edit-only',
		instructionPlacement: 'system-before-history',
		replaceStringHint: 'none',
		replaceStringHealing: false,
		imageSupport: { urls: true, mcpResults: true },
		notebookFormat: 'markdown',
	},

	'_openai-modern': {
		description: 'Base OpenAI archetype for GPT-5+ — apply-patch, JSON notebooks',
		extends: '_openai-legacy',
		editStrategy: 'apply-patch',
		notebookFormat: 'json',
	},

	'_gemini': {
		description: 'Base Gemini archetype — replace-string with strong hint',
		editStrategy: 'replace-string',
		instructionPlacement: 'system-before-history',
		replaceStringHint: 'strong',
		replaceStringHealing: false,
		imageSupport: { urls: true, mcpResults: true },
		notebookFormat: 'markdown',
	},

	// =========================================================================
	// ANTHROPIC MODELS
	// =========================================================================

	'claude-3.5-sonnet': {
		extends: '_anthropic',
		description: 'Claude 3.5 Sonnet — instructions in user message, after history',
		instructionPlacement: 'user-message',
	},

	'claude': {
		extends: '_anthropic',
		description: 'Catch-all for Claude models',
	},

	'Anthropic': {
		extends: '_anthropic',
		description: 'Catch-all for Anthropic-prefixed models',
	},

	// =========================================================================
	// OPENAI MODELS
	// =========================================================================

	'gpt-5.3-codex': {
		extends: '_openai-modern',
		description: 'GPT-5.3 Codex — low verbosity',
		verbosity: 'low',
	},

	'gpt-5.2-codex': {
		extends: '_openai-modern',
		description: 'GPT-5.2 Codex',
	},

	'gpt-5.2': {
		extends: '_openai-modern',
		description: 'GPT-5.2',
	},

	'gpt-5.1-codex': {
		extends: '_openai-modern',
		description: 'GPT-5.1 Codex — low verbosity',
		verbosity: 'low',
	},

	'gpt-5.1': {
		extends: '_openai-modern',
		description: 'GPT-5.1 — low verbosity',
		verbosity: 'low',
	},

	'gpt-5-codex': {
		extends: '_openai-modern',
		description: 'GPT-5 Codex — apply-patch with insert-edit fallback',
		editStrategy: 'apply-patch-with-insert-edit',
	},

	'gpt-5-mini': {
		extends: '_openai-modern',
		description: 'GPT-5 Mini — low verbosity',
		verbosity: 'low',
	},

	'gpt-5': {
		extends: '_openai-modern',
		description: 'GPT-5 — apply-patch with insert-edit fallback',
		editStrategy: 'apply-patch-with-insert-edit',
	},

	'o4-mini': {
		extends: '_openai-modern',
		description: 'o4-mini — apply-patch with insert-edit fallback, JSON notebooks',
		editStrategy: 'apply-patch-with-insert-edit',
	},

	'o3-mini': {
		extends: '_openai-legacy',
		description: 'o3-mini — legacy OpenAI behavior',
	},

	'OpenAI': {
		extends: '_openai-legacy',
		description: 'Catch-all for OpenAI-prefixed models',
	},

	'gpt': {
		extends: '_openai-legacy',
		description: 'Catch-all for GPT models not matched above (GPT-4o era)',
	},

	// =========================================================================
	// GEMINI MODELS
	// =========================================================================

	'gemini-3': {
		extends: '_gemini',
		description: 'Gemini 3',
	},

	'gemini-2': {
		extends: '_gemini',
		description: 'Gemini 2 — needs replace-string healing',
		replaceStringHealing: true,
	},

	'gemini': {
		extends: '_gemini',
		description: 'Catch-all for Gemini models',
	},

	// =========================================================================
	// OTHER MODELS
	// =========================================================================

	'grok-code': {
		description: 'xAI Grok Code — replace-string',
		editStrategy: 'replace-string',
		instructionPlacement: 'system-before-history',
		replaceStringHint: 'none',
		replaceStringHealing: false,
		imageSupport: { urls: true, mcpResults: true },
		notebookFormat: 'markdown',
	},
};

// =========================================================================
// Profile resolution
// =========================================================================

/** Cache for sorted profile keys (longest prefix first). */
let sortedProfileKeys: string[] | undefined;

function getSortedProfileKeys(): string[] {
	if (!sortedProfileKeys) {
		sortedProfileKeys = Object.keys(MODEL_PROFILES)
			.filter(key => !key.startsWith('_'))
			.sort((a, b) => b.length - a.length);
	}
	return sortedProfileKeys;
}

/**
 * Returns all concrete (non-archetype) profile keys from the MODEL_PROFILES table.
 * Useful for tests that need to ensure coverage of all registered model families.
 */
export function getRegisteredProfileKeys(): readonly string[] {
	return getSortedProfileKeys();
}

/** Find the profile whose key is the longest prefix of the given family string. */
function findProfileByLongestPrefix(family: string): ModelProfile | undefined {
	for (const key of getSortedProfileKeys()) {
		if (family.startsWith(key)) {
			return MODEL_PROFILES[key];
		}
	}
	return undefined;
}

/** Walk the `extends` chain and return profiles from base to concrete. */
function resolveInheritanceChain(profile: ModelProfile | undefined): ModelProfile[] {
	const chain: ModelProfile[] = [];
	let current = profile;
	const visited = new Set<string>();
	while (current) {
		chain.unshift(current);
		if (!current.extends || visited.has(current.extends)) {
			break;
		}
		visited.add(current.extends);
		current = MODEL_PROFILES[current.extends];
	}
	return chain;
}

/** Merge a chain of partial profiles into a fully resolved profile. */
function mergeProfiles(chain: ModelProfile[]): ResolvedModelProfile {
	let imageSupport = DEFAULT_PROFILE.imageSupport;
	let editStrategy = DEFAULT_PROFILE.editStrategy;
	let instructionPlacement = DEFAULT_PROFILE.instructionPlacement;
	let replaceStringHint = DEFAULT_PROFILE.replaceStringHint;
	let replaceStringHealing = DEFAULT_PROFILE.replaceStringHealing;
	let notebookFormat = DEFAULT_PROFILE.notebookFormat;
	let verbosity = DEFAULT_PROFILE.verbosity;

	for (const p of chain) {
		if (p.editStrategy !== undefined) {
			editStrategy = p.editStrategy;
		}
		if (p.instructionPlacement !== undefined) {
			instructionPlacement = p.instructionPlacement;
		}
		if (p.replaceStringHint !== undefined) {
			replaceStringHint = p.replaceStringHint;
		}
		if (p.replaceStringHealing !== undefined) {
			replaceStringHealing = p.replaceStringHealing;
		}
		if (p.imageSupport !== undefined) {
			imageSupport = {
				urls: p.imageSupport.urls ?? imageSupport.urls,
				mcpResults: p.imageSupport.mcpResults ?? imageSupport.mcpResults,
			};
		}
		if (p.notebookFormat !== undefined) {
			notebookFormat = p.notebookFormat;
		}
		if (p.verbosity !== undefined) {
			verbosity = p.verbosity;
		}
	}

	return {
		editStrategy,
		instructionPlacement,
		replaceStringHint,
		replaceStringHealing,
		imageSupport,
		notebookFormat,
		verbosity,
	};
}

/** Profile cache keyed by family string. */
const profileCache = new Map<string, ResolvedModelProfile>();

/**
 * Resolve a fully-merged profile for a model family string.
 * Handles hash-based hidden models as well as prefix-matched profiles.
 */
export function getModelProfileByFamily(family: string): ResolvedModelProfile {
	const cached = profileCache.get(family);
	if (cached) {
		return cached;
	}

	const matched = findProfileByLongestPrefix(family);
	const chain = resolveInheritanceChain(matched);
	const resolved = mergeProfiles(chain);
	profileCache.set(family, resolved);
	return resolved;
}

/**
 * Resolve a fully-merged profile for a model object.
 * This also handles hash-based hidden models that don't match by family prefix.
 */
export function getModelProfile(model: LanguageModelChat | IChatEndpoint): ResolvedModelProfile {
	// Try hash-based matching first for hidden models
	const hashProfile = resolveHashBasedProfile(model);
	if (hashProfile) {
		return hashProfile;
	}
	return getModelProfileByFamily(model.family);
}

/** Hash-based profile cache keyed by model identity. */
const hashProfileCache = new Map<string, ResolvedModelProfile | null>();

function resolveHashBasedProfile(model: LanguageModelChat | IChatEndpoint): ResolvedModelProfile | undefined {
	const modelId = getModelId(model);
	const cacheKey = `${model.family}:${modelId}`;

	const cached = hashProfileCache.get(cacheKey);
	if (cached !== undefined) {
		return cached ?? undefined;
	}

	const family_hash = getCachedSha256Hash(model.family);
	const id_hash = getCachedSha256Hash(modelId);

	// Hidden model G → Anthropic archetype
	if (family_hash === HIDDEN_MODEL_G_HASH) {
		const profile = mergeProfiles(resolveInheritanceChain(MODEL_PROFILES['_anthropic']));
		hashProfileCache.set(cacheKey, profile);
		return profile;
	}

	// Hidden model E → multi-replace-string, no MCP image URLs (like Anthropic)
	if (HIDDEN_MODEL_E_HASHES.includes(family_hash)) {
		const profile = mergeProfiles(resolveInheritanceChain(MODEL_PROFILES['_anthropic']));
		hashProfileCache.set(cacheKey, profile);
		return profile;
	}

	// VSC Model C → multi-replace-string (subset of B that uses replace-string instead of apply-patch)
	if (VSC_MODEL_HASHES_SUBSET_C.includes(id_hash) || VSC_MODEL_HASHES_SUBSET_C.includes(family_hash)) {
		const profile: ResolvedModelProfile = {
			editStrategy: 'multi-replace-string',
			instructionPlacement: 'system-before-history',
			replaceStringHint: 'none',
			replaceStringHealing: false,
			imageSupport: { urls: true, mcpResults: true },
			notebookFormat: 'markdown',
			verbosity: undefined,
		};
		hashProfileCache.set(cacheKey, profile);
		return profile;
	}

	// VSC Model B → apply-patch
	if (VSC_MODEL_HASHES_B.includes(id_hash) || VSC_MODEL_HASHES_B.includes(family_hash)) {
		const profile = mergeProfiles(resolveInheritanceChain(MODEL_PROFILES['_openai-modern']));
		hashProfileCache.set(cacheKey, profile);
		return profile;
	}

	// VSC Model A → apply-patch
	if (VSC_MODEL_HASHES_A.includes(id_hash) || VSC_MODEL_HASHES_A.includes(family_hash)) {
		const profile = mergeProfiles(resolveInheritanceChain(MODEL_PROFILES['_openai-modern']));
		hashProfileCache.set(cacheKey, profile);
		return profile;
	}

	// Hidden model A → needs to be checked in family checkers but has no specific profile override
	if (HIDDEN_MODEL_A_HASHES.includes(family_hash)) {
		// Hidden model A uses default behavior — just cache null so we don't re-check
		hashProfileCache.set(cacheKey, null);
		return undefined;
	}

	// Hidden model F → Gemini-like with strong replace-string hint
	if (HIDDEN_MODEL_F_HASHES.includes(family_hash)) {
		const baseGemini = mergeProfiles(resolveInheritanceChain(MODEL_PROFILES['_gemini']));
		hashProfileCache.set(cacheKey, baseGemini);
		return baseGemini;
	}

	hashProfileCache.set(cacheKey, null);
	return undefined;
}

// =========================================================================
// EditStrategy expansion
// =========================================================================

/** Expand an EditStrategy into individual capability flags. */
export function expandEditStrategy(strategy: EditStrategy): EditCapabilities {
	switch (strategy) {
		case 'apply-patch':
			return {
				supportsApplyPatch: true,
				supportsReplaceString: false,
				supportsMultiReplaceString: false,
				canUseApplyPatchExclusively: true,
				canUseReplaceStringExclusively: false,
				supportsSimplifiedApplyPatchInstructions: true,
			};
		case 'apply-patch-with-insert-edit':
			return {
				supportsApplyPatch: true,
				supportsReplaceString: false,
				supportsMultiReplaceString: false,
				canUseApplyPatchExclusively: false,
				canUseReplaceStringExclusively: false,
				supportsSimplifiedApplyPatchInstructions: false,
			};
		case 'multi-replace-string':
			return {
				supportsApplyPatch: false,
				supportsReplaceString: true,
				supportsMultiReplaceString: true,
				canUseApplyPatchExclusively: false,
				canUseReplaceStringExclusively: true,
				supportsSimplifiedApplyPatchInstructions: false,
			};
		case 'replace-string':
			return {
				supportsApplyPatch: false,
				supportsReplaceString: true,
				supportsMultiReplaceString: false,
				canUseApplyPatchExclusively: false,
				canUseReplaceStringExclusively: true,
				supportsSimplifiedApplyPatchInstructions: false,
			};
		case 'insert-edit-only':
			return {
				supportsApplyPatch: false,
				supportsReplaceString: false,
				supportsMultiReplaceString: false,
				canUseApplyPatchExclusively: false,
				canUseReplaceStringExclusively: false,
				supportsSimplifiedApplyPatchInstructions: false,
			};
	}
}
