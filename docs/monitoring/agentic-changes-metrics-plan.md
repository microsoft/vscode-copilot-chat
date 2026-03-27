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

## MSFT Telemetry Events to Backfill

### 1. Accept Rate (agentic edits)

| MSFT Event | Surface | Key Properties |
|------------|---------|----------------|
| `panel.edit.feedback` | Agent proposes file edit → user accepts/rejects per-file | `outcome` (accepted/rejected), `languageId`, `participant`, `requestId` |
| `edit.hunk.action` | User accepts/rejects individual hunks within a file | `outcome`, `languageId`, `lineCount`, `linesAdded`, `linesRemoved` |

**Source**: `src/extension/conversation/vscode-node/userActions.ts`

### 2. Commit Survival (agentic edits)

| MSFT Event | Tool | Key Properties |
|------------|------|----------------|
| `applyPatch.trackEditSurvival` | `apply_patch` tool | `survivalRateFourGram` (0-1), `survivalRateNoRevert` (0-1), `timeDelayMs`, `didBranchChange` |
| `codeMapper.trackEditSurvival` | `replace_string` tool | same as above |

**Sources**:
- `src/extension/tools/node/applyPatchTool.tsx`
- `src/extension/tools/node/abstractReplaceStringTool.tsx`

### 3. Committed Characters (ARC)

| MSFT Event | Surface | Key Properties |
|------------|---------|----------------|
| `reportInlineEditSurvivalRate` | NES inline edits | `arc` (character count), `survivalRateFourGram`, `timeDelayMs` |

**Source**: `src/extension/inlineEdits/vscode-node/inlineCompletionProvider.ts`

> **Note**: ARC is currently only measured for NES inline edits. If we want ARC for agent edits (apply_patch / replace_string), we'd need to pass `{ includeArc: true }` to `EditSurvivalReporter` in those tools. This is a separate change.

---

## Proposed OTel Signals

### New Events (via `emitLogRecord`)

```
copilot_chat.edit.feedback
├── event.name: 'copilot_chat.edit.feedback'
├── outcome: 'accepted' | 'rejected'
├── language_id: string
├── participant: string
├── request_id: string
├── has_remaining_edits: boolean
└── is_notebook: boolean

copilot_chat.edit.hunk.action
├── event.name: 'copilot_chat.edit.hunk.action'
├── outcome: 'accepted' | 'rejected'
├── language_id: string
├── request_id: string
├── line_count: number
├── lines_added: number
└── lines_removed: number

copilot_chat.edit.survival
├── event.name: 'copilot_chat.edit.survival'
├── edit_source: 'apply_patch' | 'replace_string' | 'inline_chat' | 'nes'
├── survival_rate_four_gram: number (0-1)
├── survival_rate_no_revert: number (0-1)
├── time_delay_ms: number
├── did_branch_change: boolean
├── request_id: string
└── arc?: number (only when available)
```

### New Metrics

| Metric Name | Type | Attributes | Purpose |
|-------------|------|------------|---------|
| `copilot_chat.edit.accept.count` | Counter | `outcome`, `edit_source` | Accept rate numerator/denominator |
| `copilot_chat.edit.survival_rate` | Histogram | `edit_source`, `time_delay_ms` | Survival distribution |
| `copilot_chat.edit.committed_characters` | Histogram | `edit_source`, `language_id` | ARC distribution |

### Attribute Namespace

All new attributes use `copilot_chat.edit.*` — consistent with existing `copilot_chat.tool.*` and `copilot_chat.agent.*` namespaces.

---

## Implementation Plan

### Phase 1: Platform helpers (~60 lines)

Add to `src/platform/otel/common/genAiEvents.ts`:
- `emitEditFeedbackEvent(otel, outcome, languageId, participant, requestId, ...)`
- `emitEditHunkActionEvent(otel, outcome, languageId, requestId, lineCount, ...)`
- `emitEditSurvivalEvent(otel, editSource, survivalRateFourGram, survivalRateNoRevert, timeDelayMs, ...)`

Add to `src/platform/otel/common/genAiMetrics.ts`:
- `GenAiMetrics.incrementEditAcceptCount(otel, outcome, editSource)`
- `GenAiMetrics.recordEditSurvivalRate(otel, editSource, survivalRate, timeDelayMs)`
- `GenAiMetrics.recordEditCommittedCharacters(otel, editSource, arc, languageId)`

### Phase 2: Wire into call sites

| # | File | Change | Approach |
|---|------|--------|----------|
| 1 | `src/extension/conversation/vscode-node/userActions.ts` | Inject `IOTelService` into `UserFeedbackService`, emit `copilot_chat.edit.feedback` alongside `panel.edit.feedback`, emit `copilot_chat.edit.hunk.action` alongside `edit.hunk.action` | Add `@IOTelService` to constructor |
| 2 | `src/extension/tools/node/applyPatchTool.tsx` | Inject `IOTelService`, emit `copilot_chat.edit.survival` in the existing survival callback | Add `@IOTelService` to constructor |
| 3 | `src/extension/tools/node/abstractReplaceStringTool.tsx` | Same as above for replace_string tool | Add `@IOTelService` to constructor |

### Phase 3: Documentation

- Update `docs/monitoring/agent_monitoring.md` with new events/metrics table

---

## Threading Approach

`IOTelService` will be injected directly into each tool/service class via DI constructor (Option A — minimal, self-contained per file). The alternative (adding `otelService` to `EditSurvivalResult`) is cleaner long-term but more invasive and deferred to a follow-up.

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
