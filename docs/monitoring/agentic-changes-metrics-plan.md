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

### Surface 4: Agent Mode Internals

**Source**: `src/extension/intents/node/agentIntent.ts`, `toolCallingLoop.ts`, `editCodeIntent.ts`

| # | Event Name | Channel | Description | Key Properties | OTel? |
|---|-----------|---------|-------------|----------------|-------|
| 15 | `panel.edit.codeblocks` | MSFT | Edit response codeblock stats | `outcome`, `codeblockCount`, `editStepCount`, `sessionDuration`, `workingSetCount` | ❌ |
| 16 | `editCodeIntent.promptRender` | MSFT | Prompt rendering perf | `promptRenderDurationIncludingRunningTools`, `isAgentMode` | ❌ |
| 17 | `triggerSummarizeFailed` | MSFT | Context summarization failed | `errorKind`, `model` | ❌ |
| 18 | `backgroundSummarizationApplied` | MSFT | Background context compaction | `trigger`, `outcome`, `contextRatio` | ❌ |
| 19 | `readFileTrajectory` | MSFT | File read tool pattern | `rounds`, `avgChunkSize`, `model` | ❌ |
| 20 | `toolCalling.invalidToolMessages` | MSFT | Invalid tool messages filtered | `filterReasons`, `filterCount` | ❌ |

### Surface 5: Background Agent (Copilot CLI Sessions)

**Source**: `src/extension/chatSessions/vscode-node/copilotCLIChatSessions*.ts`, `copilotcliSession.ts`

| # | Event Name | Channel | Description | Key Properties | OTel? |
|---|-----------|---------|-------------|----------------|-------|
| 21 | `copilotcli.terminal.open` | MSFT | CLI terminal session created | `sessionType`, `shell`, `location` | ⚠️ Partial (env config forwarded) |
| 22 | `copilotcli.chat.invoke` | MSFT | CLI chat request initiated | `chatRequestId`, `hasChatSessionItem` | ⚠️ Partial (span bridge exists) |

### Surface 6: Cloud Sessions (CCA/Remote Agent)

**Source**: `src/extension/chatSessions/vscode-node/copilotCloudSessionsProvider.ts`

| # | Event Name | Channel | Description | Key Properties | OTel? |
|---|-----------|---------|-------------|----------------|-------|
| 23 | `copilotcloud.chat.invoke` | MSFT | Cloud agent invocation | `chatRequestId`, `partnerAgent` (Copilot/Claude/Codex), `model` | ❌ |
| 24 | `copilotcloud.chat.confirmationCancelled` | MSFT | User cancels cloud session confirmation | `tokenCancelled` | ❌ |
| 25 | `copilotcloud.chat.followupComment` | MSFT | Follow-up on existing PR | `targetAgent` | ❌ |
| 26 | `copilotcloud.chat.remoteAgentJobPullRequestReady` | MSFT | Remote job PR ready | — | ❌ |
| 27 | `copilotcloud.chat.remoteAgentJobInvoke` | MSFT | Remote agent job start | `hasHeadRef` | ❌ |
| 28 | `copilot.codingAgent.truncation` | MSFT | Prompt truncation dialog | `isCancelled` | ❌ |

---

## Proposed OTel Signals — 3-Pillar Mapping

### Signal Type Decision Guide

| Timing | OTel Pillar | Mechanism | Example |
|--------|-------------|-----------|---------|
| During agent span | **Trace** — span attribute | `span.setAttribute()` on existing `invoke_agent` span | codeblock_count, edit_step_count |
| During agent span (milestone) | **Trace** — span event | `span.addEvent()` on existing `invoke_agent` span | summarization applied/failed |
| After agent span ends | **Event** — standalone log record | `otel.emitLogRecord()` | edit accepted/rejected, survival rate |
| Aggregate/dashboard | **Metric** — counter or histogram | `otel.incrementCounter()` / `otel.recordMetric()` | accept count, lines of code |

### Signal Type Principles

1. **Counter** — add when easy; PMs use dashboards, not traces
2. **Event (log record)** — only when attributes enable meaningful "why" drill-down; skip if no useful attrs
3. **Span attribute** — add when data is available during span lifetime
4. **Span event** — milestones within a span; add counter too if PMs need the number

### Complete Signal Map

| # | Source MSFT Event | Counter? | Event? | Span attr? | OTel Signal Names | Rationale |
|---|------------------|----------|--------|------------|-------------------|-----------|
| **Edit Quality (Accept Rate)** | | | | | | |
| 1 | `panel.edit.feedback` | ✅ `edit.accept.count` | ✅ `edit.feedback` | — | Counter{`outcome`, `edit_surface`} + Event{`outcome`, `language_id`, `participant`, `request_id`} | Counter for accept rate dashboard; event has `request_id` + `participant` for drill-down into which agent/model |
| 2 | `edit.hunk.action` | ✅ `edit.hunk.count` + `lines_of_code.count` | ✅ `edit.hunk.action` | — | Counter{`outcome`} + Counter{`type`: added/removed, `language_id`} + Event{`lines_added`, `lines_removed`, `language_id`} | Counter for hunk-level accept rate + lines of code dashboard; event has per-hunk line deltas for anomaly drill-down |
| 10 | `inline.done` | ✅ `edit.accept.count` | ✅ `inline.done` | — | Counter{`outcome`, `edit_surface: inline_chat`} + Event{`accepted`, `language_id`, `edit_count`, `edit_line_count`} | Counter feeds same accept rate as #1; event has `edit_count`/`edit_line_count` useful for understanding inline edit sizes |
| **Edit Quality (Survival)** | | | | | | |
| 11 | `inline.trackEditSurvival` | ✅ `edit.survival_rate` (histogram) | ✅ `edit.survival` | — | Histogram{`edit_source`, `time_delay_ms`} + Event{`survival_rate_four_gram`, `survival_rate_no_revert`, `request_id`, `did_branch_change`} | Histogram for survival distribution; event has `request_id` + `did_branch_change` to filter invalid data points |
| 12 | `applyPatch.trackEditSurvival` | ✅ same histogram | ✅ same event | — | `edit_source: 'apply_patch'` | Same pattern |
| 13 | `codeMapper.trackEditSurvival` (replace_string) | ✅ same histogram | ✅ same event | — | `edit_source: 'replace_string'` | Same pattern |
| 14 | `codeMapper.trackEditSurvival` (code_mapper) | ✅ same histogram | ✅ same event | — | `edit_source: 'code_mapper'` | Same pattern |
| **User Engagement** | | | | | | |
| 3 | `panel.action.copy` | ✅ `user.action.count` | ❌ | — | Counter{`action: 'copy'`} | Counter only — attrs are just `character_count`/`line_count`, no meaningful "why" drill-down |
| 4 | `panel.action.insert` | ✅ `user.action.count` | ❌ | — | Counter{`action: 'insert'`} | Counter only — same reasoning, `character_count` alone doesn't answer "why" |
| 5 | `panel.action.followup` | ✅ `user.action.count` | ❌ | — | Counter{`action: 'followup'`} | Counter only — event would just have `language_id`, no useful drill-down |
| 6 | `conversation.acceptedCopy/Insert` | — | — | — | Skip (duplicate of #3/#4) | — |
| 7 | `conversation.appliedCodeblock` | ✅ `user.action.count` | ❌ | — | Counter{`action: 'apply'`} | Counter only — `total_lines` and `is_agent` are interesting but not worth a separate event |
| 8–9 | `panel.action.vote` / `messageRating` | ✅ `user.feedback.count` | ✅ `user.feedback` | — | Counter{`rating`} + Event{`rating`, `participant`, `conversation_id`, `request_id`} | Counter for satisfaction dashboard; event has `conversation_id` + `request_id` to identify which responses get negative feedback — very useful for quality investigations |
| **Agent Internals** | | | | | | |
| 15 | `panel.edit.codeblocks` | ✅ `agent.edit_response.count` | ❌ | ✅ | Counter{`outcome`} + Span attrs: `codeblock_count`, `edit_step_count`, `working_set_count` | Counter for success/error rate dashboard (easy); span attrs for per-invocation correlation with duration/tokens; no event needed — attrs are numeric aggregates, not "why" data |
| 16 | `editCodeIntent.promptRender` | ❌ | ❌ | ✅ | Span attrs: `prompt_render_duration_ms`, `is_agent_mode` | Span attr only — this is a duration that correlates with the span; no counter (prompt render count = span count, redundant) |
| 17 | `triggerSummarizeFailed` | ✅ `agent.summarization.count` | ❌ | ✅ span event | Counter{`outcome: 'failed'`} + Span event{`error_kind`, `model`} | Counter for "how often does summarization fail" dashboard; span event for trace-level correlation; no standalone event — attrs (`error_kind`, `model`) are useful but only in span context |
| 18 | `backgroundSummarizationApplied` | ✅ `agent.summarization.count` | ❌ | ✅ span event | Counter{`outcome: 'applied'`} + Span event{`trigger`, `context_ratio`, `model`} | Same counter shared with #17; span event for trace drill-down |
| 19–20 | `readFileTrajectory` / `invalidToolMessages` | — | — | — | Skip (internal debugging) | — |
| **Background Agent (CLI)** | | | | | | |
| 21–22 | `terminal.open` / `chat.invoke` | — | — | — | Skip (already has OTel bridge) | — |
| — | CLI PR creation | ✅ `pull_request.count` | ❌ | — | Counter only — rare event, simple aggregate | No useful attrs beyond the count itself |
| — | CLI git commit | ✅ `commit.count` | ❌ | — | Counter only — same reasoning | — |
| **Cloud Sessions** | | | | | | |
| 23 | `copilotcloud.chat.invoke` | ✅ `cloud.session.count` | ✅ `cloud.session.invoke` | — | Counter{`partner_agent`} + Event{`partner_agent`, `model`, `request_id`} | Counter for "how many cloud sessions by agent type" dashboard; event has `model` + `request_id` for per-session drill-down |
| 24–25 | `confirmationCancelled` / `followupComment` | — | — | — | Skip (low dashboard value) | — |
| 26 | `remoteAgentJobPullRequestReady` | ✅ `cloud.pr_ready.count` | ❌ | — | Counter only — only attr is `request_id`, not useful for drill-down | — |
| 27–28 | `remoteAgentJobInvoke` / `truncation` | — | — | — | Skip (low dashboard value) | — |

### Summary by Pillar

| Pillar | Count | Details |
|--------|-------|---------|
| **Metrics** (counters) | 11 | `edit.accept.count`, `edit.hunk.count`, `lines_of_code.count`, `user.action.count`, `user.feedback.count`, `agent.edit_response.count`, `agent.summarization.count`, `pull_request.count`, `commit.count`, `cloud.session.count`, `cloud.pr_ready.count` |
| **Metrics** (histograms) | 1 | `edit.survival_rate` |
| **Events** (log records) | 6 | `edit.feedback`, `edit.hunk.action`, `inline.done`, `edit.survival`, `user.feedback`, `cloud.session.invoke` |
| **Trace** (span attributes) | 2 | `codeblock_count`+`edit_step_count`+`working_set_count` on `invoke_agent`; `prompt_render_duration_ms` on `invoke_agent` |
| **Trace** (span events) | 2 | `summarization_failed`, `summarization_applied` on `invoke_agent` |
| **Skipped** | 9 | #6 (duplicate), #19-20 (debug), #21-22 (already bridged), #24-25, #27-28 (low value) |

---

## Implementation Plan

### Phase 1: Platform OTel helpers

Add event emitters to `src/platform/otel/common/genAiEvents.ts` (only for items with ✅ Event):
- `emitEditFeedbackEvent()` — #1
- `emitEditHunkActionEvent()` — #2
- `emitInlineDoneEvent()` — #10
- `emitEditSurvivalEvent()` — #11-14
- `emitUserFeedbackEvent()` — #8-9
- `emitCloudSessionInvokeEvent()` — #23

Add metrics to `src/platform/otel/common/genAiMetrics.ts` (all ✅ Counter/Histogram items):
- `incrementEditAcceptCount()` — #1, #10
- `incrementEditHunkCount()` — #2
- `incrementLinesOfCode()` — #2 (on accept)
- `recordEditSurvivalRate()` — #11-14
- `incrementUserActionCount()` — #3-5, #7
- `incrementUserFeedbackCount()` — #8-9
- `incrementAgentEditResponseCount()` — #15
- `incrementAgentSummarizationCount()` — #17-18
- `incrementPullRequestCount()` — CLI
- `incrementCommitCount()` — CLI
- `incrementCloudSessionCount()` — #23
- `incrementCloudPrReadyCount()` — #26

### Phase 2: Wire into call sites

| # | File | What to Add | Approach | Effort |
|---|------|-------------|----------|--------|
| 1 | `userActions.ts` | Events #1-5, #7-9 + counters | Inject `@IOTelService` into `UserFeedbackService` | Medium |
| 2 | `userActions.ts` | Events #10-11 + counter | Same service, inline chat path | Small |
| 3 | `applyPatchTool.tsx` | Event #12 + histogram | Inject `@IOTelService` into tool constructor | Small |
| 4 | `abstractReplaceStringTool.tsx` | Event #13 + histogram | Inject `@IOTelService` into tool constructor | Small |
| 5 | `codeMapperService.ts` | Event #14 + histogram | Pass `IOTelService` to survival callback | Small |
| 6 | `editCodeIntent.ts` | **Span attrs** #15-16 on `invoke_agent` | `span.setAttribute()` — no new injection needed | Trivial (~5 lines) |
| 7 | `agentIntent.ts` | **Span events** #17-18 on `invoke_agent` | `span.addEvent()` — no new injection needed | Trivial (~5 lines) |
| 8 | `copilotCloudSessionsProvider.ts` | Events #23, #26 | Inject `@IOTelService` | Small |
| 9 | `copilotcliSession.ts` | Counters for PR + commit | Inject `@IOTelService` | Small |

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
- **Agent Edit Tools** — apply_patch, replace_string, code_mapper survival tracking
- **Background Agent (Copilot CLI)** — PR creation count, commit count (augment existing span bridge)
- **Cloud Sessions (CCA/Remote)** — session invocation, PR ready events
- **Agent Internals** — codeblock stats, summarization outcomes

### What's NOT in scope
- **NES inline edits** — not agentic, separate completions surface
- **Ghost text completions** (`ghostText.shown/accepted/rejected`) — not agentic, tracked by completions-core
- **Claude Code agent hooks** — already have full OTel coverage via `withHookOTelSpan()`

---

## Open Questions

- [ ] Confirm `copilot_chat.edit.*` attribute namespace with GH
- [ ] Should hunk-level events (`copilot_chat.edit.hunk.action`) be included or deferred? (noisier than file-level)
- [ ] Enable ARC tracking for agent tools (`includeArc: true` in `EditSurvivalReporter`) — separate change?
- [ ] Any additional agentic metrics GH wants beyond accept rate / survival / ARC?
