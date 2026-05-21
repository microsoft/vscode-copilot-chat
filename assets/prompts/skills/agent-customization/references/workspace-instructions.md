# [Workspace Instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)

Guidelines that automatically apply to all chat requests across your entire workspace.

## File Types (Choose One)

| File | Location | Purpose |
|------|----------|---------|
| `copilot-instructions.md` | `.github/` | Project-wide standards (recommended, cross-editor) |
| `AGENTS.md` | Root or subfolders | Open standard, monorepo hierarchy support |

Use **only one**, not both.

## AGENTS.md Hierarchy

For monorepos, the closest file in the directory tree takes precedence:

```
/AGENTS.md              # Root defaults
/frontend/AGENTS.md     # Frontend-specific (overrides root)
/backend/AGENTS.md      # Backend-specific (overrides root)
```

Use nested `AGENTS.md` files for monorepos when different areas need different defaults.

## Inclusion Test

Every line must pass **all three** tests before going in. Content that fails any test should be omitted or redirected (see below).

| Test | Question | If it fails |
|------|----------|---------------|
| **Undiscoverable** | Can the agent figure this out from config files, imports, or code? | Don't document; trust the explore step |
| **Stable** | Will this go stale when files are renamed or code changes? | Link to the source of truth instead of copying |
| **Global** | Does this apply to literally every task type in this repo? | Move to a file instruction (`applyTo`) or skill |

Shorter files outperform longer ones. An almost-empty file, or no file, is a valid outcome.

## Template

Only include sections the workspace benefits from. Most projects need only one or two.

```markdown
# {Project Name} Instructions

## Code Style
{ONLY conventions not enforced by linters or visible in existing code}

## Architecture
{Decisions that contradict what agents would assume from reading the code}

## Environment
{ONLY non-standard setup that agents would get wrong. Skip anything discoverable from package.json or config files}

## Conventions
{Patterns that differ from common practices. Include specific examples}
```

For large repos, link to detailed docs instead of embedding: `See docs/TESTING.md for test conventions.`

## When to Use

- General coding standards that apply everywhere
- Team preferences shared through version control
- Project-wide requirements (testing, documentation)

## Core Principles

1. **Minimal by default**: Only what passes the inclusion test. Every line costs instruction budget across all sessions
2. **Concise and actionable**: Every line should guide behavior
3. **Link, don't embed**: Reference docs instead of copying content. Search for existing docs (`docs/**/*.md`, `CONTRIBUTING.md`, etc.) and catalog what they cover. Only inline agent-critical gotchas not documented elsewhere
4. **Keep current**: Update when practices change
5. **Redirect, don't include**: Content that's valuable but not global belongs in [file instructions](./instructions.md) (`applyTo`) or [skills](./skills.md), not here

## Anti-patterns

- **Using both file types**: Having both `copilot-instructions.md` and `AGENTS.md`
- **Kitchen sink**: Everything instead of what matters most
- **Duplicating docs**: Copying README instead of linking
- **Obvious instructions**: Conventions already enforced by linters
- **Listing scripts**: Copying `package.json` scripts; agents read `package.json` directly
- **Routine structure descriptions**: Directory trees or codebase overviews that restate what agents discover by exploring. Only document structure when genuinely unconventional or ambiguous
- **Naming discoverable tools**: "We use React Router" when it's in dependencies. Only clarify when alternatives overlap
- **Fragile file paths**: Referencing specific files/services that will move or be renamed
- **Task-specific patterns**: Implementation patterns that only apply to certain work (use skills instead)
