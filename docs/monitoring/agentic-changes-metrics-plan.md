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
