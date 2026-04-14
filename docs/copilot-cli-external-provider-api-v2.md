# External Provider API Contract for Copilot CLI Session

## Problem
External or local model providers are hard to use in Copilot CLI chat sessions because provider registration and CLI-session routing behavior are not clearly defined as an extension-facing contract.

## Goal
Define a proposed API contract that allows extension authors to expose external providers for the Copilot CLI session type while preserving current defaults.

## Scope
This proposal is specification-only.
No default runtime behavior change is introduced.
Any behavior change is gated and opt-in.

## API Surfaces

### 1) Provider registration (proposed API)
Use language model chat provider registration to contribute models.

Contract points:
- provider vendor/id/family/version are discoverable
- capabilities are explicit (tools, images, etc.)
- optional per-model configuration schema is supported

### 2) copilotcli session routing and visibility
For copilotcli sessions, model picker and model resolution should allow explicitly eligible external providers.

Contract points:
- session type aware model visibility
- eligibility rule is explicit and testable
- external provider models can be selected when policy allows

### 3) Chat participant is sibling, not replacement
A chat participant may orchestrate requests but does not replace provider registration.
Provider registration remains the primary model exposure mechanism.

## Proposed Extension-Facing Contract
- Session policy field to declare external-provider eligibility for copilotcli
- Capability metadata for provider models used in copilotcli
- Deterministic precedence for model selection:
  1. explicit user selection in session
  2. session-allowed external provider default
  3. existing current default behavior

## Safety and Rollout
- feature flag gate (off by default)
- enterprise/admin policy gate
- explicit user opt-in for external providers
- telemetry for selection, failures, fallback rates
- safe fallback to current behavior on validation/routing failure

## Backward Compatibility
- Existing users and sessions remain unchanged by default
- Existing providers continue to function as-is
- Existing internal routing remains default until opt-in gates are enabled

## Acceptance Criteria
- Extension can register external provider models under proposed API
- In copilotcli session, eligible external models are visible when gates are enabled
- Selection and request flow succeeds end-to-end
- Fallback to current default occurs on invalid config or provider failure
- No behavior change when gates are disabled

## Test Plan
- Unit tests for routing eligibility and precedence
- Integration tests for copilotcli session model visibility
- Regression tests for default path when gates are disabled
- Failure-path tests for provider errors and invalid config

## Non-Goals
- Changing default model behavior globally
- Guaranteeing compatibility for every third-party provider
- Shipping GA behavior in this proposal
