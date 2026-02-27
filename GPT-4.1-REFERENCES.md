# GPT 4.1 References in Developer-Facing UX

This document lists all references to GPT 4.1 found in the codebase, categorized by their usage and context.

## User-Facing Documentation

### CHANGELOG.md

**Location:** `/CHANGELOG.md`

#### Line 217 - Auto Model Selection Description
- **Context:** Describes automatic model selection feature
- **Usage:** Explains that Auto mode will choose between Claude Sonnet 4, GPT-5, GPT-5 mini, **GPT-4.1**, and Gemini Pro 2.5
- **Audience:** End users learning about the Auto model selection feature

#### Line 840 - Chat Mode Import Example
- **Context:** Documentation for importing chat mode files from external links
- **Usage:** Uses "Burke's **GPT 4.1** Beast Mode" as an example of a chat mode
- **Audience:** Users learning to import custom chat modes

#### Line 1533-1539 - Feature Announcements
- **Context:** Version release notes announcing GPT 4.1 features
- **Usage:** 
  - Line 1533: "Faster agent mode edits with **GPT 4.1**" (heading)
  - Line 1535: Describes apply patch editing format support when using **GPT 4.1** and o4-mini
  - Line 1537: "Use **GPT 4.1** as the base model" (heading)
  - Line 1539: Announces that the base model is now updated to **GPT-4.1**
- **Audience:** Users reading release notes

#### Line 1634 - Vision Capability Limitation
- **Context:** Note about language model limitations with tool output
- **Usage:** Explains that although **GPT-4.1** has vision capability, it doesn't currently support reading images from tools
- **Audience:** Users working with vision features

## Configuration and Settings

### package.nls.json

**Location:** `/package.nls.json:389`

- **Key:** `github.copilot.config.agentHistorySummarizationForceGpt41`
- **Description:** "Force **GPT-4.1** for agent history summarization."
- **Usage:** Localized description for a configuration setting
- **Audience:** Users viewing settings in VS Code UI

## Prompt File Context Service

### promptFileContextService.ts

**Location:** `/src/extension/promptFileContext/vscode-node/promptFileContextService.ts`

#### Line 25 - Default Models List
- **Context:** Private models array initialization
- **Code:** `private models: string[] = ['GPT-4.1', 'GPT-4o'];`
- **Usage:** Default models list for prompt file context suggestions

#### Line 130 - Agent Prompt Example
- **Context:** Example prompt template generation
- **Code:** `model: ${this.models[0] || 'GPT-4.1'}`
- **Usage:** Provides **GPT-4.1** as default model in generated agent prompt examples
- **Audience:** Developers creating custom agent prompts

#### Line 184, 191 - Handoffs Documentation
- **Context:** IntelliSense completion documentation for prompt file metadata
- **Code:** 
  - Line 184: Description mentions format `Model Name (vendor)` with example `GPT-4.1 (copilot)`
  - Line 191: Example shows `model: GPT-4.1 (copilot)`
- **Usage:** Provides guidance on model specification format in handoffs configuration
- **Audience:** Developers configuring custom agents with handoffs

#### Line 201, 208 - Custom Agent Example
- **Context:** Complete custom agent file example
- **Code:** 
  - Line 201: `model: GPT-4.1`
  - Line 208: `model: GPT-4.1 (copilot)`
- **Usage:** Shows **GPT-4.1** as the model in example agent configurations
- **Audience:** Developers creating custom agent files

## Code Comments and Implementation Notes

### toolUtils.ts

**Location:** `/src/extension/tools/node/toolUtils.ts`

#### Lines 52-53 - JSDoc Comment
- **Context:** Documentation for `inputGlobToPattern` function parameter
- **Content:** "The language model family (e.g., '**gpt-4.1**'). If set to '**gpt-4.1**', a workaround is applied: **GPT-4.1** struggles to append '/**' to patterns..."
- **Usage:** Explains a model-specific workaround for glob pattern handling
- **Audience:** Developers working on file search/tool utilities

#### Lines 75-78 - Implementation Comment
- **Context:** Workaround implementation
- **Content:** "For **gpt-4.1**, it struggles to append /** to the pattern itself, so here we work around it by adding a second pattern with /** appended."
- **Usage:** Explains why special handling is needed for GPT-4.1
- **Audience:** Developers maintaining file search tools

### summarizedConversationHistory.tsx

**Location:** `/src/extension/prompts/node/agent/summarizedConversationHistory.tsx`

#### Line 521 - Endpoint Retrieval
- **Context:** Getting GPT-4.1 endpoint for conversation summarization
- **Code:** `const gpt41Endpoint = await this.endpointProvider.getChatEndpoint('gpt-4.1');`
- **Usage:** Explicitly requests GPT-4.1 endpoint
- **Audience:** Developers working on conversation history

#### Line 833 - Conditional Rendering
- **Context:** Model-specific reminder instructions
- **Code:** `{this.props.endpoint.family === 'gpt-4.1' && <Tag name='reminderInstructions'>`
- **Usage:** Includes special reminder instructions only when using **gpt-4.1**
- **Audience:** Developers working on prompts/agent instructions

### simpleSummarizedHistoryPrompt.tsx

**Location:** `/src/extension/prompts/node/agent/simpleSummarizedHistoryPrompt.tsx:86`

- **Context:** Similar to above, conditional rendering based on model family
- **Code:** `{this.props.endpoint.family === 'gpt-4.1' && <Tag name='reminderInstructions'>`
- **Usage:** Model-specific prompt instructions for GPT-4.1
- **Audience:** Developers working on simplified history prompts

### defaultAgentInstructions.tsx

**Location:** `/src/extension/prompts/node/agent/defaultAgentInstructions.tsx:283`

- **Context:** Comment in JSX
- **Content:** `{/* Include the rest of the existing tool instructions but maintain GPT 4.1 specific workflow */}`
- **Usage:** Developer note about maintaining GPT 4.1-specific workflow
- **Audience:** Developers modifying agent instructions

### agentPrompt.tsx

**Location:** `/src/extension/prompts/node/agent/agentPrompt.tsx:561`

- **Context:** Comment about line number formatting
- **Content:** `// Should this include column numbers too? This confused gpt-4.1 and it read the wrong line numbers, need to find the right format.`
- **Usage:** Documents a formatting decision based on GPT-4.1 behavior
- **Audience:** Developers working on editor context rendering

### alternativeContent.ts

**Location:** `/src/platform/notebook/common/alternativeContent.ts:65`

- **Context:** Comment about JSON format preference
- **Content:** `// GPT 4.1 supports apply_patch, such models work best with JSON format (doesn't have great support for XML yet, thats being worked on).`
- **Usage:** Explains format preference for apply_patch with GPT-4.1
- **Audience:** Developers working on notebook alternative content

### parser.ts (applyPatch)

**Location:** `/src/extension/tools/node/applyPatch/parser.ts`

#### Line 40 - Comment
- **Content:** `// Max edit distance allowed per line to allow for fuzzy matching context. 4.1`
- **Usage:** Note that 4.1 is the max edit distance (not referring to GPT model)
- **Note:** This appears to be numeric value, not a GPT reference

#### Line 652 - Comment
- **Content:** `* 4.1 omits the operation for outdented lines, and can attempt to fix this`
- **Usage:** Documents GPT-4.1 specific behavior with outdented lines
- **Audience:** Developers working on patch parsing

### recentEditsReducer.ts

**Location:** `/src/extension/completions-core/vscode-node/lib/src/prompt/recentEdits/recentEditsReducer.ts:143`

- **Content:** `* Turn a DiffHunk into an Aider's Diff string. OpenAI recommends this for 4.1 models.`
- **Usage:** References OpenAI's recommendation for diff format with 4.1 models
- **Audience:** Developers working on recent edits functionality

## Type Definitions and Enums

### configurationService.ts

**Location:** `/src/platform/configuration/common/configurationService.ts:564`

- **Context:** CHAT_MODEL enum definition
- **Code:** `GPT41 = 'gpt-4.1-2025-04-14',`
- **Usage:** Defines the full model identifier for GPT-4.1
- **Audience:** Developers using the CHAT_MODEL enum

### endpointProvider.ts

**Location:** `/src/platform/endpoint/common/endpointProvider.ts:119`

- **Context:** Type definition
- **Code:** `export type ChatEndpointFamily = 'gpt-4.1' | 'gpt-5-mini' | 'copilot-base' | 'copilot-fast';`
- **Usage:** Defines **gpt-4.1** as a valid endpoint family type
- **Audience:** Developers working with chat endpoints

### modelMetadataFetcher.ts

**Location:** `/src/platform/endpoint/node/modelMetadataFetcher.ts`

#### Lines 169-170 - Fallback Logic
- **Context:** Model family resolution
- **Code:** 
  ```typescript
  if (family === 'gpt-4.1') {
      resolvedModel = this._familyMap.get('gpt-4.1')?.[0] ?? this._familyMap.get('gpt-4o')?.[0];
  }
  ```
- **Usage:** Provides fallback from GPT-4.1 to GPT-4o if needed
- **Audience:** Developers working on model metadata

## Test Files and Test Infrastructure

### Test Endpoint Configuration

**Location:** `/src/platform/endpoint/test/node/testEndpointProvider.ts`

#### Lines 202, 204
- **Context:** Default endpoint in test scenarios
- **Code:** 
  ```typescript
  requestOrFamilyOrModel = 'gpt-4.1';
  ...
  if (requestOrFamilyOrModel === 'gpt-4.1') {
  ```
- **Usage:** Uses **gpt-4.1** as default test endpoint
- **Audience:** Test infrastructure

### Unit Tests

Multiple test files use **gpt-4.1** for testing purposes:

#### findFiles.spec.tsx
- **Location:** `/src/extension/tools/node/test/findFiles.spec.tsx`
- **Lines:** 77, 78, 79, 86, 87, 94, 95, 103
- **Usage:** Test suite named `'gpt-4.1 model glob pattern'` with multiple test cases
- **Purpose:** Tests the glob pattern workaround for GPT-4.1

#### findTextInFilesTool.spec.tsx
- **Location:** `/src/extension/tools/node/test/findTextInFilesTool.spec.tsx`
- **Lines:** 122, 123, 124, 131, 132, 139, 140, 148
- **Usage:** Similar test suite for text search with GPT-4.1 patterns
- **Purpose:** Tests glob pattern handling with GPT-4.1

#### feedbackGenerator.spec.ts
- **Location:** `/src/extension/prompt/node/test/feedbackGenerator.spec.ts`
- **Lines:** 741, 742, 757, 873, 899, 927, 979, 1041, 1070, 1104, 1137
- **Usage:** Test data using `'gpt-4.1-test'` as model identifier
- **Purpose:** Testing feedback generation with GPT-4.1

#### endpoints.test.ts
- **Location:** `/src/extension/test/vscode-node/endpoints.test.ts:88`
- **Code:** `assert.strictEqual(CHAT_MODEL.GPT41, 'gpt-4.1-2025-04-14', 'Incorrect GPT 41 model name, changing this will break requests.');`
- **Usage:** Validates the exact model string to ensure requests don't break
- **Audience:** Developers maintaining endpoint consistency

#### languageModelAccess.test.ts
- **Location:** `/src/extension/conversation/vscode-node/test/languageModelAccess.test.ts`
- **Lines:** 37, 67
- **Usage:** Gets **gpt-4.1** endpoint for testing language model access
- **Purpose:** Integration tests

#### applyPatch parser.spec.ts
- **Location:** `/src/extension/tools/test/node/applyPatch/parser.spec.ts`
- **Lines:** 192, 265, 371
- **Usage:** Comments about **4.1** specific behaviors in patch parsing tests
- **Purpose:** Documents GPT-4.1 quirks that tests handle

### Simulation Tests

Multiple simulation test files reference **gpt-4.1**:

- **newNotebookCell.stest.ts:** Lines 21, 60, 98 - Gets **gpt-4.1** endpoint
- **vscode-metaprompt.stest.ts:** Line 40 - Gets **gpt-4.1** endpoint  
- **workspace-metaprompt.stest.ts:** Line 54 - Gets **gpt-4.1** endpoint
- **agentPrompt.spec.tsx:** Line 36 - Test data with `'gpt-4.1'`

### Test Baselines and Snapshots

#### baseline.json
- **Location:** `/test/simulation/baseline.json`
- **Lines:** 129, 136, 143, 150, 157, 164
- **Usage:** Test case names include **"(gpt-4.1-2025-04-14)"** for `/review [inline]` tests
- **Purpose:** Baseline snapshots for code review inline tests

#### baseline.old.json
- **Location:** `/test/simulation/baseline.old.json`
- **Lines:** 255, 262, 269, 276, 283, 290
- **Usage:** Same as above, older baseline version

#### -review-inline.json
- **Location:** `/test/outcome/-review-inline.json`
- **Lines:** 3, 9, 15, 21, 27, 33
- **Usage:** Test outcome names with **"(gpt-4.1-2025-04-14)"**

#### defaultIntentRequestHandler.spec.ts.snap
- **Location:** `/src/extension/prompt/node/test/__snapshots__/defaultIntentRequestHandler.spec.ts.snap`
- **Multiple Lines:** Many occurrences of `"baseModel": "gpt-4.1-2025-04-14"` and `"model": "gpt-4.1-2025-04-14"`
- **Usage:** Snapshot test data showing expected model identifiers

## Code Implementation (Non-UX)

These are internal code uses that get GPT-4.1 endpoints but don't directly show "GPT-4.1" to users:

### Direct Endpoint Requests

Multiple files request **gpt-4.1** endpoints programmatically:

- **devContainerConfigGenerator.ts:** Line 52
- **feedbackGenerator.ts:** Line 57
- **codebaseToolCalling.ts:** Line 56
- **newNotebookTool.tsx:** Line 51 (with fallback: `options.model || 'gpt-4.1'`)
- **languageToolsProvider.tsx:** Line 33
- **commandToConfigConverter.tsx:** Line 54
- **promptRenderer.ts:** Line 215 (default endpoint)
- **codeMapper.ts:** Line 333 (with comment "use gpt-4.1 as fallback")
- **findTextInFilesResult.spec.tsx:** Line 38 (test)
- **toolTestUtils.tsx:** Line 26 (test utilities)

### Model Detection

**languageModelAccess.ts**

**Location:** `/src/extension/conversation/vscode-node/languageModelAccess.ts:80`

- **Code:** `if (name.includes('4.1') || name.includes('4-1')) {`
- **Usage:** Detects GPT-4.1 models from name strings
- **Purpose:** Model identification logic

## Summary Statistics

### By Category:

1. **User-Facing Documentation:** 6 locations (CHANGELOG.md)
2. **Configuration/Settings:** 1 location (package.nls.json)
3. **Prompt Context Service:** 5 locations (user-facing examples and defaults)
4. **Code Comments:** 8 locations (implementation notes)
5. **Type Definitions:** 3 locations (enums and types)
6. **Test Files:** 50+ locations (unit tests, integration tests, simulation tests)
7. **Code Implementation:** 13 locations (internal endpoint requests)

### Developer-Facing UX Locations:

The following are the most relevant **developer-facing UX** references:

1. **promptFileContextService.ts** - Provides IntelliSense examples and templates using GPT-4.1
2. **toolUtils.ts** - JSDoc comments explaining GPT-4.1 specific behavior
3. **Various prompt files** - Comments about GPT-4.1 specific behaviors and workarounds
4. **Configuration descriptions** - Settings that mention GPT-4.1 in their descriptions

### Key Patterns:

- **Default Model:** GPT-4.1 is used as the default/fallback model in many places
- **Model-Specific Workarounds:** Several workarounds exist for GPT-4.1 quirks (glob patterns, line numbers, outdented lines)
- **Examples and Templates:** GPT-4.1 appears in many code examples and templates for developers
- **Test Infrastructure:** Extensive test coverage using GPT-4.1 as the test model
