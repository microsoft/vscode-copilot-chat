# [Agent Skills (SKILL.md)](https://code.visualstudio.com/docs/copilot/customization/agent-skills)

Folders of instructions, scripts, and resources that agents loads when relevant for specialized tasks.

## Structure

```
.github/skills/<skill-name>/
├── SKILL.md           # Required
├── test-template.js   # Scripts
├── examples/          # Example scenarios
└── docs/              # Additional docs
```

## Locations

| Path | Scope |
|------|-------|
| `.github/skills/<name>/` | Project (recommended) |
| `.claude/skills/<name>/` | Project (legacy) |
| `~/.copilot/skills/<name>/` | Personal (recommended) |
| `~/.claude/skills/<name>/` | Personal (legacy) |

## SKILL.md Format

### Frontmatter (required)

```yaml
---
name: skill-name      # Must match parent folder name
description: 'What the skill does and when to use it. For on-demand discovery. Max 1024 chars.'
---
```

#### `name` field rules

- **Must match the parent directory name** (e.g., `pdf-processing/SKILL.md` requires `name: pdf-processing`)
- 1-64 characters
- Lowercase alphanumeric and hyphens only (`a-z`, `0-9`, `-`)
- Must not start or end with `-`
- Must not contain consecutive hyphens (`--`)

#### Optional frontmatter fields

```yaml
license: Apache-2.0                           # License name or bundled file reference
compatibility: Requires git, docker, jq       # Environment requirements (max 500 chars)
```

### Body

- What the skill accomplishes
- When to use the skill
- Step-by-step procedures
- Examples of input/output
- References to scripts/resources via relative paths: `[test script](./test-template.js)`

## Template

```markdown
---
name: webapp-testing
description: 'Test web applications using Playwright. Use when verifying frontend functionality, debugging UI, capturing screenshots.'
---

# Web Application Testing

## When to Use

- Verify frontend functionality
- Debug UI behavior
- Capture browser screenshots

## Procedure

1. Start the web server
2. Run tests with `[test script](./test-template.js)`
3. Review screenshots in `./screenshots/`

## References

- [examples/login-test.js](./examples/login-test.js)
```

## Progressive Loading

Skills use three-level loading for efficient context:

1. **Discovery** (~100 tokens): Agent reads `name` and `description` from frontmatter (always available)
2. **Instructions** (<5000 tokens recommended): When description matches current task, loads `SKILL.md` body
3. **Resources** (as needed): Additional files (scripts, examples) load only when referenced

Keep file references one level deep from `SKILL.md`. Avoid deeply nested reference chains.

## When to Use

**Key Signal**: Repeatable, on-demand workflows with bundled assets (scripts, templates, reference docs).

## Domain Examples

| Domain | Examples |
|--------|----------|
| Engineering | Microservice deployment, incident response runbook, security review |
| Product | User research synthesis, roadmap prioritization, launch validation |
| Data | Customer segmentation, data quality validation, cohort analysis |
| Design | Design critique framework, user flow docs, design-to-dev handoff |
| Sales | Enterprise qualification, demo prep checklist, proposal framework |

## Asset Organization

| Folder | Purpose |
|--------|----------|
| `scripts/` | Code that runs each time (profiling, deployment, data fetch) |
| `references/` | Docs that clarify complex bits (architecture, API schemas) |
| `assets/` | Templates and boilerplate (Terraform, SQL templates, dashboard JSON) |

## Creation Process

### 1. Gather Requirements

- What workflow or domain knowledge should this skill provide?
- What resources are needed (scripts, templates, reference docs)?
- Should this be project-specific or personal?

### 2. Determine Location

| Scope | Path |
|-------|------|
| Project | `.github/skills/<skill-name>/SKILL.md` |
| Personal | `~/.copilot/skills/<skill-name>/SKILL.md` |

### 3. Create the Skill Folder

```
<skill-name>/
├── SKILL.md           # Required: instructions and metadata
├── scripts/           # Optional: executable code
├── references/        # Optional: documentation to load as needed
└── assets/            # Optional: templates, boilerplate
```

### 4. Write SKILL.md

```markdown
---
name: <skill-name>
description: '<keyword-rich description of what and when>'
---
# <Skill Title>

## When to Use
<Triggers and use cases>

## Procedure
<Step-by-step workflow>

## Resources
- [script.py](./scripts/script.py)
- [reference.md](./references/reference.md)
```

### 5. Add Resources

Create supporting files as needed, referencing them from SKILL.md with relative paths.

## Core Principles

1. **Keyword-rich descriptions**: The `description` frontmatter is how skills are discovered—include all relevant trigger words and use cases
2. **Progressive loading**: Keep SKILL.md under 500 lines; move detailed content to reference files
3. **Relative path references**: Always use `./` relative paths to reference skill resources
4. **Minimal context footprint**: Only load resources when needed—context window is shared
5. **Self-contained workflows**: Include all procedural knowledge needed to complete the task

## Anti-patterns

- **Vague descriptions**: Generic descriptions that don't help discovery (e.g., "A helpful skill")
- **Monolithic SKILL.md**: Putting everything in one file instead of using reference files
- **Absolute paths**: Using system paths instead of relative references
- **Missing procedures**: Descriptions of what but not how—skills need step-by-step guidance
- **Untested scripts**: Including scripts without verifying they work in the target environment
- **Duplicate content**: Copying reference content into SKILL.md instead of linking
- **Name mismatch**: Folder name doesn't match the `name` field in frontmatter