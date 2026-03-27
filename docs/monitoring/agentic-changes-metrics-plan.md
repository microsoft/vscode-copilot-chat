# OTel Backfill Plan: Agentic Change Metrics

> **Goal**: Backfill OpenTelemetry events/metrics for the key agent-mode metrics that we already track in MSFT telemetry — Accept Rate, Commit Survival, and Committed Characters — so GH can consume them from OTel.

## Current State

### What OTel already covers (agent trajectory)

| Signal | Type | File |
|--------|------|------|
| `invoke_agent` | Span | `src/extension/intents/node/toolCallingLoop.ts` |
| `chat` | Span | `src/extension/prompt/node/chatMLFetcher.ts` |
| `execute_tool` | Span | `src/extension/tools/vscode-node/toolsService.ts` |
| `execute_hook` | Span | `src/extension/chat/vscode-node/chatHookService.ts` |
| `copilot_chat.session.start` | Event | `src/platform/otel/common/genAiEvents.ts` |
| `copilot_chat.agent.turn` | Event | `src/platform/otel/common/genAiEvents.ts` |
| `copilot_chat.tool.call` | Event | `src/platform/otel/common/genAiEvents.ts` |
| `gen_ai.client.operation.duration` | Metric | `src/platform/otel/common/genAiMetrics.ts` |
| `gen_ai.client.token.usage` | Metric | `src/platform/otel/common/genAiMetrics.ts` |
| `copilot_chat.tool.call.count` | Counter | `src/platform/otel/common/genAiMetrics.ts` |
| `copilot_chat.tool.call.duration` | Metric | `src/platform/otel/common/genAiMetrics.ts` |
| `copilot_chat.agent.invocation.duration` | Metric | `src/platform/otel/common/genAiMetrics.ts` |
| `copilot_chat.agent.turn.count` | Metric | `src/platform/otel/common/genAiMetrics.ts` |
| `copilot_chat.time_to_first_token` | Metric | `src/platform/otel/common/genAiMetrics.ts` |
| `copilot_chat.session.count` | Counter | `src/platform/otel/common/genAiMetrics.ts` |

### Gap: No OTel coverage for agentic edit quality signals

The PowerBI dashboard tracks three key metrics computed from MSFT telemetry:
- **Accept Rate** — ratio of accepted vs. shown/rejected agentic edits
- **Commit Survival** — how much of AI-generated code survives over time (not reverted)
- **Committed Characters (ARC)** — count of AI-written characters retained unmodified

---

## Agentic Surfaces & Current OTel Coverage

We have **four agentic surfaces**, each with different OTel coverage levels:

| Surface | Description | OTel Coverage |
|---------|-------------|---------------|
| **Foreground Agent (Chat Agent mode)** | Panel chat with tool-calling loop | Partial — spans for `invoke_agent`, `chat`, `execute_tool`, but no user action/quality events |
| **Inline Chat** | `Ctrl+I` inline editing with AI | None — pure MSFT telemetry |
| **Background Agent (Copilot CLI)** | Worktree sessions, background tasks | Partial — spans bridged from CLI's own OTel, but no user action events |
| **Claude Code Agent** | Claude terminal agent | Good — hooks wrapped in OTel spans, but no edit quality metrics |
| **Cloud Sessions (CCA/Remote)** | Remote agent jobs (Copilot/Claude/Codex) | None — pure MSFT telemetry |

---

## Complete MSFT Telemetry Inventory to Backfill

### Surface 1: Panel Chat / Agent Mode User Actions

**Source**: `src/extension/conversation/vscode-node/userActions.ts`

| # | Event Name | Channel | Description | Key Properties | OTel? |
|---|-----------|---------|-------------|----------------|-------|
| 1 | `panel.edit.feedback` | MSFT+GH+Internal | **File-level accept/reject of agent edit** | `outcome` (accepted/rejected), `languageId`, `participant`, `requestId`, `hasRemainingEdits` | ❌ |
| 2 | `edit.hunk.action` | GH | **Hunk-level accept/reject** | `outcome`, `languageId`, `lineCount`, `linesAdded`, `linesRemoved`, `hasRemainingEdits` | ❌ |
| 3 | `panel.action.copy` | MSFT | User copies code block from response | `languageId`, `codeBlockIndex`, `characterCount`, `lineCount` | ❌ |
| 4 | `panel.action.insert` | MSFT | User inserts code block into editor | `languageId`, `codeBlockIndex`, `characterCount`, `newFile` | ❌ |
| 5 | `panel.action.followup` | MSFT | User clicks follow-up suggestion | `languageId`, `participant` | ❌ |
| 6 | `conversation.acceptedCopy` / `conversation.acceptedInsert` | GH | Extended copy/insert with model metadata | `participant`, `modelId`, `mode`, `totalCharacters`, `totalLines` | ❌ |
| 7 | `conversation.appliedCodeblock` | GH | User applies (keeps) a code block | `participant`, `modelId`, `totalLines`, `isAgent` | ❌ |
| 8 | `panel.action.vote` | MSFT | Thumbs up/down on chat response | `direction` (1=helpful/2=unhelpful), `participant`, `conversationId` | ❌ |
| 9 | `conversation.messageRating` | GH | Same vote to GH channel | `rating` (positive/negative), `messageId` | ❌ |

### Surface 2: Inline Chat (Ctrl+I)

**Source**: `src/extension/conversation/vscode-node/userActions.ts`

| # | Event Name | Channel | Description | Key Properties | OTel? |
|---|-----------|---------|-------------|----------------|-------|
| 10 | `inline.done` | MSFT | **Inline edit accepted/rejected** | `accepted` (0/1), `languageId`, `editCount`, `editLineCount`, `replyType`, `conversationId` | ❌ |
| 11 | `inline.trackEditSurvival` | MSFT | **Survival rate over time** | `survivalRateFourGram` (0-1), `survivalRateNoRevert` (0-1), `timeDelayMs`, `didBranchChange` | ❌ |

### Surface 3: Agent Edit Tools (survival tracking)

| # | Event Name | Channel | Source File | Description | Key Properties | OTel? |
|---|-----------|---------|------------|-------------|----------------|-------|
| 12 | `applyPatch.trackEditSurvival` | MSFT+GH+Internal | `src/extension/tools/node/applyPatchTool.tsx` | **apply_patch tool edit survival** | `survivalRateFourGram`, `survivalRateNoRevert`, `timeDelayMs`, `didBranchChange`, `requestSource: 'agent'` | ❌ |
| 13 | `codeMapper.trackEditSurvival` | MSFT+GH+Internal | `src/extension/tools/node/abstractReplaceStringTool.tsx` | **replace_string tool edit survival** | same as above, `mapper: 'stringReplaceTool'` | ❌ |
| 14 | `codeMapper.trackEditSurvival` | MSFT+GH+Internal | `src/extension/prompts/node/codeMapper/codeMapperService.ts` | **Code mapper (fast apply) survival** | same + `speculationRequestId`, `chatRequestModel`, `mapper` | ❌ |

### Surface 4: NES Inline Edits (survival + ARC)

| # | Event Name | Channel | Source File | Description | Key Properties | OTel? |
|---|-----------|---------|------------|-------------|----------------|-------|
| 15 | `reportInlineEditSurvivalRate` | MSFT+GH | `src/extension/inlineEdits/vscode-node/inlineCompletionProvider.ts` | **NES survival + ARC** | `survivalRateFourGram`, `timeDelayMs`, `arc` (committed characters), `didBranchChange` | ❌ |
| 16 | `provideInlineEdit` | MSFT+GH | `src/extension/inlineEdits/node/nextEditProviderTelemetry.ts` | **NES inline edit provided** (shown/accepted/rejected) | `acceptance`, `isShown`, `status`, `languageId` | ❌ |

### Surface 5: Agent Mode Internals

**Source**: `src/extension/intents/node/agentIntent.ts`, `toolCallingLoop.ts`, `editCodeIntent.ts`

| # | Event Name | Channel | Description | Key Properties | OTel? |
|---|-----------|---------|-------------|----------------|-------|
| 17 | `panel.edit.codeblocks` | MSFT | Edit response codeblock stats | `outcome`, `codeblockCount`, `editStepCount`, `sessionDuration`, `workingSetCount` | ❌ |
| 18 | `editCodeIntent.promptRender` | MSFT | Prompt rendering perf | `promptRenderDurationIncludingRunningTools`, `isAgentMode` | ❌ |
| 19 | `triggerSummarizeFailed` | MSFT | Context summarization failed | `errorKind`, `model` | ❌ |
| 20 | `backgroundSummarizationApplied` | MSFT | Background context compaction | `trigger`, `outcome`, `contextRatio` | ❌ |
| 21 | `readFileTrajectory` | MSFT | File read tool pattern | `rounds`, `avgChunkSize`, `model` | ❌ |
| 22 | `toolCalling.invalidToolMessages` | MSFT | Invalid tool messages filtered | `filterReasons`, `filterCount` | ❌ |

### Surface 6: Background Agent (Copilot CLI Sessions)

**Source**: `src/extension/chatSessions/vscode-node/copilotCLIChatSessions*.ts`, `copilotcliSession.ts`

| # | Event Name | Channel | Description | Key Properties | OTel? |
|---|-----------|---------|-------------|----------------|-------|
| 23 | `copilotcli.terminal.open` | MSFT | CLI terminal session created | `sessionType`, `shell`, `location` | ⚠️ Partial (env config forwarded) |
| 24 | `copilotcli.chat.invoke` | MSFT | CLI chat request initiated | `chatRequestId`, `hasChatSessionItem` | ⚠️ Partial (span bridge exists) |

### Surface 7: Cloud Sessions (CCA/Remote Agent)

**Source**: `src/extension/chatSessions/vscode-node/copilotCloudSessionsProvider.ts`

| # | Event Name | Channel | Description | Key Properties | OTel? |
|---|-----------|---------|-------------|----------------|-------|
| 25 | `copilotcloud.chat.invoke` | MSFT | Cloud agent invocation | `chatRequestId`, `partnerAgent` (Copilot/Claude/Codex), `model` | ❌ |
| 26 | `copilotcloud.chat.confirmationCancelled` | MSFT | User cancels cloud session confirmation | `tokenCancelled` | ❌ |
| 27 | `copilotcloud.chat.followupComment` | MSFT | Follow-up on existing PR | `targetAgent` | ❌ |
| 28 | `copilotcloud.chat.remoteAgentJobPullRequestReady` | MSFT | Remote job PR ready | — | ❌ |
| 29 | `copilotcloud.chat.remoteAgentJobInvoke` | MSFT | Remote agent job start | `hasHeadRef` | ❌ |
| 30 | `copilot.codingAgent.truncation` | MSFT | Prompt truncation dialog | `isCancelled` | ❌ |

---

## Proposed OTel Signals

### Category A: Edit Quality (Accept Rate + Survival + ARC)

These are the highest-value metrics — they directly feed the PowerBI dashboard.

```
copilot_chat.edit.feedback                     ← #1 panel.edit.feedback
├── event.name: 'copilot_chat.edit.feedback'
├── outcome: 'accepted' | 'rejected'
├── language_id: string
├── participant: string
├── edit_surface: 'agent' | 'inline_chat'
├── request_id: string
├── has_remaining_edits: boolean
└── is_notebook: boolean

copilot_chat.edit.hunk.action                  ← #2 edit.hunk.action
├── event.name: 'copilot_chat.edit.hunk.action'
├── outcome: 'accepted' | 'rejected'
├── language_id: string
├── request_id: string
├── line_count: number
├── lines_added: number
└── lines_removed: number

copilot_chat.edit.survival                     ← #11-15 all trackEditSurvival events
├── event.name: 'copilot_chat.edit.survival'
├── edit_source: 'apply_patch' | 'replace_string' | 'code_mapper' | 'inline_chat' | 'nes'
├── survival_rate_four_gram: number (0-1)
├── survival_rate_no_revert: number (0-1)
├── time_delay_ms: number
├── did_branch_change: boolean
├── request_id: string
└── arc?: number (committed characters, when available)
```

### Category B: User Engagement

```
copilot_chat.user.action                       ← #3-7 copy/insert/apply/followup
├── event.name: 'copilot_chat.user.action'
├── action: 'copy' | 'insert' | 'apply' | 'followup'
├── language_id: string
├── participant: string
├── character_count?: number
├── line_count?: number
└── is_agent: boolean

copilot_chat.user.feedback                     ← #8-9 vote/rating
├── event.name: 'copilot_chat.user.feedback'
├── rating: 'positive' | 'negative'
├── participant: string
├── conversation_id: string
└── request_id: string

copilot_chat.inline.done                       ← #10 inline.done
├── event.name: 'copilot_chat.inline.done'
├── accepted: boolean
├── language_id: string
├── edit_count: number
├── edit_line_count: number
├── reply_type: string
└── is_notebook: boolean
```

### Category C: Agent Internals (operational observability)

```
copilot_chat.agent.edit_response               ← #17 panel.edit.codeblocks
├── event.name: 'copilot_chat.agent.edit_response'
├── outcome: 'success' | 'error'
├── codeblock_count: number
├── edit_step_count: number
├── session_duration_ms: number
└── working_set_count: number

copilot_chat.agent.summarization               ← #19-20 triggerSummarizeFailed, backgroundSummarizationApplied
├── event.name: 'copilot_chat.agent.summarization'
├── outcome: 'applied' | 'failed'
├── trigger: string
├── error_kind?: string
├── context_ratio?: number
└── model: string
```

### Category D: Cloud/Remote Agent Sessions

```
copilot_chat.cloud.session.invoke              ← #25 copilotcloud.chat.invoke
├── event.name: 'copilot_chat.cloud.session.invoke'
├── partner_agent: 'copilot' | 'claude' | 'codex'
├── model: string
├── request_id: string
└── is_untitled: boolean

copilot_chat.cloud.pr_ready                    ← #28 remoteAgentJobPullRequestReady
├── event.name: 'copilot_chat.cloud.pr_ready'
└── request_id: string
```

### New Metrics (Counters & Histograms)

| Metric Name | Type | Attributes | Source Events |
|-------------|------|------------|---------------|
| `copilot_chat.edit.accept.count` | Counter | `outcome`, `edit_surface` | #1, #10 |
| `copilot_chat.edit.hunk.count` | Counter | `outcome` | #2 |
| `copilot_chat.lines_of_code.count` | Counter | `type` (added/removed), `language_id` | #2 (on accept) |
| `copilot_chat.edit.survival_rate` | Histogram | `edit_source`, `time_delay_ms` | #11-15 |
| `copilot_chat.edit.committed_characters` | Histogram | `edit_source`, `language_id` | #15 (ARC) |
| `copilot_chat.user.action.count` | Counter | `action`, `participant` | #3-7 |
| `copilot_chat.user.feedback.count` | Counter | `rating`, `participant` | #8-9 |
| `copilot_chat.pull_request.count` | Counter | — | CLI PR creation |
| `copilot_chat.commit.count` | Counter | — | CLI git commit detection |

---

## Implementation Plan

### Phase 1: Platform OTel helpers

Add event emitters to `src/platform/otel/common/genAiEvents.ts`:
- `emitEditFeedbackEvent()` — for #1 panel.edit.feedback
- `emitEditHunkActionEvent()` — for #2 edit.hunk.action
- `emitEditSurvivalEvent()` — for #11-15 all survival tracking
- `emitUserActionEvent()` — for #3-7 copy/insert/apply/followup
- `emitUserFeedbackEvent()` — for #8-9 vote/rating
- `emitInlineDoneEvent()` — for #10 inline.done
- `emitAgentEditResponseEvent()` — for #17 panel.edit.codeblocks
- `emitCloudSessionInvokeEvent()` — for #25 cloud session invoke

Add metrics to `src/platform/otel/common/genAiMetrics.ts`:
- `incrementEditAcceptCount()`
- `incrementEditHunkCount()`
- `incrementLinesOfCode()`
- `recordEditSurvivalRate()`
- `recordEditCommittedCharacters()`
- `incrementUserActionCount()`
- `incrementUserFeedbackCount()`
- `incrementPullRequestCount()`
- `incrementCommitCount()`

### Phase 2: Wire into call sites

| # | File | Events to Emit | Approach |
|---|------|----------------|----------|
| 1 | `src/extension/conversation/vscode-node/userActions.ts` | #1-9 (edit feedback, hunk, copy, insert, followup, apply, vote) | Inject `@IOTelService` into `UserFeedbackService` constructor |
| 2 | `src/extension/conversation/vscode-node/userActions.ts` | #10-11 (inline.done, inline.trackEditSurvival) | Same service, inline chat path |
| 3 | `src/extension/tools/node/applyPatchTool.tsx` | #12 (apply_patch survival) | Inject `@IOTelService` into tool constructor |
| 4 | `src/extension/tools/node/abstractReplaceStringTool.tsx` | #13 (replace_string survival) | Inject `@IOTelService` into tool constructor |
| 5 | `src/extension/prompts/node/codeMapper/codeMapperService.ts` | #14 (code mapper survival) | Pass `IOTelService` to survival callback |
| 6 | `src/extension/inlineEdits/vscode-node/inlineCompletionProvider.ts` | #15 (NES survival + ARC) | Inject `@IOTelService` |
| 7 | `src/extension/inlineEdits/node/nextEditProviderTelemetry.ts` | #16 (NES provideInlineEdit) | Inject `@IOTelService` |
| 8 | `src/extension/intents/node/editCodeIntent.ts` | #17 (panel.edit.codeblocks) | Already has access via toolCallingLoop |
| 9 | `src/extension/intents/node/agentIntent.ts` | #19-20 (summarization) | Already has `IOTelService` nearby |
| 10 | `src/extension/chatSessions/vscode-node/copilotCloudSessionsProvider.ts` | #25, #28 (cloud session invoke, PR ready) | Inject `@IOTelService` |
| 11 | `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts` | PR count, commit count | Inject `@IOTelService` |

### Phase 3: Documentation

- Update `docs/monitoring/agent_monitoring.md` with all new events/metrics tables

---

## Threading Approach

`IOTelService` will be injected directly into each service/tool class via DI constructor. Services that already have it nearby (toolCallingLoop, agentIntent) can pass it through. For survival callbacks that receive `EditSurvivalResult`, we use the approach of injecting `IOTelService` into the class that sets up the callback and capturing it in the closure.

A follow-up could add `otelService` to `EditSurvivalResult` itself for a cleaner long-term pattern.

## Scope: All Agentic Surfaces

This plan covers **all** agentic surfaces, not just foreground agent mode:

- **Panel Chat Agent mode** — user actions (accept/reject/copy/insert/vote), edit survival
- **Inline Chat (Ctrl+I)** — inline.done accept/reject, inline edit survival
- **NES Inline Edits** — survival rate, ARC (committed characters), shown/accepted/rejected
- **Agent Edit Tools** — apply_patch, replace_string, code_mapper survival tracking
- **Background Agent (Copilot CLI)** — PR creation count, commit count (augment existing span bridge)
- **Cloud Sessions (CCA/Remote)** — session invocation, PR ready events
- **Agent Internals** — codeblock stats, summarization outcomes

### What's NOT in scope
- Ghost text completions (`ghostText.shown/accepted/rejected`) — not agentic, tracked separately by completions-core
- Internal debugging events (`toolCalling.invalidToolMessages`, `readFileTrajectory`) — low value for GH dashboards
- Claude Code agent hooks — already have full OTel coverage via `withHookOTelSpan()`

---

## Open Questions

- [ ] Confirm `copilot_chat.edit.*` attribute namespace with GH
- [ ] Should hunk-level events (`copilot_chat.edit.hunk.action`) be included or deferred? (noisier than file-level)
- [ ] Enable ARC tracking for agent tools (`includeArc: true` in `EditSurvivalReporter`) — separate change?
- [ ] Any additional agentic metrics GH wants beyond accept rate / survival / ARC?

---

## Claude Code OTel Parity Analysis

> **Context**: Claude Code already exports the metrics below via OTel (see [monitoring-usage docs](https://code.claude.com/docs/en/monitoring-usage#metrics)). GH is under pressure to add more metrics — filling parity gaps with OTel may help. This section analyses feasibility for each Claude Code metric in Copilot Chat's extension.

### Reference: Claude Code Metrics

| Metric Name | Description | Unit |
|------------|-------------|------|
| `claude_code.session.count` | Count of CLI sessions started | count |
| `claude_code.lines_of_code.count` | Count of lines of code modified | count |
| `claude_code.pull_request.count` | Number of pull requests created | count |
| `claude_code.commit.count` | Number of git commits created | count |
| `claude_code.cost.usage` | Cost of the Claude Code session | USD |
| `claude_code.token.usage` | Number of tokens used | tokens |
| `claude_code.code_edit_tool.decision` | Count of code editing tool permission decisions | count |
| `claude_code.active_time.total` | Total active time in seconds | s |

### Feasibility Analysis

#### 1. `claude_code.session.count` → ✅ Already emitted

**Our equivalent**: `copilot_chat.session.count` (Counter) + `copilot_chat.session.start` (Event)

- Already emitted in `GenAiMetrics.incrementSessionCount()` at `src/extension/intents/node/toolCallingLoop.ts`
- **Lines to change: 0** — Complete.

---

#### 2. `claude_code.lines_of_code.count` → 🔨 Wire existing data to OTel

**Feasibility**: HIGH — line counts already tracked in MSFT telemetry, just not emitted to OTel.

**Existing data sources**:
- `edit.hunk.action` event has `linesAdded`, `linesRemoved`, `lineCount` (`src/extension/conversation/vscode-node/userActions.ts`)
- `panel.edit.feedback` tracks per-file accept/reject
- `chatParticipantTelemetry.ts` aggregates `editLineCount` across all edits

**Proposed OTel metric**: `copilot_chat.lines_of_code.count` (Counter)
- Attributes: `type` (`"added"`, `"removed"`), `language_id`, `edit_source` (`agent`, `inline_chat`)
- Increment on each hunk accept with the actual line delta

**Implementation**:
| File | Change |
|------|--------|
| `src/platform/otel/common/genAiMetrics.ts` | Add `incrementLinesOfCode(otel, type, languageId, editSource)` |
| `src/extension/conversation/vscode-node/userActions.ts` | Emit alongside `edit.hunk.action` for accepted hunks |

**Estimated lines to change: ~15**

---

#### 3. `claude_code.pull_request.count` → 🔨 Small build needed

**Feasibility**: MEDIUM — PR creation is detected today for Copilot CLI sessions, but not metered.

**Existing detection**:
- `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts:578` detects `create_pull_request` tool success and extracts URL
- `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts` has `handlePullRequestCreated()` handler
- No explicit MSFT telemetry event for PR creation count

**Proposed OTel metric**: `copilot_chat.pull_request.count` (Counter)
- Attributes: standard attributes only (matching Claude Code)
- Increment when `create_pull_request` tool succeeds OR when worktree session creates a PR

**Implementation**:
| File | Change |
|------|--------|
| `src/platform/otel/common/genAiMetrics.ts` | Add `incrementPullRequestCount(otel)` |
| `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts` | Emit after successful `create_pull_request` tool detection |
| `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts` | Emit in `handlePullRequestCreated()` |

**Estimated lines to change: ~20**

**Note**: Need to inject `IOTelService` into the session classes, or pass it through from the parent.

---

#### 4. `claude_code.commit.count` → 🔨 Medium build needed

**Feasibility**: MEDIUM — commits happen as side-effects of agent tool usage (Bash/terminal running `git commit`). Not directly tracked today.

**Existing signals**:
- `git.generateCommitMessageSurvival` event fires on `onDidCommit` (`src/extension/prompt/vscode-node/gitCommitMessageServiceImpl.ts`) — but only for AI-generated commit messages
- Copilot CLI sessions track git state via branch detection
- No general "agent caused a commit" counter exists

**Proposed OTel metric**: `copilot_chat.commit.count` (Counter)
- Attributes: standard attributes only
- Increment when a commit is detected during an active agent session

**Implementation options**:
1. **Option A (easier)**: Hook into the git extension's `onDidCommit` event during active agent sessions — but this catches ALL commits, not just agent-caused ones
2. **Option B (precise)**: Track `git commit` commands in Bash tool execution results (Copilot CLI) — narrower scope, more accurate

| File | Change |
|------|--------|
| `src/platform/otel/common/genAiMetrics.ts` | Add `incrementCommitCount(otel)` |
| `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts` | Detect `git commit` in tool results (similar to `create_pull_request` pattern) |

**Estimated lines to change: ~25**

**Risk**: May miss commits made outside the agent session context. Option A is simpler but noisier.

---

#### 5. `claude_code.cost.usage` → ❌ Blocked (no data source)

**Feasibility**: NONE — Copilot Chat does not have access to per-request cost data.

**Why**:
- Token counts are available (see #6), but there's no pricing model in the extension
- Cost computation requires backend pricing data (varies by model, tier, org)
- Claude Code has this because Anthropic controls the pricing; Copilot uses GitHub/Azure backend which doesn't expose cost to the extension

**Recommendation**: Skip. GH can compute cost server-side from token usage metrics. Document that token usage is the OTel-side proxy for cost.

**Estimated lines to change: 0** (not feasible)

---

#### 6. `claude_code.token.usage` → ✅ Already emitted

**Our equivalent**: `gen_ai.client.token.usage` (Histogram)

- Already emitted in `GenAiMetrics.recordTokenUsage()` across:
  - `src/extension/prompt/node/chatMLFetcher.ts` (CAPI path)
  - `src/extension/byok/vscode-node/geminiNativeProvider.ts` (Gemini)
  - `src/extension/byok/vscode-node/anthropicProvider.ts` (Anthropic BYOK)
- Attributes include `gen_ai.token.type` (`input`/`output`), `gen_ai.request.model`, `gen_ai.provider.name`
- Also includes cache tokens via `gen_ai.usage.cache_read.input_tokens` span attribute

**Lines to change: 0** — Complete.

---

#### 7. `claude_code.code_edit_tool.decision` → 🔨 Wire existing data to OTel

**Feasibility**: HIGH — maps directly to our `panel.edit.feedback` and `edit.hunk.action` events.

**Claude Code semantics**: Counts accept/reject of code editing tool permission (Edit, Write, NotebookEdit tools). In Copilot Chat, this maps to:
- **File-level**: `panel.edit.feedback` → user accepts/rejects a proposed file edit (`outcome`: accepted/rejected)
- **Hunk-level**: `edit.hunk.action` → user accepts/rejects individual hunks

This is the same as the "Accept Rate" metrics already planned in Phase 1-2 above. The `copilot_chat.edit.feedback` event and `copilot_chat.edit.accept.count` counter already cover this.

**Additional mapping**: To match Claude Code's `tool_name` attribute (`"Edit"`, `"Write"`, `"NotebookEdit"`), we could add an `edit_tool` attribute:
- `apply_patch` → maps to Claude's `Edit`
- `replace_string` → maps to Claude's `Edit`  
- `create_file` → maps to Claude's `Write`

**Estimated lines to change: ~5** (add `edit_tool` attribute to already-planned events)

---

#### 8. `claude_code.active_time.total` → 🔨 Medium build needed

**Feasibility**: MEDIUM — agent session duration IS tracked, but granular active/idle time is not.

**Existing tracking**:
- `GenAiMetrics.recordAgentDuration(otel, agentName, durationSec)` — already emitted at `src/extension/intents/node/toolCallingLoop.ts:812` as `copilot_chat.agent.invocation.duration`
- This measures **total wall-clock time** of the agent invocation, which includes both active processing and idle/waiting time
- `sessionDuration` measured in `editCodeIntent.ts:267` for inline chat sessions

**Gap vs Claude Code**:
- Claude Code separates `type: "user"` (keyboard interactions) from `type: "cli"` (tool execution, AI responses)
- We don't have this split — our metric is purely server-side processing time
- VS Code's idle detection exists for NES inline edits (`IdleDetector` in `nextEditProviderTelemetry.ts`) but not for agent sessions

**Proposed approach**: Emit our existing `copilot_chat.agent.invocation.duration` as the equivalent. It's not identical semantics but captures total session time.

**For full parity would need**:
- Track time spent waiting for user input vs. processing
- Would require new instrumentation in the chat UI layer
- This is a **large effort** beyond simple OTel wiring

**Estimated lines to change: ~5** (rename/re-tag existing metric) or **~80+** for full active/idle split

---

### Summary: Claude Code Parity

| Claude Code Metric | Status | Effort | Est. Lines |
|-------------------|--------|--------|------------|
| `session.count` | ✅ Complete | None | 0 |
| `lines_of_code.count` | 🔨 Wire to OTel | Small | ~15 |
| `pull_request.count` | 🔨 Build + wire | Small-Medium | ~20 |
| `commit.count` | 🔨 Build + wire | Medium | ~25 |
| `cost.usage` | ❌ Blocked | N/A | 0 |
| `token.usage` | ✅ Complete | None | 0 |
| `code_edit_tool.decision` | 🔨 Wire to OTel | Small | ~5 (on top of Phase 1-2) |
| `active_time.total` | ⚠️ Partial | Small (reuse) or Large (full parity) | ~5 or ~80+ |

**Total new lines for achievable metrics: ~65-85** (excluding active_time full parity and cost)

### Recommended Priority (combined with Phase 1-2)

1. **This release** (emit existing data, low risk):
   - `copilot_chat.edit.feedback` / `copilot_chat.edit.hunk.action` — covers Accept Rate + code_edit_tool.decision
   - `copilot_chat.edit.survival` — covers Commit Survival
   - `copilot_chat.lines_of_code.count` — mirrors `claude_code.lines_of_code.count`

2. **Fast follow-up** (small builds):
   - `copilot_chat.pull_request.count` — hook into CLI PR creation
   - `copilot_chat.commit.count` — hook into CLI git commit detection

3. **Deferred**:
   - `active_time.total` full parity — requires new UI-layer instrumentation
   - `cost.usage` — not feasible client-side
