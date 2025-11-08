# Run Agent Script Tool

## Overview

The `run_agent_script` tool allows the AI agent to write and execute Python scripts for complex data processing, filtering, and transformation tasks. This provides a powerful way to combine multiple tool calls with custom logic.

## Architecture

### Components

1. **RunAgentScriptTool** (`src/extension/tools/node/runAgentScriptTool.ts`)
   - The main tool that handles script execution requests
   - Manages communication with the MicroPython runner process
   - Handles tool calls from within the Python script

2. **MicroPython Runner** (`src/extension/tools/node/scriptRunner/micropythonRunner.ts`)
   - A separate Node.js child process that runs with restricted permissions
   - Uses `@vscode/micropython-wasm` to execute Python code
   - Communicates with the parent process via stdio using JSON messages

3. **Structured Output Support**
   - Tools can optionally declare a `structuredOutput` schema (ObjectJsonSchema)
   - When tools return structured data, they should include a `LanguageModelDataPart` with type `application/vnd.code.tool.output`
   - The RunAgentScriptTool makes these structured outputs available to Python scripts

## Configuration

Enable the tool by setting:
```json
{
  "github.copilot.chat.runAgentScript.enabled": true
}
```

## How It Works

### 1. Script Execution Flow

```
Agent → RunAgentScriptTool → MicroPython Runner (child process)
                                   ↓
                            Execute Python script
                                   ↓
                            Call other tools (if needed)
                                   ↓
                            Return result
```

### 2. Security

The MicroPython runner is launched with Node.js experimental permissions:
- `--experimental-permission`: Enables permission model
- `--allow-fs-read=<extension-path>`: Only allows reading files from the extension directory

This prevents the script from:
- Writing files
- Making network requests (beyond calling other tools via the parent process)
- Accessing system resources outside the extension

### 3. Tool Integration

Tools with `structuredOutput` are automatically made available as Python functions:

```python
# Example: Find and filter TypeScript files
files = await find_files(query="**/*.ts")
# files is now a Python dict with the structured output

# Filter and process
test_files = [f for f in files['files'] if 'test' in f]
return test_files
```

## Adding Structured Output to Tools

To make a tool available to Python scripts:

1. Define the `structuredOutput` property:

```typescript
export class MyTool implements ICopilotTool<IMyToolParams> {
  public readonly structuredOutput: ObjectJsonSchema = {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['results']
  };

  // ... rest of tool implementation
}
```

2. Return structured data in the `invoke` method:

```typescript
async invoke(options, token) {
  // ... do work

  const result = {
    results: ['item1', 'item2']
  };

  return new LanguageModelToolResult([
    new LanguageModelTextPart('Human-readable result'),
    LanguageModelDataPart.json(result, 'application/vnd.code.tool.output')
  ]);
}
```

## Example Use Cases

### Filtering Files
```python
# Find all TypeScript files and filter to test files
all_files = await find_files(query="**/*.ts")
test_files = [f for f in all_files['files'] if '/test/' in f or '.test.' in f]
return {"test_files": test_files, "count": len(test_files)}
```

### Data Transformation
```python
# Read multiple files and combine their content
file1 = await read_file(path="src/config.ts")
file2 = await read_file(path="src/constants.ts")

# Process and combine
combined = {
  "config": file1,
  "constants": file2,
  "summary": f"Read {len(file1) + len(file2)} characters"
}
return combined
```

### Complex Logic
```python
# Multi-step processing with conditionals
errors = await get_errors()

if errors['count'] > 0:
    # Analyze error patterns
    error_types = {}
    for error in errors['diagnostics']:
        error_type = error['severity']
        error_types[error_type] = error_types.get(error_type, 0) + 1
    return error_types
else:
    return {"status": "no errors"}
```

## Implementation Details

### IPC Protocol

Communication between parent and child process uses line-delimited JSON:

**Execute Request:**
```json
{
  "type": "execute",
  "script": "return await find_files(query='**/*.ts')",
  "tools": {
    "find_files": {
      "schema": { /* ObjectJsonSchema */ },
      "isAsync": true
    }
  }
}
```

**Tool Call Request (from child):**
```json
{
  "type": "tool_call",
  "toolName": "find_files",
  "input": { "query": "**/*.ts" },
  "callbackId": "abc123"
}
```

**Tool Call Response (from parent):**
```json
{
  "type": "tool_call_response",
  "callbackId": "abc123",
  "result": { /* structured output */ }
}
```

**Execute Response:**
```json
{
  "type": "result",
  "result": { /* final script result */ }
}
```

## Limitations

- MicroPython has a limited standard library compared to CPython
- No network access or file system write access
- The Python environment is recreated for each script execution (by default)
- Tool calls add latency, so use judiciously

## Future Enhancements

Potential improvements:
- Cache the MicroPython runtime between executions
- Add more tools with structured output
- Provide a standard library of helper functions in Python
- Better error messages and debugging support
- TypeScript type generation from Python schema definitions
