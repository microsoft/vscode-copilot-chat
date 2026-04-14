# RFC: Support external language model providers in Copilot CLI

## Summary
Add support for external (third-party) language model providers in Copilot CLI. Currently, the CLI model picker only surfaces GitHub's built-in models; custom providers that work in Chat cannot be used in CLI workflows.

## Problem
Users with custom language model providers (e.g., Ollama, local models, enterprise custom endpoints) can register them via the LanguageModelChatProvider API and use them in VS Code Chat. However, Copilot CLI explicitly gates external providers from its model picker based on:
- `customAgentTarget="github-copilot"` (chat session type requires this)
- `requiresCustomModels=true` (feature flag requiring custom models)

This creates an asymmetry: Chat supports external providers, but CLI does not. Users who want unified model access across Chat and CLI workflows are forced to choose one interface.

## API Design
Add an optional field to the LanguageModelChatProvider API and a feature gate:

### Extension Manifest (vscode.d.ts)
```typescript
interface LanguageModelChatProvider {
  // ... existing fields ...
  
  // Optional field indicating this provider supports Copilot CLI
  // Default: false (maintains backward compatibility)
  supportsCopilotCli?: boolean;
}
```

### Feature Gate
Add boolean feature flag:
```
allowExternalCliProviders: false  // default; enable to allow external providers in CLI model picker
```

### CLI Eligibility Filter
Update Copilot CLI model discovery to:
1. Check if the feature flag `allowExternalCliProviders` is true
2. For external providers, additionally check `provider.supportsCopilotCli === true`
3. Only surface providers that pass both gates

This ensures:
- **Backward compatibility**: All existing external providers default to CLI-hidden (supportsCopilotCli undefined → false)
- **Opt-in governance**: Extension authors explicitly declare CLI support
- **Feature-gated rollout**: Operator can control adoption via flag

## Acceptance Criteria (Minimal Implementation)
- [ ] New field `supportsCopilotCli` added to LanguageModelChatProvider interface in vscode.d.ts
- [ ] Feature flag `allowExternalCliProviders` added to Copilot CLI (GitHub-internal property, accessible to Copilot core)
- [ ] CLI model eligibility gate: Respects both flag and provider declaration
- [ ] Telemetry: Track external provider sourcing in CLI (model origin, enable/disable count)
- [ ] Tests: Unit tests for gate logic (both conditions must be true to surface provider)
- [ ] Backward compatibility: Existing providers hidden without change (opt-in model)

## Non-Goals
- Automatic provider discovery or indexing
- Enforcement of model capabilities (e.g., token limits, tool calling)
- Authentication/security model beyond existing provider contract
- Changes to Chat's provider surfacing logic

## Rollout & Testing
1. **Implementation Phase**: Add API field, feature flag, CLI gate (behind proposed API in VS Code Insiders)
2. **Validation Phase**: 
   - Test with Ollama provider (external, non-Copilot)
   - Test with Microsoft first-party models (GitHub models)
   - Verify feature flag works end-to-end
3. **Stable Rollout**: Move to stable API, enable flag in production version

## Implementation Notes
- Copilot CLI documentation should clarify that external providers are supported only when both conditions are met
- Extension authors should document CLI support status in their provider documentation
- Consider documenting recommended security/latency practices for CLI external providers

## Awaiting Approval
This proposal is ready for maintainer review and feedback. Implementation will proceed only after approval, per VS Code contribution protocol.
