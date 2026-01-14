---
name: prompt-creation
description: Creating reusable prompt files (.prompt.md) for common tasks and slash commands
---

# Prompt File Creation

## Description
Comprehensive guide for creating reusable prompt files (.prompt.md) that define standalone, repeatable chat requests for common tasks and workflows.

## When to Use
Apply this skill when the user wants to:
- Create a reusable chat request for frequent tasks
- Define slash commands for quick access to common operations
- Package a complete workflow into a single invokable prompt
- Share standardized prompts across team members
- Create task templates (e.g., code review, documentation, refactoring)

## Prompt File Structure

Prompt files use YAML frontmatter followed by Markdown instructions.

### Complete Structure

```markdown
---
name: promptName                    # Required: Unique identifier (camelCase)
description: Brief description      # Required: One-line purpose statement
argument-hint: Expected input       # Optional: What arguments to provide
tools: ['tool1', 'tool2']          # Optional: Tools the prompt can use
mode: edit                          # Optional: 'edit', 'agent', or omit for default
---
[Your prompt instructions in Markdown]

Describe the task step-by-step.
Use placeholders for context: "the selected code", "the current file", etc.
Provide clear, actionable instructions.
```

### Frontmatter Fields

#### Required Fields

```yaml
name: generateUnitTests
description: Generate comprehensive unit tests for selected code
```

- **name**: Identifier used for slash command (e.g., `/generateUnitTests`)
  - Use camelCase
  - 1-3 words preferred
  - Letters, digits, underscores, hyphens, periods allowed
  - Must be unique

- **description**: Brief explanation (1 sentence, ≤15 words)
  - Action-oriented
  - Describes what the prompt does
  - Shows in autocomplete

#### Optional Fields

```yaml
argument-hint: File path or description
tools: ['search', 'edit', 'usages']
mode: edit
```

- **argument-hint**: Guides user on what to provide
  - Examples: "The feature to document", "Code to refactor"
  - Shows as placeholder text

- **tools**: Array of tool names prompt can use
  - Limits tool availability for focused operation
  - Common: `search`, `edit`, `usages`, `problems`, `changes`
  - Omit to allow all available tools

- **mode**: Chat mode for execution
  - `edit`: File editing mode
  - `agent`: Agent mode with full tool access
  - Omit for standard chat mode

## Best Practices

### 1. Use Clear, Action-Oriented Names

❌ **Poor**: `helper`, `utility`, `doStuff`
✅ **Good**: `generateUnitTests`, `refactorForPerformance`, `explainApiDesign`

### 2. Write Generalized Instructions

Avoid conversation-specific details:

❌ **Too Specific**:
```markdown
Fix the bug in app.ts line 42 where the user variable is undefined
```

✅ **Generalized**:
```markdown
Analyze the selected code for potential null/undefined errors.
Identify variables that may be null or undefined.
Add appropriate null checks and error handling.
```

### 3. Use Placeholders

Reference context generically:

```markdown
Review the selected code for:
1. Code quality and maintainability
2. Performance considerations
3. Security vulnerabilities
4. Best practices compliance

Provide specific recommendations for improvements.
```

### 4. Structure with Steps

Make complex tasks manageable:

```markdown
Generate comprehensive unit tests following these steps:

1. **Analyze the code structure**
   - Identify functions and methods to test
   - Note dependencies and side effects
   - Determine edge cases

2. **Create test cases**
   - Happy path scenarios
   - Error cases
   - Edge cases and boundary conditions
   - Mock external dependencies

3. **Write tests**
   - Use clear, descriptive test names
   - Follow Arrange-Act-Assert pattern
   - Include helpful comments
   - Ensure tests are independent

4. **Verify coverage**
   - Check all paths are tested
   - Validate assertions are meaningful
```

### 5. Specify Output Format

Tell what kind of response you want:

```markdown
Create a security review report with:

## Summary
Brief overview of findings

## Critical Issues
List any critical security concerns with:
- Location (file and line)
- Description of vulnerability
- Recommended fix

## Recommendations
Suggested improvements prioritized by severity
```

### 6. Include Context Hints

Guide the AI on what to consider:

```markdown
Refactor the selected code for better maintainability.

Consider:
- Breaking down large functions
- Extracting reusable logic
- Improving naming clarity
- Reducing complexity
- Adding appropriate documentation

Preserve existing functionality and tests.
```

## Common Prompt Patterns

### Code Generation

```markdown
---
name: generateComponent
description: Create a new React component with TypeScript
argument-hint: Component name and description
tools: ['edit', 'search']
---
Create a new React functional component with TypeScript.

Follow these requirements:
1. Use TypeScript with explicit prop types
2. Include proper documentation
3. Add accessibility attributes
4. Follow project's component structure
5. Create a corresponding test file

Component should include:
- Props interface definition
- Component function with typed props
- Appropriate hooks if needed
- Clear documentation comments
```

### Code Review

```markdown
---
name: reviewCode
description: Perform comprehensive code review
argument-hint: Code or files to review
tools: ['search', 'usages', 'problems']
---
Perform a thorough code review of the selected code or specified files.

Review for:
1. **Correctness**: Does the code work as intended?
2. **Style**: Does it follow project conventions?
3. **Performance**: Are there efficiency concerns?
4. **Security**: Any potential vulnerabilities?
5. **Maintainability**: Is it clear and well-structured?
6. **Testing**: Are tests adequate?

Provide:
- List of issues found with severity (Critical/High/Medium/Low)
- Specific recommendations for improvement
- Code examples where helpful
```

### Documentation

```markdown
---
name: documentApi
description: Generate comprehensive API documentation
argument-hint: API code or interface to document
tools: ['search', 'usages']
---
Generate comprehensive documentation for the selected API.

Include:
1. **Overview**: Brief description of purpose
2. **Parameters**: Each parameter with type and description
3. **Return Value**: Type and description
4. **Examples**: Common usage patterns
5. **Error Handling**: Possible errors and how to handle
6. **Notes**: Important considerations or limitations

Use JSDoc format for TypeScript/JavaScript, or appropriate format for the language.
```

### Refactoring

```markdown
---
name: extractFunction
description: Extract selected code into a reusable function
argument-hint: Code to extract
tools: ['edit', 'search', 'usages']
mode: edit
---
Extract the selected code into a well-named, reusable function.

Steps:
1. Analyze the selected code
2. Identify inputs and outputs
3. Create a descriptive function name
4. Extract to appropriate scope
5. Add type annotations
6. Add documentation
7. Replace original usage with function call
8. Ensure no side effects are broken

The extracted function should be:
- Pure if possible (no side effects)
- Well-documented
- Properly typed
- Located in appropriate module
```

### Testing

```markdown
---
name: generateE2ETest
description: Create end-to-end test for user workflow
argument-hint: User workflow to test
tools: ['edit', 'search']
---
Create an end-to-end test for the described user workflow.

Test should:
1. Set up test environment and data
2. Simulate user interactions step-by-step
3. Verify expected outcomes at each step
4. Check final state
5. Clean up after test

Use the project's E2E testing framework.
Include:
- Descriptive test name
- Clear test steps with comments
- Appropriate waits and assertions
- Error handling for flaky elements
```

### Analysis

```markdown
---
name: analyzePerformance
description: Analyze code for performance bottlenecks
argument-hint: Code or area to analyze
tools: ['search', 'usages']
---
Analyze the selected code or specified area for performance issues.

Look for:
1. **Inefficient algorithms**: O(n²) or worse where better exists
2. **Unnecessary computations**: Repeated calculations, redundant work
3. **Memory issues**: Leaks, excessive allocations
4. **Network overhead**: Too many requests, large payloads
5. **Rendering issues**: Unnecessary re-renders, large DOMs

Provide:
- Identified bottlenecks with impact assessment
- Suggested optimizations
- Code examples of improvements
- Trade-offs to consider
```

## File Locations

Prompt files can be stored in:

1. **Workspace Prompts**:
   - `.prompts/*.prompt.md`
   - `.github/prompts/*.prompt.md`
   - Custom location via settings

2. **Personal Prompts**:
   - Configure in VS Code settings for global access

3. **Settings Configuration**:
```json
{
  "chat.promptFilesLocations": [
    ".prompts",
    ".github/prompts"
  ]
}
```

## Using Prompt Files

### Via Slash Command

Type `/` in chat followed by the prompt name:
```
/generateUnitTests
```

With argument:
```
/reviewCode UserService.ts
```

### Via File Reference

Reference the file directly:
```
#file:.prompts/generateComponent.prompt.md Create a UserProfile component
```

### From Command Palette

Open Command Palette and search for the prompt name

## Example: Complete Prompt File

**.prompts/securityReview.prompt.md**
```markdown
---
name: securityReview
description: Comprehensive security review of code changes
argument-hint: Files or changes to review
tools: ['search', 'problems', 'changes', 'usages']
---
Perform a comprehensive security review of the specified code or recent changes.

## Scope Analysis

First, determine what to review:
- Use #tool:changes to see recent modifications if no files specified
- Focus on security-sensitive areas: authentication, authorization, data handling, external APIs

## Security Review

Check for common vulnerabilities following OWASP Top 10:

### 1. Injection Flaws
- SQL injection: Parameterized queries used?
- Command injection: User input in system commands?
- XSS: Output properly encoded?
- Path traversal: File paths validated?

### 2. Authentication Issues
- Passwords hashed with strong algorithm (bcrypt, Argon2)?
- Secure session management?
- Multi-factor authentication where appropriate?
- Proper logout functionality?

### 3. Sensitive Data Exposure
- Sensitive data encrypted at rest and in transit?
- Secure random number generation?
- No credentials in code or logs?
- PII handled according to regulations?

### 4. Authorization Checks
- Authorization verified on every request?
- Principle of least privilege applied?
- No direct object references without auth check?
- Role-based access control implemented correctly?

### 5. Security Misconfiguration
- Default credentials changed?
- Error messages don't leak sensitive info?
- Security headers configured (CSP, HSTS, etc.)?
- Dependencies up to date?

### 6. API Security
- Rate limiting implemented?
- Input validation on all endpoints?
- Proper CORS configuration?
- API keys secured?

## Report Format

Structure findings as:

### Critical Issues
Issues requiring immediate attention

For each:
- **Location**: [file.ts](file.ts#L42)
- **Vulnerability**: SQL injection via unsanitized input
- **Impact**: Attacker could access or modify database
- **Fix**: Use parameterized queries
- **Example**:
  ```typescript
  // ❌ Vulnerable
  db.query(`SELECT * FROM users WHERE id = ${userId}`);

  // ✅ Secure
  db.query('SELECT * FROM users WHERE id = ?', [userId]);
  ```

### Recommendations
Best practice improvements (non-critical)

### Summary
Overview of security posture and next steps
```

## Advanced Patterns

### Conditional Logic

```markdown
Analyze the selected code based on its type:

If it's a React component:
- Check for proper prop validation
- Verify hooks are used correctly
- Ensure accessibility attributes

If it's an API endpoint:
- Verify authentication and authorization
- Check input validation
- Ensure error handling

If it's a database query:
- Verify parameterization
- Check for proper transactions
- Ensure proper error handling
```

### Multi-Step Workflows

```markdown
Create a new feature following our workflow:

**Step 1: Planning**
- Analyze requirements
- Design data structures
- Plan architecture

**Step 2: Implementation**
- Write core logic
- Add error handling
- Follow project conventions

**Step 3: Testing**
- Create unit tests
- Add integration tests
- Verify edge cases

**Step 4: Documentation**
- Add inline comments
- Update API documentation
- Add usage examples

**Step 5: Review**
- Self-review against checklist
- Verify all tests pass
```

### Dynamic Context

```markdown
Generate tests for the selected code, adapting to the type:

Examine the code and create appropriate tests:
- **Functions/Methods**: Unit tests with mocks
- **Components**: Component tests with user interactions
- **APIs**: Integration tests with test server
- **Utilities**: Property-based tests for edge cases

Use the existing test framework and follow project patterns.
```

## Tips

1. **Test Your Prompts**: Try them on various inputs to ensure consistency
2. **Iterate**: Refine based on actual usage and feedback
3. **Keep Focused**: Each prompt should have one clear purpose
4. **Use Examples**: Show expected input/output format when helpful
5. **Version Control**: Track prompt evolution in git
6. **Document Intent**: Explain why certain instructions are included
7. **Share with Team**: Prompts are shareable assets
8. **Start Simple**: Begin with basic prompts, add complexity as needed
9. **Consider Edge Cases**: Think about unusual inputs
10. **Maintain Consistency**: Use similar structure across prompts

## Common Pitfalls

❌ **Too Vague**: "Improve the code"
✅ **Specific**: "Refactor for better readability by extracting functions and improving naming"

❌ **Too Specific**: "Fix line 42 in app.ts"
✅ **Generalized**: "Analyze and fix the error in the selected code"

❌ **Conversational**: "Can you please help me create tests?"
✅ **Direct**: "Generate unit tests for the selected code"

❌ **Missing Context**: "Review this"
✅ **Clear Context**: "Review the selected code for security vulnerabilities and best practices"
