# [Workspace Instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)

Guidelines that automatically apply to all chat requests across your entire workspace.

## File Types (Choose One)

Workspaces should have **only one** of these files—not both:

| File | Purpose |
|------|---------|
| `.github/copilot-instructions.md` | Project-wide coding standards and preferences (Recommended) |
| `AGENTS.md` | Same, but using an open standard |

## copilot-instructions.md

Single file at workspace root that applies to every chat request automatically.

**Location**: `.github/copilot-instructions.md`

### Cross-Editor Support

This file is also detected by GitHub Copilot in Visual Studio and GitHub.com, enabling shared instructions across editors.

## AGENTS.md

Open standard for guiding AI coding agents ([agents.md](https://agents.md/)). Standard markdown—no required fields.

**Location**: Workspace root, or subfolders for monorepos. Agents automatically read the nearest file in the directory tree, so the closest one takes precedence:

```
/AGENTS.md              # Root-level defaults
/frontend/AGENTS.md     # Frontend-specific (overrides root)
/backend/AGENTS.md      # Backend-specific (overrides root)
```

## Template

Both file types use the same markdown format. Only include sections the workspace benefits from—skip any that don't apply:

```markdown
# Project Guidelines

## Code Style
{Language and formatting preferences - reference key files that exemplify patterns}

## Architecture
{Major components, service boundaries, data flows, the "why" behind structural decisions}

## Build and Test
{Commands to install, build, test - agents will attempt to run these automatically}

## Project Conventions
{Patterns that differ from common practices - include specific examples from the codebase}

## Integration Points
{External dependencies and cross-component communication}

## Security
{Sensitive areas and auth patterns}
```

## When to Use

- **General coding standards** that apply everywhere
- **Team preferences** shared through version control
- **Project-wide requirements** like testing standards or documentation rules

**Key Signal**: Context that's always available. Standards, guidelines, and expectations that apply broadly across work.

## Domain Examples

| Domain | Examples |
|--------|----------|
| Engineering | TypeScript strict mode, test coverage, accessibility (WCAG 2.1 AA) |
| Product | User stories in briefs, accessibility/i18n in specs |
| Data | SQL query comments, metric definitions linked |
| Support | Empathetic tone, escalation includes impact/context |
| Design | Use shared component library, include error states |

## Creation Process

### 1. Assess Existing Instructions

Check if a workspace instructions file already exists:
- `.github/copilot-instructions.md`
- `AGENTS.md` at workspace root

If one exists, update it rather than creating a second file. Workspaces should only have one.

### 2. Choose File Type (If None Exists)

| File | Best For |
|------|----------|
| `copilot-instructions.md` (Recommended) | VS Code/GitHub Copilot-specific, cross-editor support |
| `AGENTS.md` | Open standard, supports subfolder organization |

### 3. Create or Update

**For copilot-instructions.md**:
```
.github/copilot-instructions.md
```

**For AGENTS.md** (supports hierarchy):
```
/AGENTS.md              # Root-level defaults
/frontend/AGENTS.md     # Frontend-specific
/backend/AGENTS.md      # Backend-specific
```

### 4. Structure Content

Research existing guidelines and conventions in the workspace using a subagent as needed. Focus on essential knowledge that helps an AI agent be immediately productive:

- **Architecture**: Major components, service boundaries, data flows, the "why" behind structural decisions
- **Developer workflows**: Build, test, debug commands not obvious from file inspection
- **Project conventions**: Patterns that differ from common practices
- **Integration points**: External dependencies and cross-component communication

Use the Template above.

## Core Principles

1. **Minimal by default**: Include only what's relevant to *every* task. Every extra line dilutes focus.
2. **Concise and actionable**: Every line should guide behavior—remove filler prose
3. **Project-specific focus**: Include conventions not obvious from reading the code or enforced by linters
4. **Link, don't embed**: Reference docs instead of copying content. Use `See docs/TYPESCRIPT.md for conventions`
5. **Capabilities over paths**: Describe what systems do, not where files live. File paths go stale; domain concepts stay stable
6. **Keep current**: Update when practices change—stale instructions actively poison agent context

## Progressive Disclosure

For large repos, reference separate docs instead of embedding everything. Agents navigate doc hierarchies efficiently—language-specific rules load only when relevant.

```markdown
## Conventions
For TypeScript patterns, see docs/TYPESCRIPT.md
For testing guidelines, see docs/TESTING.md
```

## Anti-patterns

- **Using both file types**: Having both `copilot-instructions.md` and `AGENTS.md` in the same workspace
- **Kitchen sink**: Trying to include every possible guideline instead of focusing on what matters most
- **Duplicating project docs**: Copying README or CONTRIBUTING content instead of linking to them
- **Obvious instructions**: Stating conventions already enforced by linters or obvious from code
- **Verbose prose**: Long explanations instead of clear, scannable guidelines
- **Contradictory rules**: Different developers adding conflicting opinions without reconciliation