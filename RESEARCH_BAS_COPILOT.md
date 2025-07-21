# Research Plan: Integrating GitHub Copilot Chat with SAP AI Core in BAS

## Background & Motivation

Business Application Studio (BAS) is exploring the option of moving from Joule-based AI assistance to a more customizable, open-source approach using GitHub Copilot Chat.
The goal is to add SAP AI Core as a provider, supporting custom models and MCP (Model-Connected Plugins) tool-calling for domain-specific developer workflows (e.g., CAP, Fiori).
This will allow richer AI capabilities, tighter SAP integration, and enterprise-level controls.

---

## Core Research Tasks & Future Work

### 1. Provider and Extension Architecture

- [ ] Understand Copilot Chat OSS architecture and LLM provider plug-in points.
- [ ] Implement basic SAP AI Core provider and integrate into Copilot.
- [ ] Refactor provider to support streaming responses for real-time AI chat (currently responses are not streamed).
- [ ] Properly fork the Copilot Chat repo to allow for long-term maintainability and easier upstream syncs (similar to how “Continue AI” was handled).
- [ ] Review and improve all error handling, token counting, and prompt formatting to be robust against edge cases.

### 2. Secure Cloud/BAS Integration

- [ ] Replace file-based credential loading (ai-core-creds.json) with runtime credential acquisition.
- [ ] Ensure credential usage (direct file) is feature-toggled and only available in local/dev.
- [ ] In BAS production, ensure **all** AI Core API calls are routed via the `/llm` BAS proxy endpoint.
    - [ ] Example: see `bas-llm-proxy.ts` and `getLLMServiceUrl()`.
- [ ] Reuse code/approach from the MCP Server extension, especially for proxy logic.
- [ ] Review for any hardcoded credentials or endpoints, and document secret-handling best practices.

### 3. Streaming & Real-Time User Experience

- [ ] Implement streaming support in SAP AI Core provider (send tokens/chunks as they arrive).
- [ ] Test UI/UX for responsiveness with long model outputs and user prompts.
- [ ] Validate compatibility with Copilot’s chat UI (progress updates, error boundaries, etc).

### 4. Tool Calling / MCP Workflow

- [ ] Document and test end-to-end tool call flow:
    - [ ] User asks a question.
    - [ ] Model emits tool call (function) in response.
    - [ ] Tool executes (e.g., MCP “weather”, CAP actions).
    - [ ] Model resumes conversation with results.
- [ ] Validate for multiple sequential/parallel tool calls.
- [ ] Test with real MCP integration for CAP project creation or other SAP-specific scenarios.
- [ ] Ensure Copilot gracefully handles tool errors, user cancellations, or partial tool results.

### 5. Forking & Upstream Sync Strategy

- [ ] Create a proper GitHub fork of Copilot Chat OSS.
- [ ] Add documentation (`FORK_NOTES.md`) on how to:
    - [ ] Rebase and merge from upstream.
    - [ ] Track local changes (especially SAP AI Core provider).
    - [ ] Apply/undo BAS-specific patches or toggles.
- [ ] Consider CI for testing fork upgrades before merging to BAS mainline.

### 6. Other Technical Tasks

- [ ] Ensure model metadata, token limits, and capabilities are properly detected and exposed in the provider.
- [ ] Refactor for robust logging, diagnostics, and error transparency (for troubleshooting).
- [ ] Document usage, configuration, and limitations in a `README_BAS_COPILOT.md` (for BAS developers).

---

## Bonus: Example Code References

- [ ] **BAS Proxy for LLM** (`bas-llm-proxy.ts`)
- [ ] **Credential/environment toggle** (see usage of `AICORE_SERVICE_KEY` vs. proxy)
- [ ] **Continue AI** fork for forking best practices

---

## Immediate To-Do List

- [ ] Replace local file-based credentials with feature-toggled runtime credential loading.
- [ ] Move all model requests through the `/llm` BAS proxy when in production/BAS.
- [ ] Refactor provider to support streaming completions.
- [ ] Create fork, document patching/upstream sync process.
- [ ] Test MCP tool-calling with CAP/Fiori integration.
- [ ] Document error cases and edge conditions.
- [ ] Add integration/unit tests for core Copilot provider logic.

---

## Optional/Advanced

- [ ] Explore UI/UX customizations for Copilot Chat in BAS (branding, feedback links, etc).
- [ ] Implement telemetry to track extension adoption and usage (opt-in, privacy-compliant).

---

