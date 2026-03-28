# Sprint: OTel Agentic Metrics Implementation

## Tasks (prioritized)

1. [x] **Phase 1a**: Add event emitters to `genAiEvents.ts` — 6 new functions
2. [x] **Phase 1b**: Add metrics to `genAiMetrics.ts` — 12 new static methods
3. [x] **Phase 2.1**: Wire userActions.ts — inject IOTelService, emit #1-5, #7-9 (panel edit feedback, hunks, copy/insert/followup/apply, vote)
4. [x] **Phase 2.2**: Wire userActions.ts (inline chat) — emit #10-11 (inline.done, inline survival)
5. [x] **Phase 2.3**: Wire applyPatchTool.tsx — emit #12 (apply_patch survival)
6. [x] **Phase 2.4**: Wire abstractReplaceStringTool.tsx — emit #13 (replace_string survival)
7. [x] **Phase 2.5**: Wire codeMapperService.ts — emit #14 (code_mapper survival)
8. [x] **Phase 2.6**: Wire agentIntent.ts — span events #17-18 (summarization) + counters
9. [x] **Phase 2.7**: Wire editCodeIntent.ts — counter #15 (edit response) — counter only, span not accessible
10. [ ] ~~Phase 2.8: Wire copilotCloudSessionsProvider.ts — #23, #26~~ deferred
11. [ ] ~~Phase 2.9: Wire copilotcliSession.ts — PR + commit counters~~ deferred
12. [x] Build check

## Hiccups & Notes

- #15-16 span attrs not feasible: `editCodeIntent.ts` doesn't hold the OTel span handle — it's encapsulated in `toolCallingLoop.ts`. Using counter for #15 instead. #16 (prompt render) deferred — not worth threading span for minor perf attr.
- #23/26/CLI sessions: Deferred — these files are large and complex, need more careful injection to avoid regressions. Will tackle in follow-up PR.
- agentIntent.ts #17-18: Need to check how the span handle flows to where summarization events fire.
