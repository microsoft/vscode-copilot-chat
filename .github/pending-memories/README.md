# Pending Memories

This directory contains discovered memories and facts about the codebase that have been identified by Copilot agents but not yet integrated into formal documentation.

## Purpose

The `vscode_commit_memory` tool writes memory entries here as JSON files. These memories can be:
- Reviewed by developers
- Integrated into instruction files (`.github/instructions/*.instructions.md`)
- Added to agent configurations (`.github/agents/*.agent.md`)
- Incorporated into skills (`.github/skills/*/SKILL.md`)
- Converted to hooks (`.claude/hooks/*.yaml`)

## File Format

Each memory file is a JSON object with the following structure:

```json
{
  "subject": "Short topic (1-2 words)",
  "fact": "Clear, concise statement about the codebase",
  "citations": "Source location (e.g., path/file.ts:123)",
  "reason": "Detailed explanation of why this is important",
  "category": "bootstrap_and_build | user_preferences | general | file_specific",
  "suggestedContext": "Optional: suggested file for integration",
  "timestamp": "ISO 8601 timestamp",
  "id": "Unique identifier"
}
```

## Categories

- **bootstrap_and_build**: Information about building, testing, or bootstrapping the project
- **user_preferences**: Coding style preferences, library choices, conventions
- **general**: File-independent facts about the codebase
- **file_specific**: Information about specific files

## Workflow

1. **Discovery**: Copilot agents call `vscode_commit_memory` when they discover important facts
2. **Review**: Developers review the pending memories periodically
3. **Integration**: Use LLM assistance to integrate memories into appropriate documentation
4. **Cleanup**: Remove memory files after integration

## Integration Tips

Use Copilot to help integrate memories:

```
@workspace Review the pending memories in .github/pending-memories/ and integrate them 
into the appropriate instruction files, skills, or hooks.
```

## Example

A memory about build commands might be integrated into:
- `.github/instructions/build.instructions.md` (new or existing instruction file)
- `.github/copilot-instructions.md` (main instructions file)
- `.github/skills/build-and-test/SKILL.md` (if using skills)
