# VS Code Copilot Chat Tools - Development Guide

This guide provides comprehensive information about developing tools for the VS Code Copilot Chat extension.

## Overview

Tools are reusable components that allow language models to perform specific actions within VS Code. They follow the standard VS Code [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/tools) with additional Copilot-specific functionality.

## Architecture

### Tool Interface
All tools implement the `ICopilotTool<T>` interface:

```typescript
interface ICopilotTool<T> extends vscode.LanguageModelTool<T> {
    toolName: string;
    invoke(options: vscode.LanguageModelToolInvocationOptions<T>): Promise<vscode.LanguageModelToolResult>;
}
```

### Key Components
- **Tool Registry**: Central registration system for all tools
- **Tool Names**: Consistent naming convention (see `toolNames.ts`)
- **Schema Definition**: Input validation and documentation
- **Result Formatting**: Structured responses for language models

## Existing Tools

### File System Tools
- **`readFileTool`**: Read file contents with syntax highlighting
- **`createFileTool`**: Create new files with content
- **`editFileTool`**: Edit existing files with various strategies
- **`listDirTool`**: List directory contents
- **`findFilesTool`**: Search for files by pattern

### Code Intelligence Tools
- **`getErrorsTool`**: Retrieve diagnostic errors for files
- **`usagesTool`**: Find symbol references and definitions
- **`searchWorkspaceSymbolsTool`**: Search for symbols across workspace

### Execution Tools
- **`runInTerminalTool`**: Execute shell commands
- **`runTaskTool`**: Run VS Code tasks
- **`runTestsTool`**: Execute tests
- **`runNotebookCellTool`**: Execute notebook cells

### Git Tools
- **`applyPatchTool`**: Apply git patches
- **`scmChangesTool`**: Get source control changes

### AI Assistant Tools
- **`thinkTool`**: Internal reasoning and planning
- **`docTool`**: Generate documentation
- **`codebaseTool`**: Analyze codebase structure

## Creating a New Tool

### 1. Tool Implementation

Create your tool in `src/extension/tools/node/`:

```typescript
// myNewTool.tsx
import type * as vscode from 'vscode';
import { ToolName } from '../common/toolNames';
import { ICopilotTool } from '../common/toolsRegistry';

export interface MyToolOptions {
    parameter1: string;
    parameter2?: number;
}

export const myToolDescription: vscode.LanguageModelToolInformation = {
    name: ToolName.MyTool,
    description: 'Description of what this tool does',
    inputSchema: {
        type: 'object',
        properties: {
            parameter1: {
                type: 'string',
                description: 'Description of parameter1'
            },
            parameter2: {
                type: 'number',
                description: 'Optional parameter',
                default: 0
            }
        },
        required: ['parameter1']
    }
};

export class MyNewTool implements ICopilotTool<MyToolOptions> {
    readonly toolName = ToolName.MyTool;

    async invoke(options: vscode.LanguageModelToolInvocationOptions<MyToolOptions>): Promise<vscode.LanguageModelToolResult> {
        const { parameter1, parameter2 = 0 } = options.parameters;

        try {
            // Tool implementation here
            const result = await this.doWork(parameter1, parameter2);

            return {
                content: [
                    new vscode.MarkdownString(`Operation completed: ${result}`)
                ]
            };
        } catch (error) {
            return {
                content: [
                    new vscode.MarkdownString(`Error: ${error.message}`)
                ]
            };
        }
    }

    private async doWork(param1: string, param2: number): Promise<string> {
        // Implementation details
        return `Processed ${param1} with ${param2}`;
    }
}
```

### 2. Tool Registration

Add your tool to the registry in `allTools.ts`:

```typescript
// Import your tool
import { MyNewTool, myToolDescription } from './myNewTool';

// Add to tool constructors array
export const allToolCtors: readonly ICopilotToolCtor[] = [
    // ... existing tools
    {
        ctor: MyNewTool,
        when: undefined, // or condition when tool should be available
        toolInformation: myToolDescription
    }
];
```

### 3. Add Tool Name

Define the tool name in `toolNames.ts`:

```typescript
export const enum ToolName {
    // ... existing names
    MyTool = 'myTool'
}
```

### 4. Package.json Configuration

Add tool definition to `package.json`:

```json
{
    "name": "myTool",
    "description": "Description of what this tool does",
    "inputSchema": {
        "type": "object",
        "properties": {
            "parameter1": {
                "type": "string",
                "description": "Description of parameter1"
            }
        },
        "required": ["parameter1"]
    }
}
```

## Best Practices

### Error Handling
- Always wrap tool logic in try-catch blocks
- Provide meaningful error messages to users
- Log errors appropriately for debugging

### Performance
- Use cancellation tokens for long-running operations
- Implement proper resource cleanup
- Consider memory usage for large operations

### Security
- Validate all inputs thoroughly
- Be cautious with file system operations
- Sanitize user-provided paths and commands

### Testing
- Write unit tests for tool logic
- Test error scenarios
- Verify tool registration and discovery

## Tool Categories

### Lightweight Tools
Best for quick operations (< 1 second):
- File reading
- Simple calculations
- Status checks

### Medium Complexity Tools
For operations taking 1-10 seconds:
- File searches
- Code analysis
- Small compilations

### Heavy Tools
For long-running operations (> 10 seconds):
- Large builds
- Comprehensive analysis
- Network operations

## Debugging Tools

### Development Commands
```bash
# Type check your tool
npm run typecheck

# Run unit tests
npm run test:unit

# Test tool in extension
npm run test:extension
```

### Common Issues
1. **Tool not appearing**: Check registration in `allTools.ts`
2. **Schema validation errors**: Verify `inputSchema` matches interface
3. **Permission errors**: Ensure proper VS Code API usage

## Examples

See existing tools for patterns:
- **Simple tool**: `readFileTool.tsx`
- **Complex tool**: `editFileTool.tsx`
- **Terminal tool**: `runInTerminalTool.tsx`
- **AI integration**: `thinkTool.tsx`

## Contributing

When contributing a new tool:
1. Follow the existing patterns and conventions
2. Add comprehensive tests
3. Update this documentation
4. Ensure tool works in both desktop and web versions
5. Consider accessibility and internationalization

## Tool Lifecycle

1. **Registration**: Tool is registered with VS Code
2. **Discovery**: Language model discovers available tools
3. **Invocation**: Model requests tool execution
4. **Execution**: Tool performs its operation
5. **Response**: Results are returned to the model

For more details, see the [VS Code Tool API documentation](https://code.visualstudio.com/api/extension-guides/tools).
