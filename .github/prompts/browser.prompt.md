---
agent: agent
model: Claude Opus 4.5 (Preview) (copilot)
---
## Plan: Browser Verification Tool with Playwright

Implement a native browser verification tool using Playwright directly bundled in the extension, enabling agents to automatically validate web applications after code changes with screenshots and validation reports in chat.

### Steps

1. **Add Playwright dependency** in [`package.json`](package.json) and configure bundling in [`.esbuild.ts`](.esbuild.ts) to handle Playwright's binary requirements appropriately

2. **Register tool schema** by adding `BrowserVerification = 'browser_verification'` to [`src/extension/tools/common/toolNames.ts`](src/extension/tools/common/toolNames.ts) and contributing the tool definition in [`package.json`](package.json) with parameters: `url`, `actions[]` (optional click/type/scroll), `validateElements[]` (optional CSS selectors)

3. **Create `browserVerificationTool.tsx`** in [`src/extension/tools/node/`](src/extension/tools/node/) implementing `ICopilotTool` with: Playwright chromium launch, page navigation, action execution, screenshot capture via `page.screenshot()`, console log interception, and element validation

4. **Return structured results** as `LanguageModelToolResult` with `LanguageModelDataPart` for PNG screenshot and `LanguageModelTextPart` for validation report (console errors, element checks pass/fail, timing metrics)

5. **Import in [`allTools.ts`](src/extension/tools/node/allTools.ts)** and update agent instructions in [`agentInstructions.tsx`](src/extension/prompts/node/agent/agentInstructions.tsx) to use verification tool after making UI changes to web applications

6. **Add confirmation flow** in `prepareInvocation()` requiring user approval before launching browser, similar to [`simpleBrowserTool.tsx`](src/extension/tools/node/simpleBrowserTool.tsx) pattern

### Further Considerations

1. **Playwright browser management**: Should we use a persistent browser context across verification calls in a session, or launch fresh each time? *Recommendation: Fresh launch for isolation, but cache the browser instance per session for performance*

2. **Headless vs headed mode**: Default to headless for speed, but should we expose a setting for headed debugging? *Recommendation: Headless default with `github.copilot.chat.browserVerification.headed` setting*

3. **Port/URL detection**: Should the tool auto-detect running dev servers (like Cursor does), or always require explicit URL? *Recommendation: Start with explicit URL, add auto-detection as enhancement*
