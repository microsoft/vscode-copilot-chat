---
name: skill-creation
description: Creating skill files (SKILL.md) for domain-specific knowledge and expertise
---

# Skill Creation

## Description
Comprehensive guide for creating skill files (SKILL.md) that provide domain-specific knowledge and instructions accessible on-demand to enhance the AI agent's capabilities.

## When to Use
Apply this skill when the user wants to:
- Add domain-specific knowledge that the AI can reference
- Create reusable expertise modules (e.g., testing patterns, security practices, design patterns)
- Document specialized workflows or methodologies
- Build a knowledge base for specific technologies or frameworks
- Share expert knowledge across team or projects

## What are Skills?

Skills are Markdown files named `SKILL.md` that contain:
- **Domain Knowledge**: Specialized information about a topic
- **Best Practices**: Expert guidance on how to approach tasks
- **Examples**: Concrete demonstrations of concepts
- **Reference Material**: Information to consult when needed

Unlike prompts (which execute tasks) or instructions (which apply automatically), skills provide **knowledge on-demand** that the AI references when relevant.

## Skill File Structure

### Location and Naming

Skills must be in named folders with exactly one `SKILL.md` file:

```
.github/skills/
  ├── testing-patterns/
  │   └── SKILL.md
  ├── api-design/
  │   └── SKILL.md
  └── security-practices/
      └── SKILL.md
```

Alternative locations:
- `.claude/skills/` (Claude-specific)
- `~/.copilot/skills/` (personal skills)
- `~/.claude/skills/` (personal Claude skills)

### File Structure

```markdown
---
name: folder-name
description: Brief description for agent skill selection
---

# [Skill Name]

## Description
[1-2 sentence description of what this skill covers]

## When to Use
Apply this skill when [describe scenarios]:
- [Scenario 1]
- [Scenario 2]
- [Scenario 3]

## [Topic 1]

[Detailed content]

### [Subtopic]

[More detail]

## [Topic 2]

[More content]

## Tips

[Practical tips and best practices]
```

### Required Frontmatter

Skills must include YAML frontmatter at the top of the file:

```yaml
---
name: folder-name              # Must match the skill's folder name
description: Brief summary     # Helps the agent choose when to use this skill
---
```

- **name**: Must exactly match the folder name (e.g., `testing-patterns`)
  - Use kebab-case (lowercase with hyphens)
  - This is how the skill is referenced

- **description**: One-line summary to help the agent decide when to use this skill
  - Keep it concise (10-15 words)
  - Describe what the skill covers and when it's useful
  - Example: "Creating custom agent files (.agent.md) for specialized AI assistants"

### Required Sections

#### 1. Title (# Level 1 Header)
Clear, descriptive name for the skill:
```markdown
# React Testing Patterns
# API Design Principles
# Security Best Practices
```

#### 2. Description
Brief overview (1-2 sentences) of what the skill covers:
```markdown
## Description
Comprehensive guide to testing React components, hooks, and context providers using React Testing Library and Jest.
```

#### 3. When to Use
Describes when this skill should be applied:
```markdown
## When to Use
Apply this skill when:
- Writing tests for React components
- Setting up test infrastructure for React projects
- Debugging failing React tests
- Improving test coverage and quality
```

### Optional but Recommended Sections

```markdown
## Key Concepts
[Foundational knowledge]

## Best Practices
[Expert recommendations]

## Common Patterns
[Frequently used approaches]

## Examples
[Concrete demonstrations]

## Common Pitfalls
[What to avoid]

## Tips
[Practical advice]

## References
[External resources]
```

## Best Practices

### 1. Focus on One Domain

Each skill should cover one cohesive topic:

✅ **Good**:
- `testing-patterns/SKILL.md` - Testing approaches
- `react-hooks/SKILL.md` - React hooks usage
- `api-design/SKILL.md` - API design principles

❌ **Too Broad**:
- `everything-about-react/SKILL.md` - Split into smaller skills
- `general-programming/SKILL.md` - Too vague

### 2. Provide Depth

Skills should be comprehensive on their topic:

```markdown
# React Testing Patterns

## Description
Comprehensive guide to testing React components...

## Component Testing

### Testing User Interactions
[Detailed guidance on simulating clicks, inputs, etc.]

### Testing Async Behavior
[How to test loading states, data fetching, etc.]

### Testing Context and Hooks
[Patterns for testing context providers and custom hooks]

### Accessibility Testing
[Using testing library's accessibility queries]

## Common Patterns

### Setup and Teardown
[How to structure test files]

### Mocking
[When and how to mock dependencies]

### Test Data
[Creating maintainable test data]
```

### 3. Include Concrete Examples

Show, don't just tell:

```markdown
## Testing Custom Hooks

Custom hooks should be tested with `renderHook` from React Testing Library.

### Example: Testing a Data Fetching Hook

```typescript
// useUserData.ts
function useUserData(userId: string) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUser(userId).then(setUser).finally(() => setLoading(false));
  }, [userId]);

  return { user, loading };
}

// useUserData.test.ts
import { renderHook, waitFor } from '@testing-library/react';

test('should load user data', async () => {
  // Mock the fetch
  jest.spyOn(api, 'fetchUser').mockResolvedValue(mockUser);

  // Render the hook
  const { result } = renderHook(() => useUserData('123'));

  // Initially loading
  expect(result.current.loading).toBe(true);
  expect(result.current.user).toBe(null);

  // Wait for data to load
  await waitFor(() => expect(result.current.loading).toBe(false));

  // User should be loaded
  expect(result.current.user).toEqual(mockUser);
});
```
```

### 4. Structure for Scannability

Use clear headers and formatting:

```markdown
## Authentication Flows

### Basic Authentication
**When to use**: Simple, internal APIs
**How it works**: Username/password in header
**Security**: Use HTTPS only

### OAuth 2.0
**When to use**: Third-party integrations
**How it works**: Token-based authorization flow
**Security**: Requires proper token storage

### JWT
**When to use**: Stateless authentication needed
**How it works**: Self-contained tokens
**Security**: Validate signature, check expiration
```

### 5. Address Common Pitfalls

Help avoid mistakes:

```markdown
## Common Testing Mistakes

### ❌ Testing Implementation Details
```typescript
// Bad: Testing internal state
expect(component.state.count).toBe(5);
```

✅ **Instead**: Test what users see
```typescript
// Good: Testing rendered output
expect(screen.getByText('Count: 5')).toBeInTheDocument();
```

### ❌ Not Waiting for Async Updates
```typescript
// Bad: Asserting immediately
fireEvent.click(button);
expect(screen.getByText('Success')).toBeInTheDocument(); // Fails!
```

✅ **Instead**: Wait for updates
```typescript
// Good: Wait for async state
fireEvent.click(button);
await waitFor(() =>
  expect(screen.getByText('Success')).toBeInTheDocument()
);
```
```

### 6. Keep Updated

Skills are living documents:

```markdown
## React 18 Updates

### New Concurrent Features

With React 18, testing async behavior has changed:

**Before React 18**:
```typescript
act(() => {
  render(<App />);
});
```

**React 18+**:
```typescript
// act() is automatic with Testing Library
render(<App />);
```

### Automatic Batching
React 18 automatically batches updates, affecting test timing...
```

## Skill Topics and Examples

### Technical Domain Skills

#### Testing
```markdown
---
name: testing-patterns
description: Comprehensive testing strategies and best practices for modern applications
---

# Testing Patterns

## Description
Comprehensive testing strategies for modern applications

## When to Use
- Writing unit tests
- Creating integration tests
- Setting up test infrastructure
- Debugging test failures

## Unit Testing Best Practices
[Content]

## Integration Testing Strategies
[Content]

## Test Doubles (Mocks, Stubs, Spies)
[Content]

## Test Data Management
[Content]
```

#### Security
```markdown
---
name: security-practices
description: Security guidelines and vulnerability prevention for web applications
---

# Security Best Practices

## Description
Security guidelines and vulnerability prevention for web applications

## When to Use
- Reviewing code for security issues
- Implementing authentication/authorization
- Handling sensitive data
- Integrating third-party services

## Authentication Patterns
[Content]

## Input Validation and Sanitization
[Content]

## Common Vulnerabilities (OWASP Top 10)
[Content]

## Secure Data Storage
[Content]
```

#### Performance
```markdown
---
name: performance-optimization
description: Techniques for identifying and resolving performance bottlenecks
---

# Performance Optimization

## Description
Techniques for identifying and resolving performance bottlenecks

## When to Use
- Optimizing slow applications
- Analyzing performance metrics
- Implementing caching strategies
- Reducing bundle sizes

## Profiling and Measurement
[Content]

## React Performance Optimization
[Content]

## Database Query Optimization
[Content]

## Caching Strategies
[Content]
```

### Framework-Specific Skills

```markdown
---
name: nextjs-patterns
description: Best practices and patterns for Next.js applications
---

# Next.js Patterns

## Description
Best practices and patterns for Next.js applications

## When to Use
- Building Next.js applications
- Optimizing Next.js performance
- Implementing Next.js features
- Troubleshooting Next.js issues

## App Router vs Pages Router
[Content]

## Data Fetching Patterns
[Content]

## Server Components
[Content]

## Middleware and Edge Functions
[Content]
```

### Architectural Skills

```markdown
---
name: microservices-architecture
description: Principles and patterns for designing microservices-based systems
---

# Microservices Architecture

## Description
Principles and patterns for designing microservices-based systems

## When to Use
- Designing distributed systems
- Breaking down monoliths
- Implementing service communication
- Managing microservices complexity

## Service Boundaries
[Content]

## Communication Patterns
[Content]

## Data Management
[Content]

## Deployment and Orchestration
[Content]
```

### Process Skills

```markdown
---
name: code-review-guidelines
description: Structured approach to conducting effective code reviews
---

# Code Review Guidelines

## Description
Structured approach to conducting effective code reviews

## When to Use
- Reviewing pull requests
- Establishing review standards
- Mentoring through reviews
- Ensuring code quality

## Review Checklist
[Content]

## Feedback Techniques
[Content]

## Common Issues to Look For
[Content]

## Balancing Thoroughness and Speed
[Content]
```

## Skill Discovery

### Configuration

Enable skill usage in settings:
```json
{
  "chat.useAgentSkills": true,
  "chat.instructionsFilesLocations": [
    ".github/skills",
    ".claude/skills"
  ]
}
```

### Folder Structure

```
.github/skills/
  ├── testing-patterns/
  │   └── SKILL.md
  ├── react-best-practices/
  │   └── SKILL.md
  ├── api-design/
  │   └── SKILL.md
  ├── security-practices/
  │   └── SKILL.md
  └── performance-optimization/
      └── SKILL.md
```

Each skill folder should:
- Have a descriptive, kebab-case name
- Contain exactly one SKILL.md file
- Be in `.github/skills/` or `.claude/skills/` for workspace
- Be in `~/.copilot/skills/` or `~/.claude/skills/` for personal

## Complete Skill Example

**.github/skills/api-versioning/SKILL.md**
```markdown
---
name: api-versioning
description: API versioning strategies and migration best practices for evolving APIs
---

# API Versioning Strategies

## Description
Comprehensive guide to API versioning approaches, best practices, and migration strategies for maintaining backward compatibility while evolving APIs.

## When to Use
Apply this skill when:
- Designing a new API that will evolve over time
- Adding breaking changes to an existing API
- Planning API migration strategies
- Reviewing API design for version management
- Implementing API gateway or routing logic

## Versioning Approaches

### URL Path Versioning
Embed version in the URL path.

**Format**: `/api/v1/users`, `/api/v2/users`

**Pros**:
- Explicit and visible
- Easy to route
- Clear in documentation
- Supports caching per version

**Cons**:
- Pollutes URL structure
- Multiple endpoints for same resource

**When to use**: Public APIs, RESTful APIs, when clarity is priority

**Example**:
```typescript
// Express implementation
app.get('/api/v1/users', v1UsersController);
app.get('/api/v2/users', v2UsersController);

// Client usage
fetch('https://api.example.com/api/v1/users');
```

### Header Versioning
Specify version in custom header.

**Format**: `API-Version: 2`, `Accept: application/vnd.api.v2+json`

**Pros**:
- Clean URLs
- Flexible
- Follows HTTP standards

**Cons**:
- Less discoverable
- Harder to test in browser
- Requires header inspection

**When to use**: Internal APIs, when URL cleanliness matters

**Example**:
```typescript
// Express middleware
app.use((req, res, next) => {
  const version = req.headers['api-version'] || '1';
  req.apiVersion = version;
  next();
});

app.get('/api/users', (req, res) => {
  if (req.apiVersion === '2') {
    return v2UsersController(req, res);
  }
  return v1UsersController(req, res);
});

// Client usage
fetch('https://api.example.com/api/users', {
  headers: { 'API-Version': '2' }
});
```

### Query Parameter Versioning
Version as query parameter.

**Format**: `/api/users?version=2`

**Pros**:
- Simple to implement
- Easy to test
- Backward compatible default

**Cons**:
- Can be overridden/forgotten
- Mixed with query params
- Complicates caching

**When to use**: Simple APIs, optional versioning, gradual migration

### Content Negotiation
Use Accept header with media type.

**Format**: `Accept: application/vnd.company.v2+json`

**Pros**:
- RESTful standard
- Semantic versioning
- Supports format negotiation

**Cons**:
- Complex to implement
- Less familiar to developers
- Requires custom media types

**When to use**: Strict REST APIs, when media type matters

## Version Management

### Deprecation Strategy

**Announce Early**:
```typescript
// Include deprecation warnings
res.setHeader('X-API-Deprecation', 'true');
res.setHeader('X-API-Sunset', '2024-12-31');
```

**Timeline**:
1. Announce deprecation (6+ months notice)
2. Mark as deprecated in docs
3. Add warning headers
4. Eventually remove

**Communication**:
- Update changelog
- Email affected clients
- Dashboard warnings
- In-response headers

### Backward Compatibility

**Additive Changes** (Non-Breaking):
- ✅ Adding new endpoints
- ✅ Adding optional fields
- ✅ Adding new response fields
- ✅ Making required fields optional

**Breaking Changes** (Require New Version):
- ❌ Removing endpoints
- ❌ Removing request/response fields
- ❌ Changing field types
- ❌ Making optional fields required
- ❌ Changing authentication

### Migration Path

```typescript
// Support both versions during transition
class UserController {
  async getUser(req: Request, res: Response) {
    const user = await userService.getUser(req.params.id);

    if (req.apiVersion === 'v1') {
      // V1 format
      return res.json({
        id: user.id,
        name: user.fullName,
        email: user.email
      });
    }

    // V2 format (split name)
    return res.json({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      createdAt: user.createdAt
    });
  }
}
```

## Best Practices

### 1. Version Early
Don't wait for breaking changes:
```typescript
// Start with v1 immediately
app.use('/api/v1', routes);
```

### 2. Document Versions
Maintain clear documentation:
```markdown
## API Versions

### v2 (Current)
- Released: 2024-01-15
- Changes: Split name field into firstName/lastName

### v1 (Deprecated)
- Deprecated: 2024-01-15
- Sunset: 2024-07-15
- Use v2 for new integrations
```

### 3. Monitor Usage
Track version adoption:
```typescript
// Log version usage
logger.info('API request', {
  version: req.apiVersion,
  endpoint: req.path,
  userId: req.user?.id
});
```

### 4. Default to Latest Stable
```typescript
const version = req.headers['api-version'] || 'v2'; // Latest stable
```

### 5. Validate Version
```typescript
const SUPPORTED_VERSIONS = ['v1', 'v2'];

if (!SUPPORTED_VERSIONS.includes(req.apiVersion)) {
  return res.status(400).json({
    error: 'Unsupported API version',
    supported: SUPPORTED_VERSIONS
  });
}
```

## Common Pitfalls

### ❌ No Versioning from Start
Starting without versions makes it impossible to introduce breaking changes cleanly.

### ❌ Too Many Simultaneous Versions
Maintaining 3+ versions becomes untenable. Sunset old versions aggressively.

### ❌ No Deprecation Policy
Without clear sunset dates, clients never migrate.

### ❌ Breaking Changes in Minor Versions
Semantic versioning should apply: major.minor.patch

### ❌ Inconsistent Versioning Across Services
Use the same approach across all microservices.

## Testing Versioned APIs

```typescript
describe('API Versioning', () => {
  describe('v1', () => {
    test('should return v1 format', async () => {
      const response = await request(app)
        .get('/api/v1/users/123')
        .expect(200);

      expect(response.body).toHaveProperty('name');
      expect(response.body).not.toHaveProperty('firstName');
    });
  });

  describe('v2', () => {
    test('should return v2 format', async () => {
      const response = await request(app)
        .get('/api/v2/users/123')
        .expect(200);

      expect(response.body).toHaveProperty('firstName');
      expect(response.body).toHaveProperty('lastName');
      expect(response.body).not.toHaveProperty('name');
    });
  });
});
```

## Tips

1. **Version from day one**: Even if you don't foresee changes
2. **Semantic versioning**: major.minor.patch for clarity
3. **Sunset aggressively**: Don't maintain old versions indefinitely
4. **Communicate changes**: Use changelogs, headers, and notifications
5. **Test all versions**: Ensure each version works correctly
6. **Monitor adoption**: Track which versions are being used
7. **Document thoroughly**: Clear docs for each version
8. **Plan migrations**: Provide tools and support for upgrades
9. **Use feature flags**: For gradual rollouts within a version
10. **Coordinate with clients**: Give advance notice of changes

## References

- [Roy Fielding's REST Dissertation](https://www.ics.uci.edu/~fielding/pubs/dissertation/top.htm)
- [Semantic Versioning](https://semver.org/)
- [Microsoft REST API Guidelines](https://github.com/microsoft/api-guidelines)
- [Google API Design Guide](https://cloud.google.com/apis/design)
```

## Tips for Creating Skills

1. **Choose Clear Scope**: One cohesive topic per skill
2. **Provide Depth**: Be comprehensive on your topic
3. **Use Examples**: Show concrete implementations
4. **Stay Current**: Update as technology evolves
5. **Structure Clearly**: Use headers and formatting effectively
6. **Address Pitfalls**: Help others avoid common mistakes
7. **Include Context**: Explain "when" and "why", not just "how"
8. **Link to Resources**: Provide references for deeper learning
9. **Test for Clarity**: Have others review for understandability
10. **Version in Git**: Track skill evolution and improvements

## When Not to Create a Skill

Skills are not appropriate for:
- ❌ Project-specific code snippets (use instructions instead)
- ❌ Executable tasks (use prompts instead)
- ❌ Agent workflows (use agent files instead)
- ❌ Temporary or one-off information
- ❌ Information that changes frequently

Skills work best for:
- ✅ Timeless knowledge
- ✅ Reusable expertise
- ✅ Domain-specific best practices
- ✅ Technology-specific patterns
- ✅ Methodology and process guides
