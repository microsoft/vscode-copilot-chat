---
name: agent-creation
description: Creating custom agent files (.agent.md) for specialized AI assistants
---

# Agent Creation

## Description
Detailed guidance on creating custom agent files (.agent.md) in VS Code to extend the Copilot agent experience with specialized task-specific agents.

## When to Use
Apply this skill when the user wants to:
- Create a new custom agent for specific tasks (e.g., testing, documentation, code review, deployment)
- Understand the structure and capabilities of agent files
- Define specialized AI assistants with specific tools, behaviors, and personas
- Set up handoffs between agents for complex workflows

## Agent File Structure

Custom agents are defined in `.agent.md` files with YAML frontmatter and Markdown content.

### Frontmatter Fields

```yaml
---
name: AgentName                    # Required: Unique identifier for the agent
description: Brief description     # Required: One-line description of agent's purpose
argument-hint: Expected input      # Optional: Hint for what arguments the agent expects
tools: ['tool1', 'tool2']         # Optional: Array of tool names the agent can use
handoffs:                          # Optional: Handoff configurations to other agents
  - label: Button Label
    agent: target-agent-id
    prompt: Handoff instructions
    showContinueOn: true           # Whether to show "continue" button
    send: false                    # Whether to send immediately
---
```

### Content Guidelines

The content after frontmatter defines the agent's:
- **Core Identity**: Who the agent is and their expertise
- **Responsibilities**: What the agent should and shouldn't do
- **Workflows**: Step-by-step processes for handling requests
- **Rules and Constraints**: Behavioral boundaries and stopping conditions
- **Output Formats**: How to present results to users

## Best Practices

### 1. Clear Role Definition
Start with a strong identity statement:
```markdown
You are a [ROLE] specializing in [DOMAIN].

Your expertise lies in [KEY CAPABILITIES].
```

### 2. Explicit Stopping Rules
Define what the agent should NOT do:
```markdown
<stopping_rules>
STOP IMMEDIATELY if [CONDITION].

If you catch yourself [UNWANTED BEHAVIOR], STOP. [CORRECT BEHAVIOR].
</stopping_rules>
```

### 3. Structured Workflow
Use numbered steps or sections for clarity:
```markdown
<workflow>
## 1. [Phase Name]:

[Clear instructions for this phase]

MANDATORY: [Critical requirements]

## 2. [Next Phase]:

[Instructions]
</workflow>
```

### 4. Decision-Making Frameworks
Provide guidance for common scenarios:
```markdown
When [CONDITION]:
- Option A: [When to use]
- Option B: [When to use]
- Option C: [When to use]
```

### 5. Tool Selection
Only include tools the agent actually needs:
- `search`: Semantic and grep search across workspace
- `edit`: File editing capabilities
- `runSubagent`: Launch another agent for complex subtasks
- `usages`: Find symbol usages
- `problems`: Access diagnostic errors
- `changes`: View git changes
- `testFailure`: Access test failure information
- `fetch`: Fetch web content
- `githubRepo`: Search GitHub repositories
- MCP tools: Format as `server-name/tool-name`

### 6. Handoff Configuration
Define clear handoffs to other agents:
```yaml
handoffs:
  - label: Start Implementation   # What the button says
    agent: agent                  # Target agent ID
    prompt: Implement the plan    # What to say to the target agent
    showContinueOn: false         # Hide continue button
    send: true                    # Send immediately without user confirmation
```

## Common Agent Patterns

### Planning Agent
```markdown
You are a PLANNING AGENT, NOT an implementation agent.

<stopping_rules>
STOP IMMEDIATELY if you consider starting implementation.
</stopping_rules>

<workflow>
1. Research comprehensively using read-only tools
2. Present concise plan for review
3. Handle feedback and iterate
</workflow>
```

### Testing Agent
```markdown
You are a TESTING SPECIALIST focused on comprehensive test coverage.

<workflow>
1. Analyze code structure and identify test gaps
2. Generate appropriate tests (unit, integration, e2e)
3. Verify tests run successfully
4. Report coverage and recommendations
</workflow>
```

### Documentation Agent
```markdown
You are a DOCUMENTATION EXPERT specializing in clear, comprehensive documentation.

<workflow>
1. Analyze code to understand functionality
2. Generate documentation following project conventions
3. Include examples and usage patterns
4. Update related documentation files
</workflow>
```

### Review Agent
```markdown
You are a CODE REVIEW SPECIALIST focused on quality and best practices.

<workflow>
1. Analyze changes for correctness and style
2. Check against coding guidelines
3. Identify potential issues or improvements
4. Provide actionable feedback
</workflow>
```

## File Locations

Save agent files in appropriate locations:
- **Built-in agents**: `assets/agents/` (for extension development)
- **Workspace agents**: `.github/agents/` or `.copilot/agents/`
- **Personal agents**: `~/.copilot/agents/` or `~/.claude/agents/`

## Example: Complete Agent File

```markdown
---
name: SecurityReview
description: Performs security review of code changes
argument-hint: Files or changes to review
tools: ['search', 'problems', 'changes', 'usages']
handoffs:
  - label: Fix Issues
    agent: agent
    prompt: Fix the security issues identified in the review
---
You are a SECURITY REVIEW SPECIALIST with deep expertise in secure coding practices.

Your responsibility is to identify security vulnerabilities and provide actionable remediation guidance.

<stopping_rules>
STOP IMMEDIATELY if asked to implement fixes. Your role is review only.
</stopping_rules>

<workflow>
## 1. Analyze scope:

Determine what code needs security review:
- Recent changes (use #tool:changes)
- Specific files mentioned by user
- Related authentication/authorization code

## 2. Security review:

Check for common vulnerabilities:
- Injection flaws (SQL, XSS, command injection)
- Authentication and session management issues
- Sensitive data exposure
- Security misconfigurations
- Insufficient logging and monitoring

Use #tool:search and #tool:usages to trace data flows.

## 3. Report findings:

Present findings in priority order:
- **Critical**: Immediate security risks
- **High**: Significant concerns
- **Medium**: Best practice violations
- **Low**: Minor improvements

For each finding:
1. Description and location
2. Security impact
3. Recommended fix
4. Example (if helpful)

## 4. Offer handoff:

If issues found, offer handoff to implementation agent for fixes.
</workflow>

<security_checklist>
- [ ] Input validation and sanitization
- [ ] Output encoding
- [ ] Authentication mechanisms
- [ ] Authorization checks
- [ ] Sensitive data handling
- [ ] Cryptography usage
- [ ] Error handling and logging
- [ ] Dependency vulnerabilities
</security_checklist>
```

## Tips

1. **Be Specific**: Vague instructions lead to unpredictable behavior
2. **Test Thoroughly**: Create example scenarios to verify agent behavior
3. **Use Markdown Structure**: Headers, lists, and code blocks improve readability
4. **Version Control**: Keep agent files in git to track evolution
5. **Document Limitations**: Be explicit about what the agent cannot do
6. **Iterate**: Refine based on actual usage patterns
