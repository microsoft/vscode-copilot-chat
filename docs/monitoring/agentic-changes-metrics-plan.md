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

copilot_chat.edit.survival                     ← #11-14 all trackEditSurvival events
├── event.name: 'copilot_chat.edit.survival'
├── edit_source: 'apply_patch' | 'replace_string' | 'code_mapper' | 'inline_chat'
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
copilot_chat.agent.edit_response               ← #15 panel.edit.codeblocks
├── event.name: 'copilot_chat.agent.edit_response'
├── outcome: 'success' | 'error'
├── codeblock_count: number
├── edit_step_count: number
├── session_duration_ms: number
└── working_set_count: number

copilot_chat.agent.summarization               ← #17-18 triggerSummarizeFailed, backgroundSummarizationApplied
├── event.name: 'copilot_chat.agent.summarization'
├── outcome: 'applied' | 'failed'
├── trigger: string
├── error_kind?: string
├── context_ratio?: number
└── model: string
```

### Category D: Cloud/Remote Agent Sessions

```
copilot_chat.cloud.session.invoke              ← #23 copilotcloud.chat.invoke
├── event.name: 'copilot_chat.cloud.session.invoke'
├── partner_agent: 'copilot' | 'claude' | 'codex'
├── model: string
├── request_id: string
└── is_untitled: boolean

copilot_chat.cloud.pr_ready                    ← #26 remoteAgentJobPullRequestReady
├── event.name: 'copilot_chat.cloud.pr_ready'
└── request_id: string
```

### New Metrics (Counters & Histograms)

| Metric Name | Type | Attributes | Source Events |
|-------------|------|------------|---------------|
| `copilot_chat.edit.accept.count` | Counter | `outcome`, `edit_surface` | #1, #10 |
| `copilot_chat.edit.hunk.count` | Counter | `outcome` | #2 |
| `copilot_chat.lines_of_code.count` | Counter | `type` (added/removed), `language_id` | #2 (on accept) |
| `copilot_chat.edit.survival_rate` | Histogram | `edit_source`, `time_delay_ms` | #11-14 |
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
- `emitEditSurvivalEvent()` — for #11-14 all survival tracking
- `emitUserActionEvent()` — for #3-7 copy/insert/apply/followup
- `emitUserFeedbackEvent()` — for #8-9 vote/rating
- `emitInlineDoneEvent()` — for #10 inline.done
- `emitAgentEditResponseEvent()` — for #15 panel.edit.codeblocks
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

| # | File | Events to Emit | Approach |
|---|------|----------------|----------|
| 1 | `src/extension/conversation/vscode-node/userActions.ts` | #1-9 (edit feedback, hunk, copy, insert, followup, apply, vote) | Inject `@IOTelService` into `UserFeedbackService` constructor |
| 2 | `src/extension/conversation/vscode-node/userActions.ts` | #10-11 (inline.done, inline.trackEditSurvival) | Same service, inline chat path |
| 3 | `src/extension/tools/node/applyPatchTool.tsx` | #12 (apply_patch survival) | Inject `@IOTelService` into tool constructor |
| 4 | `src/extension/tools/node/abstractReplaceStringTool.tsx` | #13 (replace_string survival) | Inject `@IOTelService` into tool constructor |
| 5 | `src/extension/prompts/node/codeMapper/codeMapperService.ts` | #14 (code mapper survival) | Pass `IOTelService` to survival callback |
| 6 | `src/extension/intents/node/editCodeIntent.ts` | #15 (panel.edit.codeblocks) | Already has access via toolCallingLoop |
| 7 | `src/extension/intents/node/agentIntent.ts` | #17-18 (summarization) | Already has `IOTelService` nearby |
| 8 | `src/extension/chatSessions/vscode-node/copilotCloudSessionsProvider.ts` | #23, #26 (cloud session invoke, PR ready) | Inject `@IOTelService` |
| 9 | `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts` | PR count, commit count | Inject `@IOTelService` |

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
