# Sprint Plan — Chat Extension OTel Finalization

Sprint to complete all remaining OTel work in the chat extension repo before moving to the eval repo.

## Tasks

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Unit tests: `messageFormatters.ts` | ✅ | 18 tests — toInputMessages, toOutputMessages, toSystemInstructions, toToolDefinitions |
| 2 | Unit tests: `genAiEvents.ts` | ✅ | 9 tests — all 4 emitters, content capture on/off, error handling |
| 3 | Unit tests: `fileExporters.ts` | ✅ | 5 tests — write/read round-trip for span, log, metric + aggregation temporality |
| 4 | Add token usage metrics to inference span | ✅ | gen_ai.client.token.usage (input/output) in fetchMany success path |
| 5 | Add TTFT metric to inference path | ✅ | copilot_chat.time_to_first_token histogram in fetchMany |
| 6 | Export index barrel — ensure all public types exported | ✅ | Audited, already complete |
| 7 | Build check + lint | ✅ | 63 tests pass, 0 TS errors |
| 8 | Push | ✅ | 2 commits pushed to zhichli/otel |

## Hiccups & Notes

- No blockers encountered. All tasks completed smoothly.
- Index barrel audit showed all exports were already in place — no changes needed.
- Total OTel test coverage: 63 tests across 6 test files.
