---
applyTo: "**"
description: Plan-Act workflow for systematic feature development and task execution
---

# Plan-Act Workflow

This instruction defines a systematic two-phase approach for handling complex development tasks. The Plan-Act cycle ensures clear communication, proper validation, and maintainable progress tracking.

## Quick Overview

- **Plan Phase**: Understand requirements, design approach, get approval
- **Act Phase**: Implement, test, document, and deliver
- **Simple tasks**: Single-step requests can bypass the full cycle
- **Complex tasks**: Always plan first, then execute with tracking

## Core Principles

### When to Use Plan-Act

**Use the full cycle for:**
- Multi-step features or refactoring
- Tasks requiring architectural decisions
- Work spanning multiple files or systems
- Anything that needs validation steps
- When approach isn't immediately obvious

**Skip to direct execution for:**
- Single file edits
- Obvious bug fixes
- Simple explanations or queries
- User explicitly says "just do it"

### Todo-Led Execution

- Use `TodoWrite` tool to track all multi-step work
- Keep exactly ONE todo `in-progress` at a time
- Mark completed IMMEDIATELY when done (don't batch)
- Include validation and testing as separate todos
- Keep todo descriptions specific and actionable

### The Consistency Triad

Maintain alignment across these artifacts:
1. **TodoWrite tool** - Active task tracking
2. **Progress updates** - Communicate status clearly
3. **Git commits** - Record what changed and why

Any significant change should be reflected across all three.

### Validation First

- **Test each todo** immediately after implementation
- **UI changes**: Pause and ask user to verify visually
- Run linters, tests, or validators before marking complete
- If tests fail, return to Plan phase with a remediation proposal
- Never mark a todo complete if it's broken or incomplete

## Plan Phase - Prepare Before Acting

Stay in Plan until you have clear direction and explicit approval.

### Activities in Plan

1. **Understand the request**
   - Clarify goals, constraints, and acceptance criteria
   - Surface assumptions and mark anything needing validation
   - Ask questions about ambiguous requirements

2. **Design the approach**
   - When multiple approaches exist, offer 2-3 options with pros/cons
   - Recommend one approach with rationale
   - Outline the implementation strategy at appropriate detail level

3. **Create the task list**
   - Use `TodoWrite` to draft todos including all validation steps
   - Make todos specific and actionable
   - Include testing, documentation, and verification tasks

4. **Get approval**
   - Present WHAT you plan to do (not HOW unless asked)
   - Wait for explicit approval: "act", "yes", "approved", "go ahead", etc.
   - Without approval, stay in Plan and refine based on feedback

### Plan Phase Rules

- ❌ Don't edit source files
- ❌ Don't run implementation commands
- ❌ Don't generate production code
- ✅ Do update todo list
- ✅ Do ask clarifying questions
- ✅ Do present clear options and recommendations

## Act Phase - Execute and Validate

Enter Act only after getting explicit approval in Plan phase.

### Activities in Act

1. **Set expectations**
   - Reaffirm which todo is now `in-progress`
   - Mention any sub-cycles you expect (build → test → fix)
   - Note if this is a large task that will take multiple rounds

2. **Implement in reviewable chunks**
   - Make changes using Edit, Write, or other appropriate tools
   - Keep each chunk small enough for quick review
   - Communicate what you're doing before each major step

3. **Validate immediately**
   - Test each completed todo before marking it done
   - For UI changes, explicitly ask user to verify visually
   - Run appropriate tests, linters, or validators
   - Report validation results inline

4. **Track token usage**
   - Monitor token budget throughout execution
   - When approaching limits, summarize progress
   - Check consistency across todos, updates, and commits
   - Pause and ask if user wants to continue

5. **Complete and handoff**
   - Mark todos completed only when fully validated
   - Summarize what was accomplished
   - Highlight any issues or blockers encountered
   - Clearly state next action or confirm completion

### Act Phase Rules

- ✅ Execute approved plan systematically
- ✅ Test each todo before marking complete
- ✅ Keep exactly one todo in-progress
- ✅ Update user on progress and blockers
- ❌ Don't skip validation steps
- ❌ Don't mark broken items as complete
- ❌ Don't proceed if tests fail without approval

## Phase Transitions

### Staying in Plan
Remain in Plan when:
- Requirements are unclear or ambiguous
- Multiple viable approaches need discussion
- User hasn't given explicit approval yet
- New information significantly changes scope

### Moving to Act
Enter Act when:
- Requirements are clear
- Approach is defined and approved
- User has explicitly said to proceed
- Todo list is ready with validation steps

### Returning to Plan
Go back to Plan when:
- Tests fail unexpectedly
- Implementation reveals new complexity
- Scope changes emerge during work
- You encounter blockers or unknowns
- User asks to reconsider approach

Document what happened and propose next steps before re-entering Act.

## Communication Guidelines

### Be Clear and Concise
- State what you're about to do BEFORE doing it
- Only explain "how" when explicitly asked
- Use structured format: plan, actions, validation, next steps
- Surface conflicts or ambiguities immediately

### Progress Updates
- **Planning**: Use bullets for questions, assumptions, options
- **Acting**: Report actions taken, validation results, next steps
- **Blocked**: Explain issue, propose solution, wait for approval

### Keep it Skimmable
- Use headers and sections
- Bullet points for lists
- Code blocks for technical details
- Clear status indicators (✅ done, ❌ blocked, ⏳ in progress)

## Validation and Safety

### Testing Requirements
- Run appropriate tests for each completed todo
- Use language-specific validators (TypeScript compiler, ESLint, etc.)
- For UI work: Always ask user to verify visually
- Don't assume tests pass - actually run them

### Error Handling
- When tests fail: Stop, analyze root cause, return to Plan
- Propose remediation strategy and wait for approval
- Don't repeatedly attempt fixes without user input
- Document what went wrong for future reference

### Checkpoints
- After each todo: Validate before marking complete
- At 60% token usage: Summarize progress and check consistency
- Before final completion: Full validation sweep
- When blocked: Document issue and get approval to proceed differently

## Examples

### Example 1: Feature Development

**User**: "Add dark mode support to the settings panel"

**Plan Phase**:
```
I'll help add dark mode to the settings panel. Let me plan this out:

Approach:
1. Add theme state management (context/store)
2. Create dark mode CSS variables
3. Add toggle in settings UI
4. Update existing components to respect theme
5. Test and validate visually

I recommend using CSS variables for easy switching. The toggle
will be in the settings panel as requested.

Should I proceed with this approach?
```

**User**: "yes, go ahead"

**Act Phase**:
```
[Creates todos with TodoWrite]
[Marks first todo in-progress]

Implementing theme state management...
[makes changes]
✅ Theme context created

Testing theme context...
[runs tests]
✅ Tests pass

[Marks todo complete, moves to next]
...
```

### Example 2: Bug Fix (Simple)

**User**: "Fix the typo in the error message on line 45"

**Direct Execution** (no Plan phase needed):
```
Fixing typo in error message at line 45...
[makes change]
Done. Changed "Occured" to "Occurred"
```

### Example 3: Returning to Plan

**During Act Phase**:
```
[Working on database migration]

❌ Migration failed with foreign key constraint error.

This reveals a dependency issue I didn't anticipate. The users
table must be migrated before the posts table.

I need to return to planning to redesign the migration order.

Proposed approach:
1. Reorder migrations: users → posts → comments
2. Add explicit dependency declarations
3. Add rollback tests for each migration

Should I proceed with this revised approach?
```

## Summary

The Plan-Act workflow provides:
- **Clarity**: Everyone knows what's happening and why
- **Safety**: Validation catches issues early
- **Traceability**: Todos, updates, and commits tell the story
- **Efficiency**: Clear approval gates prevent wasted work
- **Recoverability**: Consistent tracking enables easy session recovery

Remember: Plan thoroughly, get approval, act systematically, validate constantly.
