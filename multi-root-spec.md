# Plan: Multi-Root Workspace Support for Copilot CLI Sessions

## TL;DR

Add a "Multi-root" option to the Copilot CLI session folder dropdown so users can operate across all workspace folders simultaneously. The primary folder is inferred from context (attachments, open editor, etc.), additional folders become `additionalWorkspaces`. For worktree mode, worktrees are created for each git repo. The SDK Fleet API orchestrates multi-folder work. Commits, checkpoints, change tracking, and permissions all expand to cover all folders. Existing infrastructure (`IChatSessionMetadataStore.getAdditionalWorkspaces/setAdditionalWorkspaces`, prompt resolver `additionalWorkspaces` param) is reused — currently wired with empty arrays.

---

## Existing Infrastructure (already implemented, reuse as-is)

- `IChatSessionMetadataStore.getAdditionalWorkspaces()/setAdditionalWorkspaces()` — fully implemented in `chatSessionMetadataStoreImpl.ts:252-271`
- `ChatSessionMetadataFile.additionalWorkspaces` array — already defined
- `copilotcliPromptResolver.resolvePrompt()` — already accepts `additionalWorkspaces: IWorkspaceInfo[]`
- `buildFolderToWorktreeMap()` — already iterates primary + additional workspaces
- `translateWorkspaceUriToWorkingDirectoryUri()` + `findMatchingWorktree()` — already handle multi-workspace
- Tests for metadata store additional workspaces — already passing

---

## Steps

### Phase A: Foundation (additive, no behavior change)

**1. Add `findOwningWorkspace()` utility** *(no dependencies)*
- File: `src/extension/chatSessions/common/workspaceInfo.ts`
- New exported function that given a file URI, searches `[primaryWorkspace, ...additionalWorkspaces]` for the owning workspace
- Uses `extUriBiasedIgnorePathCase.isEqualOrParent()` to check against `getWorkingDirectory(ws)`, `ws.folder`, and `ws.repository`
- Used by: permission checks, file edit confirmation, session workspace membership

**2. Add `additionalWorkspaces` to `CopilotCLISessionOptions`** *(no dependencies)*
- File: `src/extension/chatSessions/copilotcli/node/copilotCli.ts`
- Add `public readonly additionalWorkspaces: IWorkspaceInfo[]` field
- Add `additionalWorkspaces?: IWorkspaceInfo[]` to constructor options
- Default to `[]` when not provided
- `toSessionOptions()` unchanged — SDK only gets primary `workingDirectory`; additional folders go via Fleet API

**3. Expose `additionalWorkspaces` on `ICopilotCLISession` interface** *(depends on step 2)*
- File: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`
- Add `readonly additionalWorkspaces: IWorkspaceInfo[]` to `ICopilotCLISession` interface
- Implement as getter: `return this._options.additionalWorkspaces`

**4. Add new methods to `IChatSessionWorktreeService`** *(no dependencies)*
- File: `src/extension/chatSessions/common/chatSessionWorktreeService.ts`
- New methods:
  - `getAdditionalWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties[]>`
  - `setAdditionalWorktreeProperties(sessionId: string, properties: ChatSessionWorktreeProperties[]): Promise<void>`
  - `handleRequestCompletedForWorktree(worktreeProperties: ChatSessionWorktreeProperties): Promise<void>`
- Implementation file: `src/extension/chatSessions/vscode-node/chatSessionWorktreeServiceImpl.ts`
  - `getAdditionalWorktreeProperties`: reads from metadata store's `getAdditionalWorkspaces()`, extracts `worktreeProperties`
  - `setAdditionalWorktreeProperties`: wraps into `IWorkspaceInfo[]` and calls `setAdditionalWorkspaces()`
  - `handleRequestCompletedForWorktree`: same commit logic as existing `handleRequestCompleted()` but takes properties directly — refactor existing `handleRequestCompleted` to internally call this to avoid duplication

**5. Add `additionalCheckpointRefs` to `RequestDetails`** *(no dependencies)*
- File: `src/extension/chatSessions/common/chatSessionMetadataStore.ts`
- Add `additionalCheckpointRefs?: { [folderPath: string]: string }` to `RequestDetails`
- `checkpointRef` preserved for backward compat (primary workspace)
- Keys are `folder.fsPath` values for deterministic lookup

---

### Phase B: Session Service Plumbing (pass-through)

**6. Update session service to accept `additionalWorkspaces`** *(depends on steps 2, 3)*
- File: `src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts`
- Add `additionalWorkspaces?: IWorkspaceInfo[]` to `createSession()` options
- Add `additionalWorkspaces?: IWorkspaceInfo[]` to `getSession()` options
- Pass through to `CopilotCLISessionOptions` constructor
- In `getSession()` for existing sessions: load from `_chatSessionMetadataStore.getAdditionalWorkspaces(sessionId)` if not provided in options
- In `forkSession()`: copy additional workspaces metadata to new session via `_chatSessionMetadataStore.setAdditionalWorkspaces(newSessionId, ...)`

---

### Phase C: UI — Multi-Root Dropdown

**7. Add "Multi-root" dropdown item and state tracking** *(no dependencies)*
- Files:
  - `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`
  - `src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts` (if dropdown items defined here)

**7a. State map** — Add `_sessionMultiRoot = new Map<string, boolean>()` alongside existing `_sessionBranch`, `_sessionIsolation` maps

**7b. Dropdown item** — In `getRepositoryOptionItems()` (~line 909), after sorting, prepend a "Multi-root" item when `repositories.length > 1`:
- `{ id: MULTI_ROOT_OPTION_VALUE, name: l10n.t('Multi-root'), icon: new ThemeIcon('root-folder-opened') }`
- Define constant `MULTI_ROOT_OPTION_VALUE = 'multi-root'`

**7c. Handle selection** — In `provideHandleOptionsChange()` (~line 947), in the `REPOSITORY_OPTION_ID` branch:
- If `update.value === MULTI_ROOT_OPTION_VALUE`: set `_sessionMultiRoot.set(sessionId, true)`, clear `_selectedRepoForBranches`, delete `_sessionBranch`
- On any other folder selection: `_sessionMultiRoot.delete(sessionId)`

**7d. Hide branch dropdown** — When multi-root is selected, `_selectedRepoForBranches = undefined` ensures branch option group is omitted from `provideChatSessionProviderOptions()`

**7e. Lock label** — In `lockRepoOptionForSession()` (~line 1335), show "Multi-root" as locked label when multi-root was selected

---

### Phase D: Primary Folder Inference

**8. Add primary folder inference helpers** *(depends on step 7)*
- File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`

**8a. `_determinePrimaryFolder(request, workspaceFolders): Uri`** — for new sessions:
  1. File attachment/reference in `request.references` → find owning workspace folder
  2. Active editor → `vscode.window.activeTextEditor?.document.uri` → find owning folder
  3. First workspace folder as fallback

**8b. `_inferPrimaryFolderFromRequest(request, session): IWorkspaceInfo`** — for subsequent requests on existing multi-root sessions:
  - Same precedence, but searches across `[session.workspace, ...session.additionalWorkspaces]`
  - Falls back to existing `session.workspace`

---

### Phase E: Multi-Root Working Directory Initialization (core logic)

**9. Modify `getOrInitializeWorkingDirectory()`** *(depends on steps 7, 8)*
- File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`

**9a. Change return type** to include `additionalWorkspaces: IWorkspaceInfo[]`

**9b. New session branch** — detect `_sessionMultiRoot.get(id)`:
- If true: call new `_initializeMultiRootWorkingDirectories()`
- Otherwise: existing single-folder path, return `additionalWorkspaces: []`

**9c. Existing session branch** — load from metadata:
```
const additionalWorkspaces = await this.chatSessionMetadataStore.getAdditionalWorkspaces(id);
```

**9d. New `_initializeMultiRootWorkingDirectories()` helper:**
1. Get all workspace folders via `workspaceService.getWorkspaceFolders()`
2. Pick primary via `_determinePrimaryFolder(request, folders)`
3. Get isolation mode from `_sessionIsolation.get(sessionId)`
4. Initialize primary via `folderRepositoryManager.initializeFolderRepository(sessionId, ...)`
5. Initialize remaining folders in parallel: `Promise.allSettled(otherFolders.map(folder => ...))`
   - For worktree mode: create worktrees for git repos, pass through non-git folders
   - For workspace mode: no worktrees, just track folders
6. Filter out failed/untrusted
7. Return `{ workspaceInfo: primary, additionalWorkspaces: others, ... }`

**10. Update `getOrCreateSession()`** *(depends on step 9)*
- Pass `additionalWorkspaces` to `sessionService.createSession()` / `getSession()`
- For new sessions: `chatSessionMetadataStore.setAdditionalWorkspaces(sessionId, additionalWorkspaces)`

**11. Update `resolvePrompt` call sites** *(depends on step 3)*
- Lines 1360, 1365, 1833 in `copilotCLIChatSessionsContribution.ts`
- Replace hardcoded `[]` with `session.object.additionalWorkspaces`

---

### Phase F: Permission & File Edit Handling

**12. Refactor `isFileFromSessionWorkspace()` in session** *(depends on steps 1, 3)*
- File: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`
- Use `findOwningWorkspace(file, this.workspace, this.additionalWorkspaces)` instead of single-folder check

**13. Extend write auto-approval for additional workspaces** *(depends on steps 1, 3)*
- File: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`
- After existing primary auto-approval check, add:
  ```
  if (!autoApprove && this.additionalWorkspaces.length > 0) {
      autoApprove = await this._isWriteAutoApprovedInAdditionalWorkspaces(editFile, ...);
  }
  ```
- New private method `_isWriteAutoApprovedInAdditionalWorkspaces()`: uses `findOwningWorkspace()` to find matching workspace, applies same isolation/confirmation logic

**14. Use correct working directory for permission calls** *(depends on step 1)*
- File: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts` (~line 974)
- When calling `requestPermission()`, resolve correct `workingDirectory` via `findOwningWorkspace(editFile, ...)`
- Pass resolved `workingDirectory` to `getConfirmationToolParams()` so file edit diffs use correct folder context

**15. Update `getFileEditConfirmationToolParams` caller** *(depends on step 14)*
- File: `src/extension/chatSessions/copilotcli/node/permissionHelpers.ts`
- The caller (`getConfirmationToolParams`) already receives `workingDirectory` — ensure the resolved directory from step 14 is what flows through
- For shell command confirmations: ensure the correct folder context is shown

---

### Phase G: Fleet API Integration

**16. Add fleet invocation in `sendRequestInternal()`** *(depends on step 3)*
- File: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`
- After `await this._sdkSession.send(sendOptions)`, if `!steering && this.additionalWorkspaces.length > 0`:
  - Call new private method `_startFleetAndWaitForIdle(input)`
- New method:
  ```
  private async _startFleetAndWaitForIdle(input): Promise<void>
  1. Extract prompt from input
  2. Call this._sdkSession.fleet.start({ prompt })
  3. If result.started: await new Promise(resolve => {
       const off = this._sdkSession.on('session.idle', () => { off(); resolve(); });
     })
  4. Catch and log errors
  ```

---

### Phase H: Commit & Checkpoint for All Folders

**17. Modify `commitWorktreeChangesIfNeeded()`** *(depends on steps 3, 4)*
- File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`
- Extract existing primary workspace commit logic into `_commitPrimaryWorkspace(session)` — no logic change, just reorganization
- After primary commit, if `session.additionalWorkspaces.length > 0`: call `_commitAdditionalWorkspaces(session)`

**18. New `_commitAdditionalWorkspaces()` helper** *(depends on step 4)*
- Uses `Promise.allSettled()` to commit in parallel
- For each additional workspace:
  - If `isIsolationEnabled(ws)`: call `copilotCLIWorktreeManagerService.handleRequestCompletedForWorktree(ws.worktreeProperties!)`
  - Else: call `workspaceFolderService.handleRequestCompleted(getWorkingDirectory(ws)!)`
- Log per-folder failures without blocking others

**19. New `_createAdditionalCheckpoints()` helper** *(depends on step 5)*
- After primary checkpoint, create checkpoints for additional worktrees in parallel
- Store results in `additionalCheckpointRefs` via `chatSessionMetadataStore.updateRequestDetails()`

---

### Phase I: Change Tracking for All Folders

**20. Modify change tracking in `toChatSessionItem()`** *(depends on steps 3, 4)*
- File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts`
- After existing primary workspace changes collection, load additional workspaces from metadata
- If any: call new `_getAdditionalWorkspaceChanges(sessionId, additionalWorkspaces)` and merge changes
- New helper iterates each workspace: worktree → worktree service; workspace → `workspaceFolderService.getWorkspaceChanges()`

**21. Session visibility in multi-root** *(depends on step 20)*
- A session is relevant if ANY of its tracked folders (primary or additional) belong to the current open workspace
- Ensure session list doesn't hide multi-root sessions when primary folder is closed but others are open

---

### Phase J: Resume & Fork Flows

**22. Session resume** *(covered by steps 6, 9c)*
- `getSession()` loads `additionalWorkspaces` from metadata store
- `getOrInitializeWorkingDirectory()` for existing sessions loads from metadata
- All downstream consumers (permissions, prompts, commits) receive restored workspaces

**23. Session fork** *(depends on step 6)*
- In `forkSession()`: copy additional workspaces metadata to new session
- If worktree isolation: document whether forked session needs new worktrees (v1: share existing worktrees, flag for future)

---

## Relevant Files

| File | Changes |
|------|---------|
| `src/extension/chatSessions/common/workspaceInfo.ts` | Add `findOwningWorkspace()` — reuse `getWorkingDirectory()`, `isIsolationEnabled()` |
| `src/extension/chatSessions/copilotcli/node/copilotCli.ts` | Add `additionalWorkspaces` field to `CopilotCLISessionOptions` class |
| `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts` | Expose `additionalWorkspaces` on interface+class, multi-folder permission checks via `findOwningWorkspace()`, fleet API in `sendRequestInternal()`, `_isWriteAutoApprovedInAdditionalWorkspaces()` |
| `src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts` | `createSession()`/`getSession()`/`forkSession()` accept & pass `additionalWorkspaces` |
| `src/extension/chatSessions/copilotcli/node/permissionHelpers.ts` | Caller passes resolved `workingDirectory` from `findOwningWorkspace()` |
| `src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts` | Change tracking in `toChatSessionItem()` for additional workspaces, session visibility |
| `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts` | Multi-root state map, dropdown item, `_initializeMultiRootWorkingDirectories()`, `_determinePrimaryFolder()`, `_commitAdditionalWorkspaces()`, `_createAdditionalCheckpoints()`, update `resolvePrompt` call sites, `lockRepoOptionForSession()` |
| `src/extension/chatSessions/common/chatSessionMetadataStore.ts` | Add `additionalCheckpointRefs` to `RequestDetails` |
| `src/extension/chatSessions/common/chatSessionWorktreeService.ts` | New interface methods: `getAdditionalWorktreeProperties`, `setAdditionalWorktreeProperties`, `handleRequestCompletedForWorktree` |
| `src/extension/chatSessions/vscode-node/chatSessionWorktreeServiceImpl.ts` | Implement new methods, refactor `handleRequestCompleted` to call `handleRequestCompletedForWorktree` internally |

## Code to Reuse (no modification needed)

| Code | Location |
|------|----------|
| `getAdditionalWorkspaces()` / `setAdditionalWorkspaces()` | `chatSessionMetadataStoreImpl.ts:252-271` |
| `buildFolderToWorktreeMap()` | `copilotcliPromptResolver.ts:58-69` |
| `translateWorkspaceUriToWorkingDirectoryUri()` | `copilotcliPromptResolver.ts:304-320` |
| `findMatchingWorktree()` | `copilotcliPromptResolver.ts:322-336` |
| `IWorkspaceInfo`, `getWorkingDirectory()`, `isIsolationEnabled()`, `emptyWorkspaceInfo()` | `workspaceInfo.ts` |
| `ChatSessionWorktreeProperties` types | `chatSessionWorktreeService.ts:25-50` |
| Metadata store additional workspaces tests | `chatSessionMetadataStoreImpl.spec.ts:1448-1619` |

---

## Verification

1. **Compile check**: Run `start-watch-tasks` — zero errors across all watchers
2. **Unit tests for `findOwningWorkspace()`**: files in primary, additional, outside, nested repos
3. **Unit tests for `_determinePrimaryFolder()`**: attachment > active editor > first folder precedence
4. **Unit tests for `_isWriteAutoApprovedInAdditionalWorkspaces()`**: isolation vs workspace mode
5. **Unit tests for `_commitAdditionalWorkspaces()`**: parallel commits, partial failure handling
6. **Unit tests for `_getAdditionalWorkspaceChanges()`**: aggregates from worktree + workspace folders
7. **Existing metadata store tests**: verify no regressions (already cover additional workspaces)
8. **Existing prompt resolver tests**: verify multi-workspace translation (already cover `additionalWorkspaces`)
9. **Manual: multi-root workspace (2+ git repos)**: select "Multi-root" → worktree isolation → verify worktrees created for all repos
10. **Manual: multi-root workspace**: select "Multi-root" → workspace mode → verify no worktrees, folders tracked
11. **Manual: send request** → verify fleet API invoked, session completes, edits in any folder auto-approved
12. **Manual: post-request** → verify commits/staging in all folders, checkpoints created, changes panel shows all
13. **Manual: resume/fork** → verify additional workspaces restored/copied
14. **Regression: single-root sessions** → verify completely unaffected (all paths gated on `additionalWorkspaces.length > 0`)

---

## Decisions

- `checkpointRef` stays as primary workspace checkpoint (backward compat); `additionalCheckpointRefs` added as separate field keyed by `fsPath`
- Branch dropdown hidden when multi-root selected (v1 simplification — each repo uses its HEAD/default)
- `toSessionOptions()` unchanged — only primary `workingDirectory` sent to SDK; additional folders via Fleet API
- New private methods (`_commitAdditionalWorkspaces`, `_isWriteAutoApprovedInAdditionalWorkspaces`, etc.) keep public surface simple
- `Promise.allSettled` for parallel initialization/commit — partial failures logged but don't block other folders
- Multi-root option only shown when `repositories.length > 1` in the dropdown
