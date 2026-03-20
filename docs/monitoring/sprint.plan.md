# Sprint Plan — OTel Docs Consolidation & Test Gaps

## Tasks (prioritized)

1. **Merge arch+spec docs** — Combine `agent_monitoring_arch.md` and `agent-otel-spec.md` into a single `agent_monitoring_arch.md` that covers all agents (foreground, CLI background, CLI terminal, Claude)
2. **Clean up otel-data-flow.html** — Remove stale BLOCKER text, update info cards to reflect working bridge
3. **Move offline docs** — Move `agent-otel-plan.md` and `agent-otel-test.md` to `~/Documents/` (not needed in PR)
4. **Add bridge processor unit tests** — `copilotCliBridgeSpanProcessor.spec.ts`
5. **Add span naming/display tests** — Test `completedSpanToDebugEvent` changes (unknown skip, displayName)
6. **Document SDK internal access risk** — Add warning about `_spanProcessors` hack in merged spec
7. **Ensure CLI OTel always on for debug panel** — SDK OTel must initialize regardless of user config for debug panel; user OTLP export still gated on config
8. **Update plan.md** — Sync moved plan doc with actual implementation
9. **Build check** — Run build, fix any issues
10. **Push**

## Hiccups & Notes
(filled during execution)
