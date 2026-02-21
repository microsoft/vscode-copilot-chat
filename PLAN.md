# Implementation Plan: Config-Driven Model Prompt & Capability Mapping

## Problem

Every time a new model is added (e.g. Claude Sonnet 4, GPT-5.3-Codex, Gemini 3), engineers must make hardcoded changes in two places:

1. **`PromptRegistry`** — a new prompt resolver class + TSX file must be created to map the model's family to the correct system prompt variant. E.g. `gpt51Prompt.tsx`, `gpt52Prompt.tsx`, `gpt53CodexPrompt.tsx`, `anthropicPrompts.tsx` (with sub-branches for Sonnet 4 vs Claude 4.5 vs Claude 4.6).

2. **`chatModelCapabilities.ts`** — a growing bag of boolean functions (`modelSupportsApplyPatch()`, `modelSupportsReplaceString()`, `modelCanUseApplyPatchExclusively()`, etc.) with hardcoded family-string checks and SHA-256 hashes of hidden model names.

Both of these are **code changes** that require a full PR, review, build, and deploy cycle. The goal is to make this **config-driven** so that onboarding a new model only requires editing configuration, not code.

---

## Repo

```
git clone --depth 1 https://github.com/microsoft/vscode-copilot-chat.git
```

---

## Current Architecture

### System 1: Prompt Registry (`PromptRegistry`)

**Key files:**
- `src/extension/prompts/node/agent/promptRegistry.ts` — the registry
- `src/extension/prompts/node/agent/allAgentPrompts.ts` — imports all prompt files to trigger registration
- `src/extension/prompts/node/agent/anthropicPrompts.tsx` — Anthropic-family prompts
- `src/extension/prompts/node/agent/geminiPrompts.tsx` — Gemini-family prompts
- `src/extension/prompts/node/agent/xAIPrompts.tsx` — xAI/Grok prompts
- `src/extension/prompts/node/agent/vscModelPrompts.tsx` — hidden/unreleased model prompts
- `src/extension/prompts/node/agent/zaiPrompts.tsx` — another hidden model
- `src/extension/prompts/node/agent/copilotCLIPrompt.tsx` — Copilot CLI prompt
- `src/extension/prompts/node/agent/openai/defaultOpenAIPrompt.tsx` — default GPT prompt
- `src/extension/prompts/node/agent/openai/gpt5Prompt.tsx` — GPT-5 specific
- `src/extension/prompts/node/agent/openai/gpt5CodexPrompt.tsx` — GPT-5 Codex
- `src/extension/prompts/node/agent/openai/gpt51Prompt.tsx` — GPT-5.1 specific
- `src/extension/prompts/node/agent/openai/gpt51CodexPrompt.tsx` — GPT-5.1 Codex
- `src/extension/prompts/node/agent/openai/gpt52Prompt.tsx` — GPT-5.2 specific
- `src/extension/prompts/node/agent/openai/gpt53CodexPrompt.tsx` — GPT-5.3 Codex specific

**How it works:**

Each prompt file defines:
1. A prompt resolver class implementing `IAgentPrompt` with a `static familyPrefixes` array (e.g. `['claude', 'Anthropic']`) and/or a `static matchesModel(endpoint)` function
2. One or more TSX prompt components (system prompt, reminder instructions, etc.)
3. Calls `PromptRegistry.registerPrompt(MyResolver)` at module load time

At runtime, `PromptRegistry.resolveAllCustomizations(instantiationService, endpoint)`:
1. Iterates `matchesModel` matchers first (checked via SHA-256 hash or family check)
2. Falls back to `familyPrefixes` prefix matching
3. Returns the matched prompt's `SystemPrompt`, `ReminderInstructions`, `ToolReferencesHint`, `CopilotIdentityRules`, `SafetyRules`, and `userQueryTagName`
4. If no match → uses `DefaultAgentPrompt` (generic GPT-4o-era prompt)

**The pain point:** Adding a new model means creating a new `*Prompt.tsx` file with a copy-paste-modified version of an existing prompt, a new resolver class, and registering it. For example, the Anthropic resolver has sub-branches:

```typescript
resolveSystemPrompt(endpoint: IChatEndpoint): SystemPrompt | undefined {
    if (this.isSonnet4(endpoint)) return DefaultAnthropicAgentPrompt;
    if (this.isClaude45(endpoint)) return Claude45DefaultPrompt;
    return Claude46DefaultPrompt;
}
```

Every new Claude version needs a new branch + a new TSX component.

### System 2: Chat Model Capabilities (`chatModelCapabilities.ts`)

**Key file:** `src/platform/endpoint/common/chatModelCapabilities.ts`

A bag of ~25 boolean functions that answer "does this model support X?":

| Function | What it controls |
|----------|-----------------|
| `modelSupportsApplyPatch(model)` | Can the model use apply_patch edit tool? |
| `modelSupportsReplaceString(model)` | Can the model use replace_string_in_file? |
| `modelSupportsMultiReplaceString(model)` | Can the model use multi_replace_string? |
| `modelCanUseReplaceStringExclusively(model)` | Can it skip insert_edit entirely? |
| `modelCanUseApplyPatchExclusively(model)` | Can it skip insert_edit entirely (via apply_patch)? |
| `modelSupportsSimplifiedApplyPatchInstructions(model)` | Use modern apply_patch instructions? |
| `modelNeedsStrongReplaceStringHint(model)` | Add extra prompt verbiage for replace_string? |
| `modelShouldUseReplaceStringHealing(model)` | Auto-heal incorrect edits? |
| `modelPrefersInstructionsInUserMessage(model)` | Put instructions in user msg instead of system? |
| `modelPrefersInstructionsAfterHistory(model)` | Put instructions after conversation history? |
| `modelPrefersJsonNotebookRepresentation(model)` | Use JSON format for notebooks? |
| `modelCanUseMcpResultImageURL(model)` | Accept image URLs in MCP tool results? |
| `modelCanUseImageURL(model)` | Accept image URLs in requests? |
| `isAnthropicFamily(model)` | Is this a Claude model? |
| `isGeminiFamily(model)` | Is this a Gemini model? |
| `isGpt5PlusFamily(model)` | Is this GPT-5 or newer? |
| `isGptCodexFamily(model)` | Is this a Codex variant? |
| `getVerbosityForModelSync(model)` | What verbosity level to use? |

**How they're implemented:** Each function has hardcoded family string checks like:

```typescript
export function modelSupportsApplyPatch(model): boolean {
    if (isVSCModelC(model)) return false;
    return (model.family.startsWith('gpt') && !model.family.includes('gpt-4o'))
        || model.family === 'o4-mini'
        || isGpt52CodexFamily(model.family)
        || isGpt53Codex(model.family)
        || isVSCModelA(model)
        || isVSCModelB(model)
        || isGpt52Family(model.family);
}
```

**Where these are consumed (non-test, non-definition):**
- `src/extension/intents/node/agentIntent.ts` — determines which edit tools to enable for a model
- `src/extension/intents/node/editCodeIntent2.ts` — same
- `src/extension/prompts/node/agent/defaultAgentInstructions.tsx` — conditional prompt sections
- `src/extension/prompts/node/panel/conversationHistory.tsx` — instruction ordering
- `src/extension/prompts/node/panel/editCodePrompt.tsx`, `editCodePrompt2.tsx`, `notebookInlinePrompt.tsx` — instruction ordering + edit reminders
- `src/extension/prompts/node/panel/toolCalling.tsx` — MCP image URL support
- `src/extension/prompts/node/panel/image.tsx` — image URL support
- `src/extension/prompts/node/base/instructionMessage.tsx` — system vs user message placement
- `src/extension/tools/node/editFileToolResult.tsx` — retry messages
- `src/extension/tools/node/abstractReplaceStringTool.tsx` — edit healing
- `src/platform/notebook/common/alternativeContent.ts` — notebook representation
- `src/extension/prompts/node/agent/summarizedConversationHistory.tsx` — thinking block handling

**The pain point:** Adding a new model means adding it to 5-10 of these functions with `|| model.family === 'new-model'`. Some models use SHA-256 hashes of the family name (for unreleased models), making it even harder to understand what model a hash refers to.

---

## Proposed Design: Model Profiles with Inheritance

### Core Ideas

Three concepts that compound to make this readable, maintainable, and extensible:

1. **Profile inheritance (`extends`)** — models inherit from a base archetype and only override what's different. Adding a new Claude that behaves like existing ones = one line.
2. **Higher-level concepts instead of raw booleans** — instead of 15 separate boolean flags, use ~5 meaningful dimensions (edit strategy, instruction placement, etc.) that expand to the right flag combinations internally.
3. **Self-documenting profiles** — each profile has a `description` field explaining what's special about this model. The "why" lives next to the "what".

### The Profile Type

```typescript
// src/platform/endpoint/common/modelProfiles.ts

/**
 * Edit strategy — determines which edit tools are available and how they're used.
 * Each strategy expands to the right combination of capability flags internally.
 *
 * - 'apply-patch': Model uses apply_patch exclusively (GPT-5.1+). Implies simplified instructions.
 * - 'apply-patch-with-insert-edit': Model uses apply_patch but also needs insert_edit fallback (GPT-5, o4-mini).
 * - 'multi-replace-string': Model uses multi_replace_string_in_file exclusively (Claude, hidden model E).
 * - 'replace-string': Model uses replace_string_in_file + insert_edit (Gemini, Grok).
 * - 'insert-edit-only': Model only uses insert_edit_into_file (GPT-4o, default).
 */
type EditStrategy =
    | 'apply-patch'
    | 'apply-patch-with-insert-edit'
    | 'multi-replace-string'
    | 'replace-string'
    | 'insert-edit-only';

/**
 * Where system instructions are placed in the conversation.
 *
 * - 'system-before-history': System message before conversation history (default, most models).
 * - 'system-after-history': System message after conversation history (claude-3.5-sonnet).
 * - 'user-message': Instructions placed in a user message instead of system (claude-3.5-sonnet).
 */
type InstructionPlacement =
    | 'system-before-history'
    | 'system-after-history'
    | 'user-message';

interface ModelProfile {
    /** Base profile to inherit from. Only override what's different. */
    extends?: string;

    /** Human-readable explanation of what's special about this model. */
    description?: string;

    /** Which registered prompt variant to use for the system prompt. */
    promptVariant?: string;

    /** How this model edits code. See EditStrategy docs. */
    editStrategy?: EditStrategy;

    /** Where to place instructions relative to conversation history. */
    instructionPlacement?: InstructionPlacement;

    /** Whether the model needs extra prompt verbiage to prefer replace_string. */
    replaceStringHint?: 'none' | 'strong';

    /** Whether to auto-heal incorrect replace_string edits. */
    replaceStringHealing?: boolean;

    /** Image support flags. */
    imageSupport?: {
        /** Can accept image URLs in requests. */
        urls?: boolean;
        /** Can accept image URLs in MCP tool results. */
        mcpResults?: boolean;
    };

    /** Notebook representation format. */
    notebookFormat?: 'json' | 'markdown';

    /** Response verbosity hint. */
    verbosity?: 'low' | 'medium' | 'high';
}
```

### The Profile Registry

```typescript
// src/platform/endpoint/common/modelProfiles.ts

/**
 * MODEL PROFILES — the single source of truth for how every model behaves.
 *
 * To onboard a new model: add one entry here.
 * Prefix keys starting with '_' are base archetypes (not matched directly).
 * Concrete model keys are matched against model.family using longest-prefix-first.
 *
 * Resolution: settings override → concrete profile → inherited base → DEFAULT_PROFILE
 */
const MODEL_PROFILES: Record<string, ModelProfile> = {

    // =========================================================================
    // BASE ARCHETYPES (prefixed with _ so they're never matched directly)
    // =========================================================================

    '_anthropic': {
        description: 'Base Anthropic archetype — multi-replace-string, no MCP image URLs',
        promptVariant: 'anthropic-default',
        editStrategy: 'multi-replace-string',
        instructionPlacement: 'system-before-history',
        replaceStringHint: 'none',
        replaceStringHealing: false,
        imageSupport: { urls: true, mcpResults: false },
        notebookFormat: 'markdown',
    },

    '_openai-legacy': {
        description: 'Base OpenAI archetype for GPT-4o era — insert-edit only',
        promptVariant: 'openai-default',
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
        promptVariant: 'gemini',
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

    'claude-sonnet-4': {
        extends: '_anthropic',
        description: 'Claude Sonnet 4 — dedicated prompt variant',
        promptVariant: 'anthropic-sonnet4',
    },

    'claude-4.5': {
        extends: '_anthropic',
        description: 'Claude 4.5 — dedicated prompt variant',
        promptVariant: 'anthropic-claude45',
    },

    'claude-3.5-sonnet': {
        extends: '_anthropic',
        description: 'Claude 3.5 Sonnet — instructions in user message, after history',
        instructionPlacement: 'user-message',
        // Note: user-message implies after-history for this model
    },

    'claude': {
        extends: '_anthropic',
        description: 'Catch-all for Claude models not matched above',
    },

    // =========================================================================
    // OPENAI MODELS
    // =========================================================================

    'gpt-5.3-codex': {
        extends: '_openai-modern',
        description: 'GPT-5.3 Codex — dedicated prompt, low verbosity',
        promptVariant: 'gpt53-codex',
        verbosity: 'low',
    },

    'gpt-5.2-codex': {
        extends: '_openai-modern',
        description: 'GPT-5.2 Codex',
        promptVariant: 'gpt52',
    },

    'gpt-5.2': {
        extends: '_openai-modern',
        description: 'GPT-5.2',
        promptVariant: 'gpt52',
    },

    'gpt-5.1-codex': {
        extends: '_openai-modern',
        description: 'GPT-5.1 Codex — dedicated prompt, low verbosity',
        promptVariant: 'gpt51-codex',
        verbosity: 'low',
    },

    'gpt-5.1': {
        extends: '_openai-modern',
        description: 'GPT-5.1 — dedicated prompt, low verbosity',
        promptVariant: 'gpt51',
        verbosity: 'low',
    },

    'gpt-5-codex': {
        extends: '_openai-modern',
        description: 'GPT-5 Codex — apply-patch with insert-edit fallback',
        promptVariant: 'gpt5-codex',
        editStrategy: 'apply-patch-with-insert-edit',
    },

    'gpt-5-mini': {
        extends: '_openai-modern',
        description: 'GPT-5 Mini — low verbosity',
        promptVariant: 'gpt5',
        verbosity: 'low',
    },

    'gpt-5': {
        extends: '_openai-modern',
        description: 'GPT-5 — apply-patch with insert-edit fallback',
        promptVariant: 'gpt5',
        editStrategy: 'apply-patch-with-insert-edit',
    },

    'o4-mini': {
        extends: '_openai-modern',
        description: 'o4-mini — apply-patch with insert-edit fallback, JSON notebooks',
        editStrategy: 'apply-patch-with-insert-edit',
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
        description: 'Gemini 3 — can use replace-string exclusively',
        // inherits everything from _gemini
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
        description: 'xAI Grok Code — replace-string, can use exclusively',
        promptVariant: 'xai',
        editStrategy: 'replace-string',
        instructionPlacement: 'system-before-history',
        replaceStringHint: 'none',
        replaceStringHealing: false,
        imageSupport: { urls: true, mcpResults: true },
        notebookFormat: 'markdown',
    },
};
```

### How EditStrategy Expands to Raw Flags

The old `modelSupportsXxx()` functions still exist as the public API. Internally they delegate to the profile, and `editStrategy` expands like this:

```typescript
// Internal expansion — lives in one place, tested once
function expandEditStrategy(strategy: EditStrategy): EditCapabilities {
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
                canUseApplyPatchExclusively: false,  // needs insert-edit fallback
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
```

### Profile Resolution

```typescript
const DEFAULT_PROFILE: Required<ModelProfile> = {
    extends: undefined,
    description: 'Default profile for unknown models',
    promptVariant: 'openai-default',
    editStrategy: 'insert-edit-only',
    instructionPlacement: 'system-before-history',
    replaceStringHint: 'none',
    replaceStringHealing: false,
    imageSupport: { urls: true, mcpResults: true },
    notebookFormat: 'markdown',
    verbosity: undefined,
};

/**
 * Resolve a fully-merged profile for a model.
 * Chain: settings override → concrete profile → inherited base(s) → DEFAULT_PROFILE
 */
function resolveProfile(model: IChatEndpoint | LanguageModelChat): ResolvedModelProfile {
    const family = model.family;
    const settingsOverrides = configService.getConfig(ConfigKey.Advanced.ModelProfiles);

    // 1. Find matching hardcoded profile (longest prefix first)
    const hardcoded = findProfileByLongestPrefix(family, MODEL_PROFILES);

    // 2. Find settings override (exact match, then prefix match)
    const settingsProfile = settingsOverrides?.[family]
        ?? findProfileByLongestPrefix(family, settingsOverrides ?? {});

    // 3. Resolve inheritance chain: walk `extends` pointers
    const chain = resolveInheritanceChain(hardcoded);

    // 4. Merge: DEFAULT_PROFILE ← base(s) ← concrete ← settings override
    return deepMerge(DEFAULT_PROFILE, ...chain, settingsProfile ?? {});
}

function resolveInheritanceChain(profile: ModelProfile | undefined): ModelProfile[] {
    const chain: ModelProfile[] = [];
    let current = profile;
    const visited = new Set<string>();  // cycle detection
    while (current) {
        chain.unshift(current);
        if (!current.extends || visited.has(current.extends)) break;
        visited.add(current.extends);
        current = MODEL_PROFILES[current.extends];
    }
    return chain;
}
```

---

## Implementation Steps

### Step 1: Create the ModelProfile type and registry

**File:** Create `src/platform/endpoint/common/modelProfiles.ts`

- Define `ModelProfile` interface, `EditStrategy`, `InstructionPlacement` types
- Define `MODEL_PROFILES` table (populated from current `chatModelCapabilities.ts` logic)
- Implement `resolveProfile()` with inheritance chain resolution
- Implement `expandEditStrategy()` for the strategy→flags expansion
- Export `getModelProfile(model)` as the main public API
- Export `DEFAULT_PROFILE` for unknown models

### Step 2: Populate MODEL_PROFILES from current chatModelCapabilities.ts

Go through every function in `chatModelCapabilities.ts` and translate the boolean logic into profile entries. This is mechanical:

For each model family currently checked across the ~15 functions:
1. Determine which `editStrategy` it maps to
2. Set `instructionPlacement`, `replaceStringHint`, `replaceStringHealing`, `imageSupport`, `notebookFormat`, `verbosity`
3. Set `promptVariant` to match what `PromptRegistry` currently resolves for that family

**Hidden models (SHA-256 hashes):** The profile registry should support hash-based keys as an escape hatch. Add a `familyHash` field to `ModelProfile`, or resolve hashes to their actual family strings internally. The hash lookup in `findProfileByLongestPrefix` can check `getCachedSha256Hash(family)` against hash-keyed profiles.

### Step 3: Replace chatModelCapabilities.ts functions with profile lookups

Rewrite each exported function as a thin wrapper:

```typescript
// These function SIGNATURES don't change — all existing callsites keep working

export function modelSupportsApplyPatch(model: LanguageModelChat | IChatEndpoint): boolean {
    return expandEditStrategy(getModelProfile(model).editStrategy).supportsApplyPatch;
}

export function modelSupportsReplaceString(model: LanguageModelChat | IChatEndpoint): boolean {
    return expandEditStrategy(getModelProfile(model).editStrategy).supportsReplaceString;
}

export function modelPrefersInstructionsInUserMessage(modelFamily: string): boolean {
    // Note: this function takes a string, not a model object — handle both
    return getModelProfileByFamily(modelFamily).instructionPlacement === 'user-message';
}

export function modelPrefersInstructionsAfterHistory(modelFamily: string): boolean {
    const placement = getModelProfileByFamily(modelFamily).instructionPlacement;
    return placement === 'system-after-history' || placement === 'user-message';
}

export function modelNeedsStrongReplaceStringHint(model: LanguageModelChat | IChatEndpoint): boolean {
    return getModelProfile(model).replaceStringHint === 'strong';
}

export function getVerbosityForModelSync(model: IChatEndpoint): 'low' | 'medium' | 'high' | undefined {
    return getModelProfile(model).verbosity;
}

// Family-check functions also become profile lookups
export function isAnthropicFamily(model: LanguageModelChat | IChatEndpoint): boolean {
    return getModelProfile(model).promptVariant?.startsWith('anthropic') ?? false;
}
```

**This step is a no-op refactor** — all ~15 callsites across `agentIntent.ts`, `editCodeIntent2.ts`, `abstractReplaceStringTool.tsx`, prompt TSX files, etc. continue to call the same functions with the same signatures.

### Step 4: Register promptVariant names

Create a mapping from `promptVariant` strings to TSX components:

```typescript
// In promptRegistry.ts or a new promptVariantMap.ts

const PROMPT_VARIANTS: Record<string, AgentPromptCustomizations> = {
    'anthropic-sonnet4':  { SystemPrompt: DefaultAnthropicAgentPrompt, ReminderInstructionsClass: AnthropicReminderInstructions, ... },
    'anthropic-claude45': { SystemPrompt: Claude45DefaultPrompt, ReminderInstructionsClass: AnthropicReminderInstructions, ... },
    'anthropic-default':  { SystemPrompt: Claude46DefaultPrompt, ReminderInstructionsClass: AnthropicReminderInstructions, ... },
    'openai-default':     { SystemPrompt: DefaultOpenAIAgentPrompt, ... },
    'gpt5':               { SystemPrompt: DefaultGpt5AgentPrompt, ... },
    'gpt51':              { SystemPrompt: Gpt51AgentPrompt, ... },
    'gpt51-codex':        { SystemPrompt: Gpt51CodexAgentPrompt, ... },
    'gpt52':              { SystemPrompt: Gpt52AgentPrompt, ... },
    'gpt53-codex':        { SystemPrompt: Gpt53CodexAgentPrompt, ... },
    'gpt5-codex':         { SystemPrompt: Gpt5CodexAgentPrompt, ... },
    'gemini':             { SystemPrompt: DefaultGeminiAgentPrompt, ... },
    'xai':                { SystemPrompt: DefaultGrokCodeFastAgentPrompt, ... },
};
```

Update `PromptRegistry.resolveAllCustomizations()` to:
1. Call `getModelProfile(endpoint)` to get the profile
2. Look up `profile.promptVariant` in `PROMPT_VARIANTS`
3. Fall back to the default prompt if not found

The existing `familyPrefixes` / `matchesModel` / `registerPrompt` pattern can be kept for backward compatibility during migration — profiles take priority, and the old registry is the fallback.

### Step 5: Add settings schema for `models.profiles`

**File:** `package.json` under `contributes.configuration`

```json
"github.copilot.chat.models.profiles": {
    "type": "object",
    "default": {},
    "markdownDescription": "Override model behavior profiles. Keys are model family prefixes, values are partial profiles merged on top of built-in defaults. Use this to change how a model edits code, where instructions are placed, which prompt variant is used, etc.",
    "additionalProperties": {
        "type": "object",
        "properties": {
            "extends":              { "type": "string", "description": "Base profile to inherit from (e.g. '_anthropic', '_openai-modern')" },
            "description":          { "type": "string", "description": "Human-readable note about this profile" },
            "promptVariant":        { "type": "string", "description": "Named prompt variant (e.g. 'anthropic-default', 'gpt51')" },
            "editStrategy":         { "type": "string", "enum": ["apply-patch", "apply-patch-with-insert-edit", "multi-replace-string", "replace-string", "insert-edit-only"], "description": "How this model edits code" },
            "instructionPlacement": { "type": "string", "enum": ["system-before-history", "system-after-history", "user-message"], "description": "Where to place system instructions" },
            "replaceStringHint":    { "type": "string", "enum": ["none", "strong"], "description": "Extra prompt verbiage for replace_string" },
            "replaceStringHealing": { "type": "boolean", "description": "Auto-heal incorrect replace_string edits" },
            "imageSupport":         { "type": "object", "properties": { "urls": { "type": "boolean" }, "mcpResults": { "type": "boolean" } } },
            "notebookFormat":       { "type": "string", "enum": ["json", "markdown"], "description": "Notebook representation format" },
            "verbosity":            { "type": "string", "enum": ["low", "medium", "high"], "description": "Response verbosity hint" }
        },
        "additionalProperties": false
    }
}
```

**File:** `src/platform/configuration/common/configurationService.ts`

```typescript
export const ModelProfiles = defineSetting<Record<string, Partial<ModelProfile>>>('chat.models.profiles', ConfigType.Simple, {});
```

### Step 6: Add config definition and settings override loading

In `resolveProfile()` (from step 1), merge user settings on top of the hardcoded profile:

```typescript
// Settings overrides are MERGED — specifying just `editStrategy` keeps everything else from hardcoded
const settingsProfile = configService.getConfig(ConfigKey.Advanced.ModelProfiles)?.[family];
return deepMerge(DEFAULT_PROFILE, ...inheritanceChain, settingsProfile ?? {});
```

---

## What Changes for the "Add a New Model" Workflow

### Before (today)
1. Create a new `*Prompt.tsx` file with system prompt (~200-400 lines)
2. Create a new resolver class with `familyPrefixes` and/or `matchesModel`
3. Call `PromptRegistry.registerPrompt()`
4. Import the file in `allAgentPrompts.ts`
5. Add the model to 5-10 functions in `chatModelCapabilities.ts`
6. PR, review, build, deploy

### After — Case 1: New model behaves like an existing archetype (most common)
```typescript
// One line in MODEL_PROFILES — no code, no new files, can be done via settings for eval
'some-new-model': { extends: '_anthropic', description: 'New model — standard Anthropic behavior' },
```

### After — Case 2: New model needs a capability tweak
```typescript
// One line, override just what changed
'gpt-some-new-variant': { extends: '_openai-modern', editStrategy: 'multi-replace-string', description: 'Hypothetical new model that switched to replace-string' },
```

### After — Case 3: New model needs a new prompt
```typescript
// One line in MODEL_PROFILES + write the new TSX component + register in PROMPT_VARIANTS
'gpt-some-new-variant': { extends: '_openai-modern', promptVariant: 'gpt-some-new-variant', description: 'Hypothetical new model needing custom prompt' },
```

### For eval (zero code changes)
Set in `settings.json`:
```jsonc
"github.copilot.chat.models.profiles": {
    "new-model-family": {
        "extends": "_anthropic",
        "promptVariant": "anthropic-default",
        "editStrategy": "apply-patch",
        "description": "Testing apply-patch with anthropic prompt on new model"
    }
}
```

## Testing

### Existing Snapshot Tests (Critical Safety Net)

There are **comprehensive prompt snapshot tests** that capture the fully rendered system prompt for every model family. These are the primary safety net for this refactor.

**Location:** `src/extension/prompts/node/agent/test/agentPrompt.spec.tsx`

**What it does:** Iterates over 15+ model families, creates a `MockEndpoint` with each family, runs the full prompt rendering pipeline (`PromptRegistry.resolveAllCustomizations()` → `PromptRenderer`), and snapshots the complete rendered prompt.

**Snapshot directories:** `src/extension/prompts/node/agent/test/__snapshots__/agentPrompts-{family}/` — 43 directories, ~10 scenarios each (simple_case, all_tools, tool_use, cache_BPs, etc.).

**Tested model families:** `default`, `gpt-4.1`, `gpt-5`, `gpt-5-mini`, `gpt-5-codex`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `claude-haiku-4.5`, `claude-sonnet-4.5`, `claude-opus-4.5`, `claude-opus-4.6`, `claude-opus-4.6-fast`, `gemini-2.0-flash`, `grok-code-fast-1`.

**How to use during refactor:**
1. Run snapshot tests BEFORE making changes to establish baseline: `npx vitest run src/extension/prompts/node/agent/test/agentPrompt.spec.tsx`
2. Make the profile registry changes
3. Run snapshot tests AGAIN — the refactor should produce **zero snapshot changes**
4. If any snapshot diffs appear, the diff shows exactly which model family and which part of the prompt changed — investigate before proceeding

### Additional Tests to Add

- **Profile resolution tests:** Unit test `resolveProfile()` with inheritance chains, verify correct merging.
- **EditStrategy expansion tests:** Verify `expandEditStrategy()` produces the same boolean flags as the current `chatModelCapabilities.ts` functions for each model.
- **Settings override tests:** Verify that settings profiles merge correctly and override the right fields.
- **Round-trip test:** For each model family in the snapshot suite, assert that `getModelProfile(family).promptVariant` resolves to the same prompt component that the old `PromptRegistry` would have selected.

---

| File | Purpose |
|------|---------|
| `src/platform/endpoint/common/chatModelCapabilities.ts` | Current: hardcoded capability functions. Refactor target — functions become thin wrappers. |
| `src/platform/endpoint/common/modelProfiles.ts` | **NEW**: Model profile registry + resolution logic |
| `src/extension/prompts/node/agent/promptRegistry.ts` | Current: family-prefix → prompt component routing. Updated to use `promptVariant` from profile. |
| `src/extension/prompts/node/agent/allAgentPrompts.ts` | Imports all prompt files to trigger registration |
| `src/extension/prompts/node/agent/anthropicPrompts.tsx` | Anthropic prompt variants — TSX unchanged, resolver class can be removed |
| `src/extension/prompts/node/agent/openai/gpt5*.tsx` | OpenAI prompt variants — TSX unchanged, resolver classes can be removed |
| `src/extension/prompts/node/agent/geminiPrompts.tsx` | Gemini prompt variants — TSX unchanged |
| `src/extension/prompts/node/agent/defaultAgentInstructions.tsx` | Shared prompt building blocks — unchanged |
| `src/extension/intents/node/agentIntent.ts` | Consumes capability functions — unchanged (same function signatures) |
| `src/extension/intents/node/editCodeIntent2.ts` | Consumes capability functions — unchanged |
| `src/extension/tools/node/abstractReplaceStringTool.tsx` | Consumes capability functions — unchanged |
| `src/platform/configuration/common/configurationService.ts` | Add `ModelProfiles` setting definition |
| `package.json` | Add JSON schema for `models.profiles` |

---

## Caveats

1. **TSX prompt components still exist** — this plan doesn't eliminate model-specific prompts. Models genuinely need different instructions. What it eliminates is the routing boilerplate and capability boolean spaghetti.

2. **Hidden model hashes** — models identified by SHA-256 hashes in `chatModelCapabilities.ts` need to be handled. Options: (a) add a `familyHash` field to `ModelProfile` that is checked during resolution, (b) convert hash-keyed entries to use the actual family strings internally, or (c) keep the hash-based `isHiddenModelX()` functions as a thin escape hatch that checks the profile first and falls back to hash matching.

3. **Prefix ordering** — `findProfileByLongestPrefix` must sort by key length descending so `'gpt-5.3-codex'` matches before `'gpt-5'` which matches before `'gpt'`. This is critical.

4. **Settings merge semantics** — partial profile overrides in settings are **merged**, not replaced. Setting `{ editStrategy: 'apply-patch' }` keeps all other fields from the hardcoded profile. Use `deepMerge` with the inheritance chain.

5. **Backward compatibility** — during migration, keep the old `PromptRegistry.registerPrompt()` pattern working alongside profiles. Profiles take priority; if no profile has a `promptVariant`, fall back to the old family-prefix matching. This allows incremental migration.

6. **`isAnthropicFamily()` and similar** — these are used as general "is this model from vendor X?" checks, not just capability checks. They should still work after the refactor. Consider keeping family-based checks as simple `family.startsWith()` checks rather than routing through the profile system, or derive them from the profile's `promptVariant` prefix.

7. **This is `vscode-copilot-chat` only** — the `vscode` editor repo doesn't have model-specific prompts or capability checks. No changes needed there.
