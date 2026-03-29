# Multi-Root Workspace Support for Copilot CLI Sessions

## Context

Currently, when a multi-root workspace is open, the Copilot CLI session dropdown shows individual workspace folders and the user picks **one** folder as the session's working directory. The Copilot CLI SDK then operates within that single folder.

This plan adds a **"Multi-root"** option at the top of the dropdown. When selected, the session operates across **all** workspace folders simultaneously:
- Primary folder is chosen based on context (attachments, references, open editor)
- Additional folders are tracked as `additionalWorkspaces` in session metadata
- Worktrees are created for all git repos when isolation mode is active
- The SDK Fleet API (`session.fleet.start()`) orchestrates multi-folder work
- Commits, checkpoints, change tracking, and permissions all expand to cover all folders

## Existing Infrastructure (already implemented, to be reused)

- **`IChatSessionMetadataStore`** already has `getAdditionalWorkspaces(sessionId)` / `setAdditionalWorkspaces(sessionId, workspaces)` (`chatSessionMetadataStore.ts:82-83`)
- **`ChatSessionMetadataFile`** already has `additionalWorkspaces` array (`chatSessionMetadataStore.ts:54-57`)
- **`chatSessionMetadataStoreImpl.ts:252-271`** — full read/write implementation for additional workspaces
- **`copilotcliPromptResolver.ts`** — `buildFolderToWorktreeMap()` and `translateWorkspaceUriToWorkingDirectoryUri()` already accept `additionalWorkspaces: IWorkspaceInfo[]` param
- **SDK Fleet API** — `session.fleet.start({ prompt })` returns `Promise<{ started: boolean }>` (experimental, `@github/copilot/sdk`)
- **SDK session.idle event** — `session.on('session.idle', handler)` fires when agent is idle

---

## Phase A: Foundation (additive, zero behavior change) *(no dependencies)*

All steps in this phase are purely additive — new types, fields, interface methods, and utilities. They can be merged as a standalone PR with zero risk to existing functionality.

### A1. Add `findOwningWorkspace()` utility

**File: `src/extension/chatSessions/common/workspaceInfo.ts`**

Add a single shared utility used consistently by prompt translation, permission resolution, file edit confirmation, and session workspace membership checks:

```typescript
export function findOwningWorkspace(
    file: vscode.Uri,
    primaryWorkspace: IWorkspaceInfo,
    additionalWorkspaces: IWorkspaceInfo[]
): IWorkspaceInfo | undefined {
    for (const ws of [primaryWorkspace, ...additionalWorkspaces]) {
        const wd = getWorkingDirectory(ws);
        if (wd && extUriBiasedIgnorePathCase.isEqualOrParent(file, wd)) return ws;
        if (ws.folder && extUriBiasedIgnorePathCase.isEqualOrParent(file, ws.folder)) return ws;
        if (ws.worktree && ws.repository && extUriBiasedIgnorePathCase.isEqualOrParent(file, ws.repository)) return ws;
    }
    return undefined;
}
```

### A2. Add `additionalWorkspaces` to `CopilotCLISessionOptions`

**File: `src/extension/chatSessions/copilotcli/node/copilotCli.ts`**

```typescript
export class CopilotCLISessionOptions {
    public readonly workspaceInfo: IWorkspaceInfo;
    public readonly additionalWorkspaces: IWorkspaceInfo[];
    // ... existing fields ...

    constructor(options: {
        // ... existing params ...
        additionalWorkspaces?: IWorkspaceInfo[];
    }, private readonly logService: ILogService) {
        // ... existing assignments ...
        this.additionalWorkspaces = options.additionalWorkspaces ?? [];
    }
}
```

`toSessionOptions()` remains unchanged — SDK only receives the primary `workingDirectory`. Additional folders are communicated via the Fleet API.

### A3. Expose `additionalWorkspaces` on `ICopilotCLISession` interface

**File: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`**

Add to `ICopilotCLISession`:
```typescript
readonly additionalWorkspaces: IWorkspaceInfo[];
```

Implement in `CopilotCLISession`:
```typescript
public get additionalWorkspaces(): IWorkspaceInfo[] {
    return this._options.additionalWorkspaces;
}
```

### A4. Add new methods to `IChatSessionWorktreeService`

**File: `src/extension/chatSessions/common/chatSessionWorktreeService.ts`**

```typescript
getAdditionalWorktreeProperties(sessionId: string): Promise<ChatSessionWorktreeProperties[]>;
setAdditionalWorktreeProperties(sessionId: string, properties: ChatSessionWorktreeProperties[]): Promise<void>;
handleRequestCompletedForWorktree(worktreeProperties: ChatSessionWorktreeProperties): Promise<void>;
```

**File: `src/extension/chatSessions/vscode-node/chatSessionWorktreeServiceImpl.ts`**

- `getAdditionalWorktreeProperties`: Reads from metadata store's `getAdditionalWorkspaces()`, extracts worktree properties
- `setAdditionalWorktreeProperties`: Writes to metadata store's `setAdditionalWorkspaces()`
- `handleRequestCompletedForWorktree`: Same logic as existing `handleRequestCompleted()` but takes properties directly instead of looking up by sessionId. The existing `handleRequestCompleted` can be refactored to call this internally to avoid duplicating commit logic.

### A5. Add `additionalCheckpointRefs` to `RequestDetails`

**File: `src/extension/chatSessions/common/chatSessionMetadataStore.ts`**

```typescript
export interface RequestDetails {
    // ... existing fields ...
    /** Checkpoint reference for this request (primary workspace). */
    checkpointRef?: string;
    /** Checkpoint references for additional workspaces, keyed by folder fsPath. */
    additionalCheckpointRefs?: { [folderPath: string]: string };
}
```

`checkpointRef` is preserved as the compatibility alias for the primary workspace. `additionalCheckpointRefs` uses normalized `fsPath` keys for per-folder checkpoint lookup.

### A6. Add multi-root tracking state map

**File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`**

Add a module-level state map alongside the existing `_sessionBranch` and `_sessionIsolation`:
```typescript
const _sessionMultiRoot = new Set<string>();
```

This is ephemeral state that only lives between dropdown selection and session creation — no other service needs to query it, so a public interface method is unnecessary.

### A7. Extend checkpoint service interface for additional worktrees

**File: `src/extension/chatSessions/common/chatSessionWorktreeCheckpointService.ts`**

Add new methods for baseline and post-turn checkpoints for additional worktrees:
```typescript
export interface IChatSessionWorktreeCheckpointService {
    // ... existing methods ...

    /** Create baseline checkpoints for additional worktrees at request start. */
    handleAdditionalWorktreesRequest(sessionId: string): Promise<void>;

    /** Create post-turn checkpoints for additional worktrees at request completion. */
    handleAdditionalWorktreesRequestCompleted(sessionId: string, requestId: string): Promise<void>;
}
```

**File: `src/extension/chatSessions/vscode-node/chatSessionWorktreeCheckpointServiceImpl.ts`**

- `handleAdditionalWorktreesRequest()`: For each additional workspace with a worktree, create a baseline checkpoint (turn 0). Without this, turn-level diffs cannot be computed for additional folders.
- `handleAdditionalWorktreesRequestCompleted()`: For each additional worktree, create a post-turn checkpoint and store in `additionalCheckpointRefs` via `updateRequestDetails()`.

---

## Phase B: Session Service Plumbing *(depends on A2, A3)*

### B1. Update session service to accept `additionalWorkspaces`

**File: `src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts`**

- Add `additionalWorkspaces?: IWorkspaceInfo[]` to `createSession()` options (~line 516). Pass through to `createSessionsOptions()`.
- Add `additionalWorkspaces?: IWorkspaceInfo[]` to `getSession()` options (~line 644). For existing sessions, load from `_chatSessionMetadataStore.getAdditionalWorkspaces(sessionId)` if not provided.
- Update `createSessionsOptions()` (~line 634) to pass `additionalWorkspaces` to `CopilotCLISessionOptions` constructor. When `additionalWorkspaces` is non-empty, append a multi-root system message listing all folder paths (primary + additional) via `_buildMultiRootSystemMessage()`. This tells the model which folders it can work on. The system message is appended with `mode: 'append'` alongside any existing prompt variables context.
- In `forkSession()` (~line 706): after `copySessionFilesForForking()` copies session state, also copy additional workspaces metadata:
  ```typescript
  const additionalWorkspaces = await this._chatSessionMetadataStore.getAdditionalWorkspaces(sessionId);
  if (additionalWorkspaces.length > 0) {
      await this._chatSessionMetadataStore.setAdditionalWorkspaces(newSessionId, additionalWorkspaces);
  }
  ```

---

## Phase C: UI — Multi-Root Dropdown *(no dependencies)*

**Files:**
- `src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts`
- `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`

### C1. Add "Multi-root" dropdown item

In `getRepositoryOptionItems()` (~line 881), after the existing sorted list is built, prepend a "Multi-root" item when `repositories.length > 1`:
```typescript
if (sorted.length > 1) {
    sorted.unshift({
        id: MULTI_ROOT_OPTION_VALUE,
        name: l10n.t('Multi-root'),
        icon: new vscode.ThemeIcon('root-folder-opened'),
    });
}
```

### C2. Handle multi-root selection

In `provideHandleOptionsChange()` (~line 927), in the `REPOSITORY_OPTION_ID` handling block:
```typescript
if (update.value === MULTI_ROOT_OPTION_VALUE) {
    _sessionMultiRoot.add(sessionId);
    this._selectedRepoForBranches = undefined;
    _sessionBranch.delete(sessionId);
    triggerProviderOptionsChange = true;
    continue;
}
// On any other folder selection, clear multi-root state
_sessionMultiRoot.delete(sessionId);
// ... existing single-folder handling ...
```

### C3. Hide branch dropdown but SHOW isolation dropdown for multi-root

When multi-root is selected, hide the **branch** option group (branches are per-repo, not meaningful for multi-root). However, the **isolation** option group (worktree vs workspace) must still appear so the user can choose.

In the options change handler, when multi-root is detected:
- Set `this._selectedRepoForBranches = undefined` (hides branch dropdown)
- Set `_sessionIsolation` from the last-used value (`LAST_USED_ISOLATION_OPTION_KEY`) so isolation has a default

In `provideChatSessionProviderOptions()`, show the isolation option group when **either** `_selectedRepoForBranches` is set **or** the session is multi-root (and at least one workspace folder has a git repo):
```typescript
const showIsolation = (this._selectedRepoForBranches || _sessionMultiRoot.has(currentSessionId)) && isIsolationOptionFeatureEnabled(this.configurationService);
```

### C4. Update `lockRepoOptionForSession()` (~line 1335)

When multi-root is selected, show "Multi-root" as the locked label. Continue hiding the branch dropdown when locked.

---

## Phase D: Primary Folder Inference *(depends on C1)*

**File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`**

### D1. New private helper: `_determinePrimaryFolder()`

Used during multi-root session initialization to pick which folder becomes primary.

```typescript
private _determinePrimaryFolder(
    request: vscode.ChatRequest,
    workspaceFolders: vscode.Uri[]
): vscode.Uri
```

Deterministic precedence order:
1. **File attachment/reference in the request** — check `request.references` for file URIs, find which workspace folder they belong to
2. **Prompt variable references** — files referenced by prompt variables mapped to a workspace folder
3. **Active editor file** — `vscode.window.activeTextEditor?.document.uri` mapped to a workspace folder
4. **Active repository / workspace folder** — the currently active workspace folder
5. **First folder** — `workspaceFolders[0]` as final fallback

### D2. New private helper: `_inferPrimaryFolderFromRequest()` (for subsequent requests)

For requests after the initial one (the session already exists), re-infer the primary folder from context:
```typescript
private _inferPrimaryFolderFromRequest(
    request: vscode.ChatRequest,
    session: ICopilotCLISession
): IWorkspaceInfo
```
Uses the same precedence as D1 but searches across `[session.workspace, ...session.additionalWorkspaces]`.

---

## Phase E: Multi-Root Working Directory Initialization *(depends on B1, D1)*

**File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`**

### E1. Modify `getOrInitializeWorkingDirectory()` (~line 1751)

Change return type to include `additionalWorkspaces`:
```typescript
Promise<{
    workspaceInfo: IWorkspaceInfo;
    additionalWorkspaces: IWorkspaceInfo[];
    cancelled: boolean;
    trusted: boolean;
}>
```

In the `isNewSession` branch (~line 1767), detect multi-root selection:
```typescript
if (isNewSession) {
    if (_sessionMultiRoot.has(id)) {
        return this._initializeMultiRootWorkingDirectories(id, request, stream, toolInvocationToken, token);
    }
    // ... existing single-folder path, return { ..., additionalWorkspaces: [] } ...
}
```
For existing sessions, load `additionalWorkspaces` from metadata store.

### E2. Add `initializeMultiRootFolderRepositories()` to `IFolderRepositoryManager`

**Files:**
- `src/extension/chatSessions/common/folderRepositoryManager.ts` (interface)
- `src/extension/chatSessions/vscode-node/folderRepositoryManagerImpl.ts` (implementation)

Add a new method to the interface:
```typescript
initializeMultiRootFolderRepositories(
    sessionId: string,
    primaryFolder: vscode.Uri,
    additionalFolders: vscode.Uri[],
    options: InitializeFolderRepositoryOptions,
    token: vscode.CancellationToken
): Promise<{ primary: FolderRepositoryInfo; additional: FolderRepositoryInfo[] }>;
```

**Why a new method instead of calling `initializeFolderRepository` per folder:**
Calling `initializeFolderRepository` individually for each folder would trigger separate trust prompts, separate uncommitted changes prompts, and per-folder cancel semantics. For multi-root, we need a single cohesive flow.

### E2a. Fix `getFolderRepositoryForNewSession` to respect explicit `selectedFolder` parameter

**File: `src/extension/chatSessions/vscode-node/folderRepositoryManagerImpl.ts`**

Pre-existing bug: `getFolderRepositoryForNewSession` unconditionally overwrites the `selectedFolder` parameter with the session's stored folder, ignoring any explicitly passed value. This breaks multi-root initialization which passes each specific folder.

Fix: only fall back to the stored folder when `selectedFolder` is not provided:
```typescript
// Before (bug):
selectedFolder = sessionId ? (this._newSessionFolders.get(sessionId)?.uri ?? ...) : undefined;

// After (fix):
selectedFolder = selectedFolder ?? (sessionId ? (this._newSessionFolders.get(sessionId)?.uri ?? ...) : undefined);
```

**Implementation logic:**
1. **Resolve all folders and repos:** For each folder (primary + additional), call `getFolderRepositoryForNewSession()` to get folder/repo info
2. **Trust check:** Verify trust for all folders. If any folder is untrusted, warn and exclude it (don't prompt per-folder)
3. **Skip worktree creation if workspace mode:** If `isolation === 'workspace'`, return all folders as-is without worktrees
4. **Collect uncommitted changes across ALL git repos:** Gather modified files from all repos that have uncommitted changes into one combined list
5. **Show ONE combined prompt:** Present a single "Uncommitted Changes" confirmation listing files from all affected repos, with a single Move/Copy/Skip/Cancel action that applies to all
6. **If cancelled:** Return cancelled for all
7. **Create worktrees:** For each git repo folder, create a worktree via `worktreeService.createWorktree()`. Use `Promise.allSettled` for parallelism
8. **Migrate changes:** If the user chose move/copy, migrate uncommitted changes from each affected repo to its worktree
9. **Return:** `{ primary: FolderRepositoryInfo, additional: FolderRepositoryInfo[] }` with failed/untrusted folders filtered out

### E2b. Update `_initializeMultiRootWorkingDirectories()` in contribution file

**File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`**

```typescript
private async _initializeMultiRootWorkingDirectories(
    sessionId: string, request: vscode.ChatRequest, stream, toolInvocationToken, token
): Promise<{ workspaceInfo: IWorkspaceInfo; additionalWorkspaces: IWorkspaceInfo[]; cancelled: boolean; trusted: boolean }>
```

Logic:
1. Get all workspace folders via `workspaceService.getWorkspaceFolders()`
2. Pick primary folder via `_determinePrimaryFolder(request, workspaceFolders)`
3. Get isolation mode from `_sessionIsolation.get(sessionId)`
4. Call `folderRepositoryManager.initializeMultiRootFolderRepositories(sessionId, primaryFolder, otherFolders, { stream, toolInvocationToken, isolation }, token)`
5. Map the result to `{ workspaceInfo: primary, additionalWorkspaces: additional, ... }`

### E3. Update `getOrCreateSession()` (~line 1672)

After session creation, store additional workspaces in metadata:
```typescript
const { workspaceInfo, additionalWorkspaces, cancelled, trusted } = await this.getOrInitializeWorkingDirectory(...);
// ... existing code ...
const session = isNewSession
    ? await this.sessionService.createSession({ model, workspaceInfo, additionalWorkspaces, ... }, token)
    : await this.sessionService.getSession({ sessionId: id, model, workspaceInfo, additionalWorkspaces, ... }, token);

if (isNewSession && additionalWorkspaces.length > 0) {
    void this.chatSessionMetadataStore.setAdditionalWorkspaces(session.object.sessionId, additionalWorkspaces);
}
```

### E4. Update `resolvePrompt` call sites (~lines 1360, 1365, 1833)

Replace hardcoded `[]` with actual additional workspaces:
```typescript
const additionalWorkspaces = session.object.additionalWorkspaces;
const { prompt, attachments } = await this.promptResolver.resolvePrompt(
    request, ..., session.object.workspace, additionalWorkspaces, token
);
```

---

## Phase F: Prompt References Audit *(depends on E4)*

**File: `src/extension/chatSessions/vscode-node/copilotCLIPromptReferences.ts`**

Audit this file for reference conversion logic. When references are converted back into attached context (e.g., for delegation or reopening requests), ensure that:
- File references from any workspace folder (not just primary) are correctly translated
- When worktree isolation is active, file paths from additional workspace folders are translated to their corresponding worktree paths
- The existing `translateWorkspaceUriToWorkingDirectoryUri()` in the prompt resolver handles this, but verify that the references file passes the correct workspace info through

---

## Phase G: Permission & File Edit Handling *(depends on A1, A3)*

**File: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`**

### G1. Refactor `isFileFromSessionWorkspace()` (~line 865)

Use the shared `findOwningWorkspace()` utility:
```typescript
private isFileFromSessionWorkspace(file: Uri): boolean {
    return !!findOwningWorkspace(file, this.workspace, this.additionalWorkspaces);
}
```

### G2. Extend write auto-approval in `requestPermission()` (~line 936)

After the existing single-folder auto-approval block, add:
```typescript
if (!autoApprove && this.additionalWorkspaces.length > 0) {
    autoApprove = await this._isWriteAutoApprovedInAdditionalWorkspaces(editFile, permissionRequest, toolCall);
}
```

New private method:
```typescript
private async _isWriteAutoApprovedInAdditionalWorkspaces(
    editFile: Uri, permissionRequest: PermissionRequest, toolCall?: ToolCall
): Promise<boolean> {
    const owningWs = findOwningWorkspace(editFile, this.workspace, this.additionalWorkspaces);
    if (!owningWs || owningWs === this.workspace) return false; // primary already handled
    const wsDir = getWorkingDirectory(owningWs);
    if (!wsDir) return false;
    if (isIsolationEnabled(owningWs)) return true;
    return !(await requiresFileEditconfirmation(this.instantiationService, permissionRequest, toolCall, wsDir));
}
```

### G3. Use correct working directory for permission helper calls (~line 974)

When calling `requestPermission()` helper, determine the correct `workingDirectory` based on the file being edited across all workspaces:
```typescript
const owningWs = editFile ? findOwningWorkspace(editFile, this.workspace, this.additionalWorkspaces) : undefined;
const effectiveWorkingDir = owningWs ? getWorkingDirectory(owningWs) : getWorkingDirectory(this.workspace);
```

### G4. Permission helpers — multi-folder awareness

**File: `src/extension/chatSessions/copilotcli/node/permissionHelpers.ts`**

The key change is that the **caller** (session's `requestPermission`) now passes the correct `workingDirectory` resolved via `findOwningWorkspace()` (see G3). The helper itself remains generic.

For shell-command confirmation in `getConfirmationToolParams()`: ensure `getCdPresentationOverrides()` receives the matched folder/worktree when a tool operates in an additional workspace, so the confirmation UI reflects the correct working directory context.

---

## Phase H: Fleet API Integration *(depends on A3)*

**File: `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`**

### H1. Add fleet invocation in `sendRequestInternal()` (~line 737)

After `await this._sdkSession.send(sendOptions)` (line 768), add fleet invocation for multi-root:
```typescript
if (!steering && this.additionalWorkspaces.length > 0) {
    await this._startFleetAndWaitForIdle(input);
}
```

New private method:
```typescript
private async _startFleetAndWaitForIdle(input: CopilotCLISessionInput): Promise<void> {
    const prompt = 'prompt' in input ? input.prompt : undefined;
    try {
        const result = await this._sdkSession.fleet.start({ prompt });
        if (!result.started) {
            this.logService.info('[CopilotCLISession] Fleet mode not started');
            return;
        }
        await new Promise<void>((resolve) => {
            const off = this._sdkSession.on('session.idle', () => {
                off();
                resolve();
            });
        });
    } catch (error) {
        this.logService.error(`[CopilotCLISession] Fleet error: ${error}`);
    }
}
```

---

## Phase I: Commit & Checkpoint for All Folders *(depends on A4, A5, A7)*

**File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`**

### I1. Modify `commitWorktreeChangesIfNeeded()` (~line 1492)

After the existing primary workspace commit logic (lines 1507-1521), add additional workspaces handling:
```typescript
if (session.status === vscode.ChatSessionStatus.Completed) {
    // Primary workspace (existing code, extracted to helper)
    await this._commitPrimaryWorkspace(session);

    // Additional workspaces (new)
    if (session.additionalWorkspaces.length > 0) {
        await this._commitAdditionalWorkspaces(session);
    }

    // Primary checkpoint (existing code)
    await this.copilotCLIWorktreeCheckpointService.handleRequestCompleted(session.sessionId, request.id);

    // Additional workspace checkpoints (new)
    if (session.additionalWorkspaces.length > 0) {
        await this.copilotCLIWorktreeCheckpointService.handleAdditionalWorktreesRequestCompleted(session.sessionId, request.id);
    }
}
```

### I2. Baseline checkpoints at request start

In the request handling flow, alongside the existing `copilotCLIWorktreeCheckpointService.handleRequest(sessionId)` call, add:
```typescript
if (session.additionalWorkspaces.length > 0) {
    await this.copilotCLIWorktreeCheckpointService.handleAdditionalWorktreesRequest(session.sessionId);
}
```

This creates baseline checkpoints for additional worktrees at request start, which are required to compute turn-level diffs.

### I3. New private helper: `_commitPrimaryWorkspace()`

Extracted from existing lines 1508-1521 (no logic change, just reorganization).

### I4. New private helper: `_commitAdditionalWorkspaces()`

```typescript
private async _commitAdditionalWorkspaces(session: ICopilotCLISession): Promise<void> {
    const results = await Promise.allSettled(session.additionalWorkspaces.map(async (ws) => {
        const workingDir = getWorkingDirectory(ws);
        if (!workingDir) return;
        if (isIsolationEnabled(ws)) {
            await this.copilotCLIWorktreeManagerService.handleRequestCompletedForWorktree(ws.worktreeProperties!);
        } else {
            await this.workspaceFolderService.handleRequestCompleted(workingDir);
        }
    }));
    // Log per-folder failures without blocking other folders
    for (const result of results) {
        if (result.status === 'rejected') {
            this.logService.error(`[CopilotCLI] Failed to commit additional workspace: ${result.reason}`);
        }
    }
}
```

Uses `Promise.allSettled` so partial failures in one folder don't mask successful commits in others.

### I5. "Has changes" check for multi-root

In the uncommitted changes warning path (e.g., `handleDelegationToCloud()` ~line 1736), extend the check to include additional workspaces:
```typescript
// Check additional workspaces for changes
if (!hasChanges) {
    const additionalWorkspaces = await this.chatSessionMetadataStore.getAdditionalWorkspaces(session.sessionId);
    for (const ws of additionalWorkspaces) {
        const wsRepo = ws.worktreeProperties
            ? await this.gitService.getRepository(Uri.file(ws.worktreeProperties.repositoryPath))
            : (ws.folder ? await this.gitService.getRepository(ws.folder) : undefined);
        if (wsRepo?.changes?.indexChanges?.length) {
            hasChanges = true;
            break;
        }
    }
}
```

---

## Phase J: Change Tracking for All Folders *(depends on A4)*

There are TWO `toChatSessionItem()` methods in different classes that both need updating:
1. `CopilotCLIChatSessionContentProvider` in `copilotCLIChatSessions.ts` (~line 322)
2. `CopilotCLIChatSessionItemProvider` in `copilotCLIChatSessionsContribution.ts` (~line 238)

Both only collect changes from the primary workspace. Both need to also aggregate changes from additional workspaces.

### J1. Modify `toChatSessionItem()` in `copilotCLIChatSessions.ts` (~line 322)

After existing changes collection (lines 352-369), add additional workspace changes:
```typescript
// Additional workspace changes
const additionalWorkspaces = await this.chatSessionMetadataStore.getAdditionalWorkspaces(session.id);
if (additionalWorkspaces.length > 0) {
    const additionalChanges = await this._getAdditionalWorkspaceChanges(session.id, additionalWorkspaces);
    changes.push(...additionalChanges);
}
```

### J1b. Modify `toChatSessionItem()` in `copilotCLIChatSessionsContribution.ts` (~line 238)

Same pattern — after existing changes collection (lines 268-285), add:
```typescript
// Additional workspace changes
const additionalWorkspaces = await this.chatSessionMetadataStore.getAdditionalWorkspaces(session.id);
if (additionalWorkspaces.length > 0) {
    const additionalChanges = await this._getAdditionalWorkspaceChanges(session.id, additionalWorkspaces);
    changes.push(...additionalChanges);
}
```

### J2. New private helper: `_getAdditionalWorkspaceChanges()` (in both classes)

```typescript
private async _getAdditionalWorkspaceChanges(
    sessionId: string,
    additionalWorkspaces: IWorkspaceInfo[]
): Promise<vscode.ChatSessionChangedFile2[]>
```
Iterates each additional workspace:
- For worktree-isolated: queries worktree service for changes using worktree properties
- For workspace-mode: queries `workspaceFolderService.getWorkspaceChanges()`
- Maps to `ChatSessionChangedFile2` using same pattern as existing code

### J3. Session visibility

Ensure session visibility logic treats a session as relevant if **any** of its tracked workspaces (primary or additional) belong to the current open workspace. A multi-root session should not become invisible if the primary folder is closed but other tracked folders are still open.

---

## Phase K: Resume and Fork Handling *(covered by B1, E1)*

Resume and fork flows must preserve multi-root state.

### K1. Session Resume

When an existing multi-root session is resumed:
- `getSession()` in `copilotcliSessionService.ts` loads `additionalWorkspaces` from metadata store before constructing session options (see B1)
- The contribution layer's `getOrInitializeWorkingDirectory()` loads additional workspaces from metadata for existing sessions (see E1)
- Permission handling, prompt resolution, and completion handling all receive the restored additional workspaces

### K2. Session Fork

In `forkSession()` (~line 706), after `copySessionFilesForForking()` copies session state (see B1):
- Copy additional workspaces metadata to the new session
- If worktree isolation is active, the forked session's additional worktrees may need to be re-created or pointed to new worktree paths (depending on whether fork creates new worktrees)

### K3. Session Deletion

**File: `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts`**

The `github.copilot.cli.sessions.delete` command (~line 1928) currently only cleans up the primary worktree. For multi-root sessions, it must also delete all additional worktrees and clean up additional workspace folder tracking.

After the existing primary worktree deletion (lines 1950-1960), add:
```typescript
// Delete additional worktrees
const additionalWorkspaces = await chatSessionMetadataStore.getAdditionalWorkspaces(sessionId);
await Promise.allSettled(additionalWorkspaces.map(async (ws) => {
    if (ws.worktreeProperties) {
        try {
            const repo = await gitService.getRepository(vscode.Uri.file(ws.worktreeProperties.repositoryPath), true);
            if (repo) {
                await gitService.deleteWorktree(repo.rootUri, ws.worktreeProperties.worktreePath);
            }
        } catch (error) {
            logService.error(`Failed to delete additional worktree: ${error}`);
        }
    }
    // Clean up workspace folder tracking for additional plain folders
    if (ws.folder && !ws.worktreeProperties) {
        await copilotCliWorkspaceSession.deleteTrackedWorkspaceFolder(sessionId);
    }
}));
```

Also clean up `_sessionMultiRoot.delete(sessionId)` if needed.

### K4. Backward compatibility

- Old metadata without `additionalWorkspaces` must load safely — `getAdditionalWorkspaces()` already returns `[]` when the field is absent
- Single-root sessions are unaffected — all new code paths are gated on `additionalWorkspaces.length > 0`

---

## Implementation Order

| Step | Phase | Description | Depends on | Risk |
|------|-------|-------------|------------|------|
| 1 | A1 | Shared `findOwningWorkspace()` utility | — | Low |
| 2 | A2 | Add `additionalWorkspaces` to `CopilotCLISessionOptions` | — | Low |
| 3 | A3 | Expose `additionalWorkspaces` on session interface + class | A2 | Low |
| 4 | A4 | Worktree service new methods | — | Low |
| 5 | A5 | Add `additionalCheckpointRefs` to `RequestDetails` | — | Low |
| 6 | A6 | Multi-root state map in contribution file | — | Low |
| 7 | A7 | Checkpoint service interface extension | — | Low |
| 8 | B1 | Session service plumbing | A2, A3 | Low |
| 9 | C1-C4 | Dropdown UI "Multi-root" item + hide branch dropdown | — | Medium |
| 10 | D1-D2 | Primary folder inference helpers | C1 | Medium |
| 11 | E1-E4 | Multi-root initialization + resolvePrompt wiring | B1, D1 | High |
| 12 | F | Prompt references audit | E4 | Medium |
| 13 | G1-G4 | Permission checks for all workspaces + shell commands | A1, A3 | Medium |
| 14 | I1-I5 | Multi-folder commit, checkpoints, "has changes" check | A4, A5, A7 | High |
| 15 | J1-J3 | Change tracking + session visibility | A4 | Medium |
| 16 | H1 | Fleet API integration | A3 | High |
| 17 | K1-K4 | Resume, fork, and delete handling | B1, E1 | Medium |

---

## Critical Files to Modify

| File | Changes |
|------|---------|
| `src/extension/chatSessions/common/workspaceInfo.ts` | Add shared `findOwningWorkspace()` utility |
| `src/extension/chatSessions/common/folderRepositoryManager.ts` | Add `initializeMultiRootFolderRepositories()` to interface |
| `src/extension/chatSessions/vscode-node/folderRepositoryManagerImpl.ts` | Implement `initializeMultiRootFolderRepositories()` — combined trust, uncommitted changes prompt, worktree creation for all folders |
| `src/extension/chatSessions/copilotcli/node/copilotCli.ts` | Add `additionalWorkspaces` field |
| `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts` | Expose additional workspaces, multi-folder permission checks, fleet API |
| `src/extension/chatSessions/copilotcli/node/copilotcliSessionService.ts` | Pass `additionalWorkspaces` through create/get/fork session, `copySessionFilesForForking` |
| `src/extension/chatSessions/copilotcli/node/permissionHelpers.ts` | Use `findOwningWorkspace()`, `getCdPresentationOverrides()` folder context |
| `src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts` | Dropdown "Multi-root" item, change tracking in `toChatSessionItem`, session visibility |
| `src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts` | Multi-root init, commit all folders, checkpoint all folders, baseline checkpoints, "has changes" check, primary folder inference, hide branch dropdown |
| `src/extension/chatSessions/vscode-node/copilotCLIPromptReferences.ts` | Audit for multi-folder reference translation |
| `src/extension/chatSessions/common/chatSessionMetadataStore.ts` | Add `additionalCheckpointRefs` to `RequestDetails` |
| `src/extension/chatSessions/common/chatSessionWorktreeService.ts` | New interface methods |
| `src/extension/chatSessions/vscode-node/chatSessionWorktreeServiceImpl.ts` | Implement new worktree methods |
| `src/extension/chatSessions/common/chatSessionWorktreeCheckpointService.ts` | New interface methods for additional worktree checkpoints |
| `src/extension/chatSessions/vscode-node/chatSessionWorktreeCheckpointServiceImpl.ts` | Implement additional checkpoint methods |
| `src/extension/chatSessions/common/chatSessionWorkspaceFolderService.ts` | May need extension for per-session multi-folder tracking |
| `src/extension/chatSessions/vscode-node/chatSessionWorkspaceFolderServiceImpl.ts` | May need extension — verify that calling `handleRequestCompleted()` for multiple plain folders per session works correctly with existing tracking |

## Existing Code to Reuse (no modification needed)

| Code | Location |
|------|----------|
| `getAdditionalWorkspaces()` / `setAdditionalWorkspaces()` | `chatSessionMetadataStoreImpl.ts:252-271` |
| `buildFolderToWorktreeMap()` | `copilotcliPromptResolver.ts:58-69` |
| `translateWorkspaceUriToWorkingDirectoryUri()` | `copilotcliPromptResolver.ts:304-320` |
| `findMatchingWorktree()` | `copilotcliPromptResolver.ts:322-336` |
| `IWorkspaceInfo`, `getWorkingDirectory()`, `isIsolationEnabled()`, `emptyWorkspaceInfo()` | `workspaceInfo.ts` |
| `ChatSessionWorktreeProperties` types | `chatSessionWorktreeService.ts:25-50` |
| Additional workspaces metadata tests | `chatSessionMetadataStoreImpl.spec.ts:1448-1619` |
| `claudeChatSessionContentProvider.ts` | Reference architecture for `cwd` + `additionalDirectories` shape (not a dependency, informational only) |

---

## Key Decisions

1. **Scope**: Copilot CLI only — does not change Claude or other agents.
2. **Multi-root selection model**: Tracked via a module-level `Set<string>` (`_sessionMultiRoot`) in the contribution file, alongside existing `_sessionBranch` and `_sessionIsolation` — does not overload `setNewSessionFolder`.
3. **v1 behavior**: Automatically includes all open workspace folders when "Multi-root" is selected — no per-folder opt-in picker.
4. **Branch dropdown**: Hidden when multi-root is selected. Each repo uses its HEAD/default branch. Branch override applies only to primary repo if later added.
5. **SDK constraint**: `SessionOptions.workingDirectory` is singular. Additional folder topology is conveyed by extension state/metadata/prompt attachments, not typed SDK options.
6. **`checkpointRef` backward compat**: Preserved as primary workspace checkpoint alias. `additionalCheckpointRefs` added as a separate field keyed by `fsPath`.
7. **Additive API design**: New methods (`getAdditionalWorktreeProperties`, `handleRequestCompletedForWorktree`, `handleAdditionalWorktreesRequest`) rather than widening existing signatures.
8. **Public method stability**: Existing public methods (`handleRequestCompleted`, `commitWorktreeChangesIfNeeded`) remain as single entry points with internal `if (additionalWorkspaces.length > 0)` branching to private helpers.
9. **Error handling**: `Promise.allSettled` for parallel initialization/commit/checkpoint — partial failures logged but don't block other folders.
10. **`toSessionOptions()` unchanged**: SDK only gets primary `workingDirectory`. Additional folders communicated via Fleet API.

---

## Verification Plan

### Unit Tests
- Test `findOwningWorkspace()` with files in primary, additional, and outside workspaces
- Test `_sessionMultiRoot` state map tracks selection correctly
- Test `_determinePrimaryFolder()` precedence: attachments > prompt refs > active editor > first folder
- Test `isFileFromSessionWorkspace()` with files in primary and additional workspaces
- Test `_isWriteAutoApprovedInAdditionalWorkspaces()` for both isolation and workspace modes
- Test `_commitAdditionalWorkspaces()` commits in parallel, handles partial failures
- Test `_getAdditionalWorkspaceChanges()` aggregates changes from all workspaces
- Test `handleAdditionalWorktreesRequest()` creates baseline checkpoints
- Test `handleAdditionalWorktreesRequestCompleted()` creates post-turn checkpoints and stores refs
- Test fork preserves additional workspaces metadata
- Test resume loads additional workspaces from metadata
- Test no regressions in single-root path (additionalWorkspaces = [])
- Extend existing tests in:
  - `copilotCLIChatSessionParticipant.spec.ts`
  - `folderRepositoryManager.spec.ts`
  - `chatSessionMetadataStoreImpl.spec.ts` (existing additional workspaces tests at lines 1448-1619)
  - `permissionHelpers.spec.ts`
  - `copilotcliSession.spec.ts`
  - `copilotCliSessionService.spec.ts`

### Integration / Manual Tests
1. Open a multi-root workspace with 2+ git repos and at least one plain folder
2. Verify "Multi-root" appears at top of folder dropdown
3. Verify branch dropdown is hidden when "Multi-root" is selected
4. Select "Multi-root" with **worktree** isolation → verify worktrees created for all repos, plain folders left as-is
5. Select "Multi-root" with **workspace** mode → verify no worktrees, all folders tracked
6. Send a request → verify Fleet API is called, session completes
7. Verify file edits in any workspace folder are auto-approved appropriately
8. Verify shell command confirmation shows correct folder context
9. After request completes → verify commits created in all worktrees (or changes staged in all workspace folders)
10. Check session changes panel → verify changes from all folders appear
11. Verify checkpoints created for all folders (both baseline and post-turn)
12. Verify "uncommitted changes" warning considers all workspace folders
13. Resume an existing multi-root session → verify additional workspaces are restored from metadata
14. Fork a multi-root session → verify forked session retains additional workspaces
15. Delete a multi-root session → verify all additional worktrees are cleaned up
16. Verify single-root sessions are completely unaffected

### Build Validation
- Run `start-watch-tasks` during implementation to catch compile errors continuously
- Check output for compilation errors before running tests or considering work complete
