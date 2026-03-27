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

### Complete Signal Map

| # | Source MSFT Event | OTel Pillar | Signal Type | OTel Signal Name | Key Attributes | Timing |
|---|------------------|-------------|-------------|-----------------|----------------|--------|
| **Edit Quality (Accept Rate)** | | | | | | |
| 1 | `panel.edit.feedback` | Event + Metric | Log record + Counter | `copilot_chat.edit.feedback` / `copilot_chat.edit.accept.count` | `outcome`, `language_id`, `participant`, `edit_surface` | Post-span |
| 2 | `edit.hunk.action` | Event + Metric | Log record + Counter × 2 | `copilot_chat.edit.hunk.action` / `copilot_chat.edit.hunk.count` / `copilot_chat.lines_of_code.count` | `outcome`, `language_id`, `lines_added`, `lines_removed` | Post-span |
| 10 | `inline.done` | Event + Metric | Log record + Counter | `copilot_chat.inline.done` / `copilot_chat.edit.accept.count` | `accepted`, `language_id`, `edit_count`, `edit_line_count` | Post-span (no parent span) |
| **Edit Quality (Survival)** | | | | | | |
| 11 | `inline.trackEditSurvival` | Event + Metric | Log record + Histogram | `copilot_chat.edit.survival` / `copilot_chat.edit.survival_rate` | `edit_source: 'inline_chat'`, `survival_rate_four_gram`, `time_delay_ms` | 5s–15min post-span |
| 12 | `applyPatch.trackEditSurvival` | Event + Metric | Log record + Histogram | `copilot_chat.edit.survival` / `copilot_chat.edit.survival_rate` | `edit_source: 'apply_patch'`, same attrs | 5s–15min post-span |
| 13 | `codeMapper.trackEditSurvival` (replace_string) | Event + Metric | Log record + Histogram | `copilot_chat.edit.survival` / `copilot_chat.edit.survival_rate` | `edit_source: 'replace_string'`, same attrs | 5s–15min post-span |
| 14 | `codeMapper.trackEditSurvival` (code_mapper) | Event + Metric | Log record + Histogram | `copilot_chat.edit.survival` / `copilot_chat.edit.survival_rate` | `edit_source: 'code_mapper'`, same attrs | 5s–15min post-span |
| **User Engagement** | | | | | | |
| 3 | `panel.action.copy` | Event + Metric | Log record + Counter | `copilot_chat.user.action` / `copilot_chat.user.action.count` | `action: 'copy'`, `character_count`, `line_count` | Post-span |
| 4 | `panel.action.insert` | Event + Metric | Log record + Counter | `copilot_chat.user.action` / `copilot_chat.user.action.count` | `action: 'insert'`, `character_count` | Post-span |
| 5 | `panel.action.followup` | Event + Metric | Log record + Counter | `copilot_chat.user.action` / `copilot_chat.user.action.count` | `action: 'followup'` | Post-span |
| 6 | `conversation.acceptedCopy/Insert` | — | Skip (duplicate of #3/#4 with extra attrs) | — | — | — |
| 7 | `conversation.appliedCodeblock` | Event + Metric | Log record + Counter | `copilot_chat.user.action` / `copilot_chat.user.action.count` | `action: 'apply'`, `total_lines`, `is_agent` | Post-span |
| 8–9 | `panel.action.vote` / `conversation.messageRating` | Event + Metric | Log record + Counter | `copilot_chat.user.feedback` / `copilot_chat.user.feedback.count` | `rating`, `participant`, `conversation_id` | Post-span |
| **Agent Internals** | | | | | | |
| 15 | `panel.edit.codeblocks` | **Trace** | **Span attributes** on `invoke_agent` | — (attrs on existing span) | `codeblock_count`, `edit_step_count`, `working_set_count`, `session_duration_ms` | During span |
| 16 | `editCodeIntent.promptRender` | **Trace** | **Span attributes** on `invoke_agent` | — | `prompt_render_duration_ms`, `is_agent_mode` | During span |
| 17 | `triggerSummarizeFailed` | **Trace** | **Span event** via `addEvent()` | `summarization_failed` | `error_kind`, `model` | During span |
| 18 | `backgroundSummarizationApplied` | **Trace** | **Span event** via `addEvent()` | `summarization_applied` | `trigger`, `outcome`, `context_ratio`, `model` | During span |
| 19–20 | `readFileTrajectory` / `toolCalling.invalidToolMessages` | — | Skip (internal debugging, low dashboard value) | — | — | — |
| **Background Agent (CLI)** | | | | | | |
| 21 | `copilotcli.terminal.open` | — | Skip (already has env config bridge) | — | — | — |
| 22 | `copilotcli.chat.invoke` | — | Skip (already has span bridge) | — | — | — |
| — | CLI PR creation | Metric | Counter | `copilot_chat.pull_request.count` | — | On tool success |
| — | CLI git commit | Metric | Counter | `copilot_chat.commit.count` | — | On tool success |
| **Cloud Sessions** | | | | | | |
| 23 | `copilotcloud.chat.invoke` | Event | Log record | `copilot_chat.cloud.session.invoke` | `partner_agent`, `model`, `request_id` | On invocation |
| 24–25 | `confirmationCancelled` / `followupComment` | — | Skip (low dashboard value) | — | — | — |
| 26 | `remoteAgentJobPullRequestReady` | Event | Log record | `copilot_chat.cloud.pr_ready` | `request_id` | On notification |
| 27–28 | `remoteAgentJobInvoke` / `truncation` | — | Skip (operational, low dashboard value) | — | — | — |

### Summary by Pillar

| Pillar | Count | Details |
|--------|-------|---------|
| **Metrics** (counters) | 6 | `edit.accept.count`, `edit.hunk.count`, `lines_of_code.count`, `user.action.count`, `user.feedback.count`, `pull_request.count`, `commit.count` |
| **Metrics** (histograms) | 1 | `edit.survival_rate` |
| **Events** (log records) | 7 | `edit.feedback`, `edit.hunk.action`, `inline.done`, `edit.survival`, `user.action`, `user.feedback`, `cloud.session.invoke`, `cloud.pr_ready` |
| **Trace** (span attributes) | 2 | `codeblock_count`+`edit_step_count`+`working_set_count` on `invoke_agent`; `prompt_render_duration_ms` on `invoke_agent` |
| **Trace** (span events) | 2 | `summarization_failed`, `summarization_applied` on `invoke_agent` |
| **Skipped** | 8 | #6 (duplicate), #19-20 (debug), #21-22 (already bridged), #24-25, #27-28 (low value) |

---

## Implementation Plan

### Phase 1: Platform OTel helpers

Add event emitters to `src/platform/otel/common/genAiEvents.ts`:
- `emitEditFeedbackEvent()` — for #1 panel.edit.feedback
- `emitEditHunkActionEvent()` — for #2 edit.hunk.action
- `emitEditSurvivalEvent()` — for #11-14 all survival tracking
- `emitUserActionEvent()` — for #3-5, #7 copy/insert/apply/followup
- `emitUserFeedbackEvent()` — for #8-9 vote/rating
- `emitInlineDoneEvent()` — for #10 inline.done
- `emitCloudSessionInvokeEvent()` — for #23 cloud session invoke

Add metrics to `src/platform/otel/common/genAiMetrics.ts`:
- `incrementEditAcceptCount()`
- `incrementEditHunkCount()`
- `incrementLinesOfCode()`
- `recordEditSurvivalRate()`
- `incrementUserActionCount()`
- `incrementUserFeedbackCount()`
- `incrementPullRequestCount()`
- `incrementCommitCount()`

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
