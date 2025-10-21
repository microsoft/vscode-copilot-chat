Let me find and show you the `run_vscode_command` tool's implementation and signature:

Read [](file:///home/baiy/workspace/vscode-copilot-chat/src/extension/tools/node/vscodeCmdTool.tsx)

Searched text for `copilot_runVscodeCommand` (`**/package.json`), 1 result

Read [](file:///home/baiy/workspace/vscode-copilot-chat/package.json#1068-1068), lines 1068 to 1118

Read [](file:///home/baiy/workspace/vscode-copilot-chat/package.json#598-598), lines 598 to 638

Searched text for `getAllCommands|IWorkbenchService` (`**/src/extension/**/*.ts*`), 17 results

Read [](file:///home/baiy/workspace/vscode-copilot-chat/src/platform/workbench/common/workbenchService.ts)

Now let me check what commands are actually available and if there are restrictions:

Analyzed usages of `VSCodeCmdTool`, 2 results

Searched for files matching `**/workbenchServiceImpl.ts`, no matches

Read [](file:///home/baiy/workspace/vscode-copilot-chat/src/platform/workbench)

Searched text for `class.*WorkbenchService.*implements` (`**/src/platform/workbench/**/*.ts`), 1 result

Ran terminal command: cat /home/baiy/workspace/vscode-copilot-chat/src/platform/workbench/vscode/workbenchServiceImpt.ts

Perfect! Now I have all the information. Let me create a comprehensive answer:

## `run_vscode_command` Tool - Complete Documentation

### Tool Signature

```json
{
  "name": "copilot_runVscodeCommand",
  "displayName": "Run VS Code Command",
  "toolReferenceName": "runVscodeCommand",
  "modelDescription": "Run a command in VS Code. Use this tool to run a command in Visual Studio Code as part of a new workspace creation process only.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "commandId": {
        "type": "string",
        "description": "The ID of the command to execute. This should be in the format <command>."
      },
      "name": {
        "type": "string",
        "description": "The name of the command to execute. This should be a clear and concise description of the command."
      },
      "args": {
        "type": "array",
        "description": "The arguments to pass to the command. This should be an array of strings.",
        "items": {
          "type": "string"
        }
      }
    },
    "required": ["commandId", "name"]
  }
}
```

### Implementation Details

**Source**: vscodeCmdTool.tsx

```typescript
interface IVSCodeCmdToolToolInput {
	commandId: string;  // Required: VS Code command ID (e.g., "workbench.action.files.save")
	name: string;       // Required: Human-readable name for display
	args: any[];        // Optional: Arguments to pass to the command
}
```

### How It Works

1. **Command Validation**:
   - Fetches all available VS Code commands using `IWorkbenchService.getAllCommands(filterByPreCondition: true)`
   - This filters commands by their **when clause** preconditions (context-dependent availability)
   - Validates that the requested `commandId` exists in the available commands list

2. **Execution**:
   - Runs the command via `IRunCommandExecutionService.executeCommand(commandId, ...args)`
   - Returns success/failure message

3. **User Confirmation**:
   - Shows a confirmation prompt before execution with:
     - Command name
     - Clickable link to view command details
     - Trust marking for command execution

### Limitations and Restrictions

#### ⚠️ Major Limitations:

1. **When Clause Only** (`when` in package.json):
   ```
   "when": "config.github.copilot.chat.newWorkspaceCreation.enabled"
   ```
   - Tool is **ONLY available when workspace creation is enabled**
   - Not available in general chat sessions
   - Intended specifically for new workspace setup flows

2. **Precondition Filtering**:
   ```typescript
   getAllCommands(filterByPreCondition: true)
   ```
   - Only commands with satisfied preconditions are available
   - If a command's `when` clause evaluates to false, it won't be found
   - Context-dependent: availability changes based on:
     - Active editor
     - Workspace state
     - Extension activations
     - VS Code state

3. **No Type Safety for Arguments**:
   - `args` is typed as `any[]`
   - No validation of argument count or types
   - Wrong arguments will cause runtime errors

4. **Limited Error Information**:
   - Generic success/failure messages
   - Doesn't return command output
   - Errors are logged but not detailed to user

5. **No Return Value**:
   - Commands that return values don't pass results back
   - Only gets success/failure status
   - Can't retrieve command outputs

6. **Restricted Scope**:
   - Model description says: "as part of a new workspace creation process **only**"
   - Intentionally limited to prevent general command execution

### Available Commands

The tool can access **all VS Code commands** including:

#### Built-in Commands:
- `workbench.action.files.save`
- `workbench.action.quickOpen`
- `editor.action.formatDocument`
- `workbench.action.terminal.new`
- `git.commit`
- etc. (1000+ commands)

#### Extension Commands:
- Any command registered by installed extensions
- Language-specific commands
- Custom extension commands

#### Internal Commands:
- `_getAllCommands` - Used internally by the tool
- `_getAllSettings`
- Other underscore-prefixed internal commands

### Usage Example

```typescript
// What the AI would call:
{
  "commandId": "workbench.action.terminal.new",
  "name": "Open New Terminal",
  "args": []
}

// Or with arguments:
{
  "commandId": "workbench.action.quickOpen",
  "name": "Quick Open",
  "args": ["@workspace"]
}
```

### Comparison with LSP Commands

**Can you use this for LSP hierarchy commands?**

**Technically YES, but with caveats:**

```typescript
// This SHOULD work:
{
  "commandId": "vscode.prepareCallHierarchy",
  "name": "Prepare Call Hierarchy",
  "args": [uri, position]
}
```

**BUT:**

1. ⚠️ **Tool is disabled** in normal chat (only in workspace creation)
2. ⚠️ **No return value** - you won't get the hierarchy items back
3. ⚠️ **No result formatting** - it just runs and says "success"
4. ⚠️ **Type-unsafe args** - easy to pass wrong arguments

**Better approach**: Extend `ILanguageFeaturesService` as shown in LSP-TOOLS-GAP-ANALYSIS.md

### Why This Design?

The tool is intentionally restricted because:

1. **Security**: Running arbitrary commands could be dangerous
2. **Scope**: Designed for specific workflow (workspace creation)
3. **User Control**: Requires confirmation before execution
4. **Limited Utility**: Without return values, most commands aren't useful

### Alternative for LSP Features

Instead of using `run_vscode_command` for LSP features, create dedicated tools:

**Current approach** (limited):
```typescript
// Can run command but get no results
run_vscode_command('vscode.prepareCallHierarchy', uri, position)
// → Returns "success" but no hierarchy data
```

**Better approach** (recommended):
```typescript
// Create dedicated service method
interface ILanguageFeaturesService {
  prepareCallHierarchy(uri, position): Promise<CallHierarchyItem[]>
  // → Returns actual hierarchy data
}

// Create dedicated tool
class GetCallHierarchyTool {
  // → Formats and returns results properly
}
```

### Summary

| Feature | Status | Notes |
|---------|--------|-------|
| **Available** | ⚠️ Conditional | Only in workspace creation mode |
| **Command Discovery** | ✅ Yes | Gets filtered list of available commands |
| **Validation** | ✅ Yes | Checks command exists before running |
| **Arguments** | ⚠️ Limited | No type checking, any[] |
| **Return Values** | ❌ No | Only success/failure message |
| **Error Details** | ❌ No | Generic error messages |
| **User Confirmation** | ✅ Yes | Shows confirmation dialog |
| **LSP Usage** | ⚠️ Possible | But not practical (no return values) |

**Recommendation**: For LSP features like call/type hierarchies, **create dedicated tools** following the pattern in `LSP-TOOLS-GAP-ANALYSIS.md` rather than trying to use this generic command runner.
