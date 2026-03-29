---
name: instructions-creation
description: Creating instructions files (.instructions.md) for coding guidelines and best practices
---

# Instructions File Creation

## Description
Comprehensive guide for creating custom instructions files (.instructions.md) that define coding guidelines, conventions, and best practices tailored to your project.

## When to Use
Apply this skill when the user wants to:
- Define project-specific coding standards and conventions
- Specify language-specific guidelines
- Document architectural patterns and design principles
- Create rules that apply automatically during code generation
- Ensure consistent coding practices across the team

## Instructions File Structure

Instructions files use Markdown with optional frontmatter for language-specific targeting.

### Basic Structure

```markdown
# [Category Name]

[Description of what these instructions cover]

## [Specific Topic]

[Detailed guidelines and examples]

- Rule or guideline
- Another rule
- Example code snippets when helpful
```

### Language-Specific Instructions

Use frontmatter to target specific programming languages:

```markdown
---
applyTo: **/*.ts
---

# TypeScript Coding Guidelines

[TypeScript-specific instructions]
```

```markdown
---
applyTo: **/*.py
---

# Python Coding Guidelines

[Python-specific instructions]
```

Multiple patterns can be specified:
```markdown
---
applyTo:
  - **/*.ts
  - **/*.tsx
---
```

## Best Practices

### 1. Be Specific and Actionable

❌ **Vague**: "Write good code"
✅ **Specific**: "Use descriptive variable names with whole words (e.g., `userCount` not `uc`)"

❌ **Vague**: "Handle errors properly"
✅ **Specific**: "Always wrap async operations in try-catch blocks and log errors with context"

### 2. Provide Examples

Show correct usage:
```markdown
## Function Naming

Functions should use camelCase and start with a verb:

✅ Good:
```javascript
function calculateTotal() { }
function getUserById(id) { }
```

❌ Avoid:
```javascript
function Total() { }
function user(id) { }
```
```

### 3. Explain the Why

Help developers understand reasoning:
```markdown
## Immutability

Prefer immutable data structures and avoid mutating function parameters.

**Rationale**: Immutability reduces bugs from unexpected side effects and makes code easier to reason about. It also enables better optimization and caching strategies.
```

### 4. Organize by Category

Group related guidelines together:
```markdown
# Code Organization

## File Structure
[Guidelines about organizing files]

## Module Exports
[Guidelines about what and how to export]

## Naming Conventions

### Variables
[Variable naming rules]

### Functions
[Function naming rules]

### Classes
[Class naming rules]
```

### 5. Include Language-Specific Details

For TypeScript:
```markdown
## Type Annotations

- Always provide explicit return types for functions
- Use `interface` for object shapes, `type` for unions/intersections
- Avoid `any` - use `unknown` when type is truly unknown
- Use `readonly` for properties that shouldn't change
```

For Python:
```markdown
## Type Hints

- Use type hints for all function signatures
- Import from `typing` module for complex types
- Use `Optional[T]` for nullable values
- Document expected types in docstrings
```

### 6. Address Common Pitfalls

```markdown
## Common Mistakes to Avoid

### 1. Modifying Props
❌ Never mutate props directly in React components
✅ Use state or derive computed values

### 2. Missing Error Boundaries
❌ Letting errors crash the entire app
✅ Wrap component trees in error boundaries

### 3. Ignoring Accessibility
❌ Forgetting ARIA labels and keyboard navigation
✅ Include semantic HTML and ARIA attributes
```

## File Organization Patterns

### Single Global Instructions File

For smaller projects, use one comprehensive file:

**.github/copilot-instructions.md**
```markdown
# Project Coding Guidelines

## General Principles
[Cross-language guidelines]

## TypeScript Guidelines
[TS-specific rules]

## React Guidelines
[React-specific rules]

## Testing Guidelines
[Testing rules]
```

### Multiple Specialized Files

For larger projects, separate by concern:

**.github/instructions/typescript.instructions.md**
**.github/instructions/react.instructions.md**
**.github/instructions/testing.instructions.md**
**.github/instructions/security.instructions.md**

Reference them in settings:
```json
{
  "chat.instructionsFilesLocations": [
    ".github/instructions"
  ]
}
```

### Language-Specific Organization

Use frontmatter to automatically apply:

**.github/instructions/languages.instructions.md**
```markdown
---
applyTo: **/*.ts
---
# TypeScript Guidelines
[TS rules]

---
applyTo: **/*.py
---
# Python Guidelines
[Python rules]
```

## Content Categories

### 1. Naming Conventions
```markdown
## Naming Conventions

### Variables
- Use descriptive names: `userProfile` not `up`
- Boolean variables start with `is`, `has`, `should`: `isValid`, `hasPermission`
- Constants in UPPER_SNAKE_CASE: `MAX_RETRY_COUNT`

### Functions
- Start with verbs: `getUserProfile`, `validateInput`, `handleClick`
- Async functions can use `fetch`, `load`, or `get` prefix: `fetchUserData`

### Files
- Use kebab-case: `user-profile.ts`
- Component files match component name: `UserProfile.tsx`
- Test files append `.test` or `.spec`: `user-profile.test.ts`
```

### 2. Code Style
```markdown
## Code Style

- Use tabs for indentation (project standard)
- Opening braces on same line: `if (condition) {`
- Single quotes for strings (except when double quotes needed)
- Trailing commas in multi-line arrays/objects
- Max line length: 120 characters
```

### 3. Error Handling
```markdown
## Error Handling

### Async Operations
Always use try-catch for async code:
```typescript
async function loadData() {
  try {
    const result = await fetchData();
    return result;
  } catch (error) {
    logger.error('Failed to load data', { error });
    throw new DataLoadError('Could not load data', { cause: error });
  }
}
```

### User-Facing Errors
Provide helpful error messages:
- ❌ "Error occurred"
- ✅ "Could not save profile. Please check your internet connection."
```

### 4. Architecture Patterns
```markdown
## Architecture Patterns

### Service Layer
Business logic belongs in service classes, not components:

```typescript
// ✅ Good
class UserService {
  async updateProfile(userId: string, data: ProfileData) {
    const validated = this.validateProfile(data);
    return this.repository.update(userId, validated);
  }
}

// ❌ Avoid
function UserProfileComponent() {
  const handleSave = () => {
    // Don't put business logic here
  };
}
```

### Dependency Injection
Use constructor injection for testability:
```typescript
class UserController {
  constructor(
    private userService: IUserService,
    private logger: ILogger
  ) {}
}
```
```

### 5. Testing Standards
```markdown
## Testing Standards

### Test Structure
Follow Arrange-Act-Assert pattern:
```typescript
test('should calculate total with tax', () => {
  // Arrange
  const items = [{ price: 100 }, { price: 200 }];
  const taxRate = 0.1;

  // Act
  const total = calculateTotal(items, taxRate);

  // Assert
  expect(total).toBe(330);
});
```

### Test Coverage
- Minimum 80% code coverage
- Test happy path and error cases
- Mock external dependencies
- Test edge cases and boundary conditions
```

### 6. Security Guidelines
```markdown
## Security Guidelines

### Input Validation
Always validate and sanitize user input:
```typescript
function processUserInput(input: string) {
  // Validate
  if (!isValidFormat(input)) {
    throw new ValidationError('Invalid input format');
  }

  // Sanitize
  const sanitized = sanitizeHtml(input);

  return sanitized;
}
```

### Authentication
- Never store passwords in plain text
- Use secure comparison for tokens: `crypto.timingSafeEqual()`
- Implement rate limiting on auth endpoints
- Use HTTPS only for sensitive operations
```

## File Locations

Instructions files can be placed in:

1. **Project Instructions**:
   - `.github/copilot-instructions.md` (default location)
   - `.github/instructions/*.instructions.md`

2. **Personal Instructions**:
   - Configure in VS Code settings for global application

3. **Settings Configuration**:
```json
{
  "chat.instructionsFilesLocations": [
    ".github/instructions",
    ".github/copilot-instructions.md"
  ]
}
```

## Integration with Copilot

Instructions files automatically apply when:
- Generating code in relevant files (based on `applyTo` patterns)
- Using Edit mode
- Using Agent mode
- Code suggestions and completions

They are included in the context automatically - no need to reference them explicitly.

## Example: Complete Instructions File

**.github/copilot-instructions.md**
```markdown
# Project Coding Guidelines

This document defines the coding standards and best practices for our TypeScript/React project.

## General Principles

1. **Clarity over Cleverness**: Code should be easy to understand
2. **Consistency**: Follow established patterns throughout the codebase
3. **Type Safety**: Leverage TypeScript's type system fully
4. **Test First**: Write tests before implementing features
5. **Document Intent**: Comments explain why, not what

## TypeScript Standards

### Type Usage
- Use explicit return types for all functions
- Prefer `interface` for object shapes
- Use `type` for unions, intersections, and complex types
- Avoid `any` - use `unknown` when type is genuinely unknown
- Use `readonly` for immutable properties

### Nullable Values
- Use `undefined` not `null` for optional values
- Mark optional properties with `?`: `property?: string`
- Use `Optional<T>` type for nullable return values

## React Patterns

### Component Structure
```typescript
// ✅ Use functional components with TypeScript
interface UserProfileProps {
  userId: string;
  onUpdate: (user: User) => void;
}

export function UserProfile({ userId, onUpdate }: UserProfileProps) {
  // Hooks at top
  const [user, setUser] = useState<User | null>(null);
  const { isLoading } = useUserData(userId);

  // Effects
  useEffect(() => {
    loadUser(userId).then(setUser);
  }, [userId]);

  // Event handlers
  const handleSave = useCallback(() => {
    if (user) onUpdate(user);
  }, [user, onUpdate]);

  // Render
  return <div>...</div>;
}
```

### State Management
- Use local state (`useState`) for component-specific data
- Use context for theme, auth, global settings
- Use proper state management library (Redux, Zustand) for complex app state
- Keep state as local as possible

## Testing Requirements

### Unit Tests
- Test file alongside source: `component.tsx` → `component.test.tsx`
- Use descriptive test names: `should update user when save button clicked`
- Mock external dependencies
- Aim for 80%+ coverage

### Integration Tests
- Test user workflows end-to-end
- Place in `__tests__/integration/`
- Use realistic test data
- Minimize mocking

## Error Handling

### User-Facing Errors
Show helpful messages:
```typescript
catch (error) {
  if (error instanceof NetworkError) {
    showError('Could not connect. Please check your internet.');
  } else if (error instanceof ValidationError) {
    showError(`Invalid data: ${error.field}`);
  } else {
    showError('An unexpected error occurred. Please try again.');
    logger.error('Unexpected error', { error });
  }
}
```

### Logging
- Use structured logging with context
- Include request IDs for tracing
- Log errors with full stack traces
- Never log sensitive data (passwords, tokens, PII)

## Security

- Sanitize all user input before use
- Use parameterized queries for database access
- Implement CSRF protection for state-changing operations
- Validate JWT tokens on every request
- Use Content Security Policy headers
- Keep dependencies updated

## Code Review Checklist

Before submitting PR, verify:
- [ ] Types are explicit and correct
- [ ] Tests pass and cover new code
- [ ] No console.log statements
- [ ] Error handling in place
- [ ] Accessibility attributes added
- [ ] Documentation updated
- [ ] No hardcoded secrets or credentials
```

## Tips

1. **Start Simple**: Begin with core guidelines and expand over time
2. **Make it Searchable**: Use clear headers and structure
3. **Keep it Updated**: Review and refine as project evolves
4. **Get Team Buy-in**: Involve team in creating guidelines
5. **Provide Examples**: Show correct usage with code samples
6. **Be Pragmatic**: Guidelines should help, not hinder productivity
7. **Reference Standards**: Link to established style guides when appropriate
8. **Version Control**: Track guidelines evolution in git
