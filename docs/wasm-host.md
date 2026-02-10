---
name: WASM Host Adapter (Stub)
---

# WASM Host Adapter (Stub)

This repository includes a minimal host abstraction to support alternate runtimes such as the Logos WASM extension standard.

## Overview

- `src/host/host.ts` defines the `CopilotChatHost` interface.
- `src/host/vscodeHost.ts` provides the default VS Code implementation.
- `src/host/wasmHost.ts` is a stub for Logos WASM integration.

## Host Selection

By default, the extension uses `VsCodeHost`. To switch to the WASM stub, set:

```
COPILOT_CHAT_HOST=wasm
```

This is a stub only; all methods throw until implemented by the WASM runtime.

## Intended WASM Mapping (Logos)

The expected mapping aligns with the Logos WASM extension standard:

- `getVersion` → `logos.version`
- `getLocale` → `logos.env` locale
- `showMessage` → `logos.env.showMessage`
- `readFile` → `logos.env.fsRead`
- `listWorkspaceRoots` → `logos.workspace.listRoots`
- `storageGet/Set` → `logos.storage`
- `createWebview/postWebviewMessage/onWebviewMessage` → `logos.env.postMessage/readMessage`

## Next Steps

- Implement the Logos WASM host in `src/host/wasmHost.ts`
- Add runtime wiring for message transport and storage
- Add tests or sample harness for WASM host behavior
