# NES Expected Edit Capture Feature

## Overview

A feature that allows users to record/capture their "expected suggestion" when a Next Edit Suggestion (NES) was rejected or failed to appear. The captured data is saved in `.recording.w.json` format (compatible with stest infrastructure) for analysis and model improvement.

## User Flow

### Trigger Points
1. **Automatic**: User rejects an NES suggestion
2. **Manual**: User invokes via Command Palette (**"Copilot: Record Expected Edit (NES)"**) or keybinding (**Cmd+K Cmd+R** on Mac, **Ctrl+K Ctrl+R** on Windows/Linux) when NES didn't appear but should have

### Capture Session
1. System enters "capture mode" and creates a bookmark in DebugRecorder
2. Status bar shows: "Capture mode: edit code, Enter=save, Esc=cancel"
3. User types their expected suggestion directly in the editor (replaces or inserts code)
4. User presses **Enter** to confirm and save, or **Esc** to cancel

### Keybindings
- **Enter**: Confirm and save capture (only when `copilotNesCaptureMode` context is active)
- **Shift+Enter**: Insert a newline character (since Enter is used to save, use Shift+Enter for multi-line edits)
- **Esc**: Cancel capture session

## Technical Architecture

### Core Components

#### State Management
The capture controller maintains minimal state:
```typescript
{
  active: boolean;
  startBookmark: DebugRecorderBookmark;
  endBookmark?: DebugRecorderBookmark;
  startDocumentId: DocumentId;
  startTime: number;
  trigger: 'rejection' | 'manual';
  originalNesMetadata?: {
    requestUuid: string;
    providerInfo?: string;
    modelName?: string;
    endpointUrl?: string;
    suggestionText?: string;
    // [startLine, startCharacter, endLine, endCharacter]
    suggestionRange?: [number, number, number, number];
  };
}
```

### Implementation Flow

The capture flow leverages **DebugRecorder**, which already tracks all document edits automatically—no custom event listeners or manual diff computation needed.

1. **Start Capture**: Create a bookmark in DebugRecorder, store the current document ID, set context key `copilotNesCaptureMode` to enable keybindings, and show status bar indicator.

2. **User Edits**: User types their expected edit naturally in the editor. DebugRecorder automatically tracks all changes in the background.

3. **Confirm Capture**: Create an end bookmark, extract the log slice between start/end bookmarks, filter for edits on the target document, compose them into a single `nextUserEdit`, and save to disk.

4. **Abort/Cleanup**: Clear state, reset context key, and dispose status bar item.

See `ExpectedEditCaptureController` in `src/extension/inlineEdits/vscode-node/components/expectedEditCaptureController.ts` for the full implementation.

### File Output

#### Location
Recordings are stored in the **first workspace folder** under the `.copilot/nes-feedback/` directory:

- **Full path**: `<workspaceFolder>/.copilot/nes-feedback/capture-<timestamp>.recording.w.json`
- **Timestamp format**: ISO 8601 with colons/periods replaced by hyphens (e.g., `2025-12-04T14-30-45`)
- **Example**: `.copilot/nes-feedback/capture-2025-12-04T14-30-45.recording.w.json`
- The folder is automatically created if it doesn't exist

Each recording generates two files:
1. **Recording file**: `capture-<timestamp>.recording.w.json` - Contains the log and edit data
2. **Metadata file**: `capture-<timestamp>.metadata.json` - Contains capture context and timing

#### Format
Matches existing `.recording.w.json` structure used by stest infrastructure:

```json
{
  "log": [
    {
      "kind": "header",
      "repoRootUri": "file:///workspace",
      "time": 1234567890,
      "uuid": "..."
    },
    {
      "kind": "documentEncountered",
      "id": 0,
      "relativePath": "src/foo.ts",
      "time": 1234567890
    },
    {
      "kind": "setContent",
      "id": 0,
      "v": 1,
      "content": "...",
      "time": 1234567890
    },
    ...
  ],
  "nextUserEdit": {
    "relativePath": "src/foo.ts",
    "edit": [
      [876, 996, "replaced text"],
      [1522, 1530, "more text"]
    ]
  }
}
```

#### Metadata File
A metadata file is saved alongside each recording with capture context:
```jsonc
{
  "captureTimestamp": "2025-11-19T...",    // ISO timestamp when capture started
  "trigger": "rejection",                   // How capture was initiated: 'rejection' or 'manual'
  "durationMs": 5432,                       // Time between start and confirm in milliseconds
  "noEditExpected": false,                  // True if user confirmed without making edits
  "originalNesContext": {                   // Metadata from the rejected NES suggestion (if any)
    "requestUuid": "...",                   // Unique ID of the NES request
    "providerInfo": "...",                  // Source of the suggestion (e.g., 'provider', 'diagnostics')
    "modelName": "...",                     // AI model that generated the suggestion
    "endpointUrl": "...",                   // API endpoint used for the request
    "suggestionText": "...",                // The actual suggested text that was rejected
    "suggestionRange": [10, 0, 15, 20]      // [startLine, startChar, endLine, endChar] of suggestion
  }
}
```

## Commands

### Internal Commands
- `github.copilot.nes.captureExpected.start` - Start capture (manual trigger)
- `github.copilot.nes.captureExpected.confirm` - Confirm and save
- `github.copilot.nes.captureExpected.abort` - Cancel capture

### User-Facing Keybindings
The following keybindings are registered in `package.json`. The Enter and Escape bindings are scoped to the `copilotNesCaptureMode` context key, which is set to `true` during an active capture session.

- **Cmd+K Cmd+R** (Mac) / **Ctrl+K Ctrl+R** (Windows/Linux): Start capture manually
- **Enter**: Confirm and save capture
- **Escape**: Abort capture

### Command Palette
The start command is available in the Command Palette:
- **"Copilot: Record Expected Edit (NES)"** — Manually start a capture session

## Benefits

### For Users
- Zero-friction workflow (type naturally, press Enter)
- No forms or dialogs to fill
- Works for both rejected suggestions and missed opportunities

### For Engineering
- Minimal code complexity (leverage DebugRecorder)
- Output directly compatible with existing stest infrastructure
- No custom diff algorithms needed

### For Model Improvement
- Rich context: full edit history leading to expectation
- Structured format for batch analysis
- Reproducible via stest framework
- Can compare expected vs actual NES suggestions

## Edge Cases

### Multiple Rapid Rejections
- Only one capture session active at a time
- Subsequent rejections during capture are ignored
- Status bar shows active capture state

### Document Closed Before Confirm
- Capture automatically aborted
- No persistence occurs

### No Edits Made
- If user confirms without editing, the recording is saved with `nextUserEdit.edit` set to `{ "__marker__": "NO_EDIT_EXPECTED" }`
- Metadata includes `noEditExpected: true`
- This is valid feedback indicating the NES suggestion was correctly rejected (no edit was actually needed)

### Large Edits
- DebugRecorder handles size limits automatically
- If edit exceeds thresholds, it's collapsed into base state
- Capture still succeeds with whatever was retained

## Future Enhancements

### Optional Features
- **Diff Preview**: Show visual comparison before saving
- **Category Tagging**: Quick-pick to categorize expectation type (import, refactor, etc.)
- **Auto-Generate stest**: Create `.stest.ts` wrapper file automatically
- **Batch Export**: Command to zip all captures for sharing

## Settings

```typescript
// Enable/disable the feature
"github.copilot.chat.advanced.inlineEdits.recordExpectedEdit.enabled": true

// Auto-start on rejection
"github.copilot.chat.advanced.inlineEdits.recordExpectedEdit.onReject": true
```

## Related Files

- `src/extension/inlineEdits/node/debugRecorder.ts` - Core recording infrastructure
- `src/extension/inlineEdits/vscode-node/components/inlineEditDebugComponent.ts` - Existing feedback/debug tooling
- `src/extension/inlineEdits/common/observableWorkspaceRecordingReplayer.ts` - Recording replay logic
- `test/simulation/inlineEdit/inlineEditTester.ts` - stest infrastructure
