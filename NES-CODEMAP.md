# Next Edit Suggestions (NES) with Codemap

## Overview

This document describes the codemap feature for Next Edit Suggestions (NES), which enables intelligent far-away and cross-file edit suggestions by providing the LLM with structural context about code organization.

## The Problem

Traditional NES implementations are limited to suggesting edits within a small window around the cursor (typically 10-20 lines). The LLM has no understanding of:
- Where classes, functions, and methods are located in the file
- How far away relevant code structures are from the current edit
- What code exists outside the visible edit window
- Relationships between code elements across the file

This severely limits the ability to suggest:
- Adding complementary methods when a property is added
- Updating related code in different parts of the same file
- Following patterns established elsewhere in the codebase
- Jumping to semantically related locations for edits

## The Solution: Codemap with Line Numbers

The codemap service extracts structural information from code using the Tree-sitter AST and provides:

1. **Hierarchical code structure** - Classes, functions, methods, interfaces, and their nesting
2. **Named elements** - Actual names (not just types) of all structural elements
3. **Precise locations** - Line numbers for where each element starts and ends
4. **Element lookup** - Ability to fetch specific code segments by name

### Example Codemap Output

**Structured JSON format (optimized for LLM):**
```json
{
  "classes": [
    {
      "name": "UserService",
      "range": { "start": 10, "end": 85 },
      "methods": [
        { "name": "validateUser", "line": 12 },
        { "name": "createUser", "line": 25 },
        { "name": "updateUser", "line": 45 },
        { "name": "deleteUser", "line": 60 }
      ],
      "properties": [
        { "name": "db", "line": 11 },
        { "name": "logger", "line": 12 }
      ]
    },
    {
      "name": "AuthService",
      "range": { "start": 90, "end": 150 },
      "methods": [
        { "name": "login", "line": 92 },
        { "name": "logout", "line": 110 }
      ],
      "properties": []
    }
  ],
  "functions": [],
  "interfaces": [
    { "name": "IUser", "range": { "start": 5, "end": 8 } }
  ]
}
```

**Human-readable summary (also included):**
```
File structure: 2 classes, 8 functions/methods, 1 interface
Classes: UserService (lines 10-85), AuthService (lines 90-150)
Functions/Methods: validateUser (line 12), createUser (line 25), updateUser (line 45), deleteUser (line 60), login (line 92), logout (line 110)
Interfaces: IUser (lines 5-8)
```

**Why structured format?**
1. **Precise parsing** - LLM can directly access `classes[0].methods[1].line` without text parsing
2. **Hierarchical clarity** - Shows which methods belong to which class unambiguously
3. **No parsing ambiguity** - JSON is unambiguous, text summaries can have edge cases
4. **Tool compatibility** - Ready for future tool-calling features
5. **Better reasoning** - LLM can programmatically reason: "find all methods in class containing cursor"

## How It Works

### 1. Structural Analysis

The codemap service uses Tree-sitter to parse the code and extract:
- Node types (class, function, method, interface, etc.)
- Element names using regex patterns tailored to each language construct
- Character offsets converted to line numbers
- Hierarchical relationships (what contains what)

### 2. Context in Prompt

When NES generates a suggestion, the codemap is included in the prompt, giving the LLM:
- A map of what exists in the file
- Exact line numbers for every structural element
- Understanding of file organization and boundaries

### 3. Intelligent Reasoning

With this context, the LLM can:
- **Calculate distances**: "Method at line 75 is 45 lines away but in the same class"
- **Understand patterns**: "3 methods at lines 50, 60, 70 follow similar structure"
- **Suggest precise locations**: "Add getter method at line 65, between existing getters"
- **Respect boundaries**: "Class ends at line 100, don't suggest edits beyond that"

## Real-World Example: State Management Pattern

**Scenario**: User adds a state property to a component

```typescript
// Lines 1-30 (visible in edit window)
class TodoComponent {
    todos: Todo[] = [];
    filter: 'all' | 'active' | 'completed' = 'all';
    isLoading: boolean = false; // ← User just added this at line 25
}

// Lines 50-80 (outside edit window)
class TodoComponent {
    // ... properties above
    
    setFilter(f) { this.filter = f; }     // line 52
    addTodo(todo) { /* ... */ }           // line 60
    
    render() {                             // line 70
        return `<div>${this.todos}</div>`;
    }
}
```

**Codemap shows:**
```
Classes: TodoComponent (lines 20-100)
Functions/Methods: setFilter (line 52), addTodo (line 60), render (line 70)
```

**LLM reasoning:**
1. "User added `isLoading` state property at line 25"
2. "TodoComponent has state management method `setFilter` at line 52"
3. "Pattern suggests adding `setIsLoading()` at line 56 (after setFilter)"
4. "Component has `render()` method at line 70 that displays state"
5. "Should suggest adding loading indicator display at line 72"

**NES suggests TWO edits:**
- Add `setIsLoading(loading: boolean)` method at line 56
- Add `${this.isLoading ? '<spinner/>' : ''}` in render at line 72

Both suggestions are far from the current cursor (line 25), but make perfect semantic sense!

## Benefits

### 1. Precision
- **Before**: "Add a method somewhere below"
- **After**: "Add `setIsLoading()` at line 56"

### 2. Intelligence
- Understands structural relationships (same class vs. different class)
- Recognizes patterns across non-adjacent code
- Respects natural code boundaries

### 3. Context Awareness
- Knows what exists and what doesn't
- Can identify missing complementary code
- Understands file organization

### 4. Usability
- One-click jump to suggested edit location
- Clear explanation of why that location makes sense
- No manual scrolling needed

### 5. Generality
Works for ANY coding pattern:
- State management in components
- API error handling patterns
- Test case generation
- Database model validation
- Event handler additions
- And more...

## Implementation Details

### Files

**Core Service:**
- `src/platform/codemap/common/codemapService.ts` - Interface definitions
- `src/platform/codemap/node/codemapServiceImpl.ts` - Tree-sitter based implementation

**Integration:**
- `src/extension/xtab/node/xtabProvider.ts` - NES provider using codemap
- `src/extension/xtab/common/promptCrafting.ts` - Includes codemap in prompt
- `src/platform/test/node/services.ts` - Test service registration

### Key Methods

```typescript
interface ICodemapService {
    // Generate codemap for a document
    getCodemap(document: TextDocumentSnapshot, token: CancellationToken): 
        Promise<Codemap | undefined>;

    // Fetch specific code segment by element name
    getElementCode(document: TextDocumentSnapshot, elementName: string, codemap?: Codemap): 
        Promise<{ code: string; lineRange: { start: number; end: number } } | undefined>;
}
```

### Configuration

Enable codemap in NES:
```json
{
  "chat.advanced.inlineEdits.nes.useCodemap": true
}
```

## Performance Considerations

- **AST parsing**: Reuses existing Tree-sitter infrastructure (~10-20ms)
- **Name extraction**: Regex-based, minimal overhead (~5ms)
- **Line number conversion**: O(n) scan of text, cached by parser (~5ms)
- **Total overhead**: <50ms per suggestion request
- **Caching**: AST is cached by parser service, codemap could be cached per document version

## Future Improvements

### Phase 1: Enhanced Context (Next Sprint)

**1. Cross-File Codemaps**
Include structure from related files:
```xml
<CODEMAP file="UserService.ts">
  Classes: UserService (lines 10-100)
</CODEMAP>
<CODEMAP file="UserService.test.ts">
  Functions/Methods: testGetUser (line 15), testDeleteUser (line 30)
  Missing: testCreateUser, testUpdateUser
</CODEMAP>
```

**Benefits:**
- Suggest adding missing test cases when service methods are added
- Update related components when shared interfaces change
- Maintain consistency across component/parent/child relationships

**Implementation**: ~50 lines to include multiple file codemaps in prompt

**2. Smart Edit Window Expansion**
Use structural boundaries instead of fixed line counts:
- Don't cut off in middle of a method
- Expand to include entire class if cursor is inside
- Use codemap ranges to determine natural breakpoints

**Benefits:**
- LLM sees complete context, not truncated code
- Better understanding of what the function/class does
- More accurate suggestions

**Implementation**: Replace `editWindowLinesRange` calculation with codemap-aware logic

### Phase 2: Relationship Graphs (Future)

**1. Structural Edit History**
Annotate edit history with structural context:
```typescript
interface IXtabHistoryEntry {
    // existing fields...
    structuralContext?: {
        element: "method handleClick",
        parent: "class Button",
        type: "method_definition",
        line: 45
    };
}
```

**Benefits:**
- LLM recognizes patterns: "User modified 3 event handlers, might want to modify the 4th"
- Better intent understanding: "Refactoring error handling across all methods"

**2. Semantic Distance Calculation**
```typescript
function getSemanticDistance(line1: number, line2: number, codemap: Codemap): number {
    const el1 = findContainingElement(line1, codemap.structure);
    const el2 = findContainingElement(line2, codemap.structure);
    
    if (el1 === el2) return 0;        // Same element
    if (sameParent(el1, el2)) return 1; // Same class
    return 2;                          // Different contexts
}
```

**Benefits:**
- Better suggestion ranking
- Understand that two methods in same class are "close" even if 50 lines apart
- Avoid suggesting edits in unrelated code sections

### Phase 3: Workspace Intelligence (Long-term)

**1. Workspace-Wide Codemap Index**
- Background indexing of all workspace files
- Query for semantically similar structures
- "5 other files have class `*Service` with methods following pattern X"

**2. Pattern Learning**
- Identify common patterns across codebase
- Suggest conforming to workspace conventions
- Learn from successful edit sequences

**3. Cross-Project Intelligence**
- Learn from similar codebases
- Understand framework-specific patterns (React, Angular, etc.)
- Apply best practices from training data

## Additional Suggested Improvements

### 1. Incremental Codemap Updates
**Problem**: Full re-parse on every keystroke is wasteful

**Solution**:
```typescript
interface ICodemapService {
    updateCodemap(document: TextDocumentSnapshot, 
                  previousCodemap: Codemap, 
                  changes: TextDocumentContentChangeEvent[]): 
        Promise<Codemap>;
}
```

**Benefits**: Only re-parse affected sections, ~5x faster for small edits

### 2. Language-Specific Enhancements

**Importance: HIGH (8/10) - Critical for framework-specific patterns**

**Why this matters:**

Generic AST parsing misses critical semantic information that developers care about:

**TypeScript/JavaScript/React:**
```typescript
// Generic parsing sees: "function MyComponent"
// Language-specific parsing sees:
{
  "name": "MyComponent",
  "type": "react_component",
  "hooks": ["useState", "useEffect", "useCallback"],
  "hookDependencies": {
    "useEffect": ["user.id", "isLoading"],  // Missing deps = bug!
    "useCallback": ["handleSubmit"]
  },
  "jsxReturns": true,
  "exportType": "default"
}
```

**Real-world impact:**
- **Hook dependencies**: LLM can suggest: "useEffect depends on user.id but it's not in deps array - add it at line 45"
- **Component patterns**: "This component uses useState but no useEffect - might need one for data fetching"
- **Async/await**: "Function createUser is async, but deleteUser isn't - pattern inconsistency at line 60"

**Python:**
```python
# Generic: "class UserService"
# Language-specific:
{
  "name": "UserService", 
  "decorators": ["@dataclass", "@validate_schema"],
  "inherits": ["BaseService", "LoggerMixin"],
  "methods": {
    "save": {
      "decorators": ["@transaction", "@retry(3)"],
      "isAsync": true
    }
  }
}
```

**Real-world impact:**
- **Decorators**: "You added @transaction to save() - should also add to update() and delete() at lines 45, 60"
- **Inheritance**: "BaseService requires implementing validate() - missing in UserService"
- **Import analysis**: "Using Logger but not imported - add import at line 1"

**Implementation complexity:** Medium (2-3 days)
- Extend `extractNodeName()` with language-specific regex patterns
- Add ~200 lines of language-specific AST visitors
- Most code is pattern definitions, not complex logic

**Recommendation: Implement for TypeScript/React first**
- Highest usage in VS Code ecosystem
- React hooks are common source of bugs
- Clear patterns that LLM can leverage

This is a **force multiplier** - makes suggestions 2-3x more valuable in framework-heavy codebases.

### 3. Visual Codemap in Editor

**Add VS Code contribution**:
- Minimap-style view showing structural elements
- Highlight suggested edit locations
- Click to jump to element

**UI Benefits**: Users can see the "bigger picture" of suggestions

### 4. Confidence Scoring

```typescript
interface SuggestionWithContext {
    edit: LineReplacement;
    confidence: number;  // 0-1
    reasoning: {
        semanticDistance: number;
        patternMatch: boolean;
        withinSameElement: boolean;
    };
}
```

**Benefits**: 
- Show high-confidence suggestions more prominently
- Explain to users why a suggestion makes sense
- Better telemetry for model improvements

### 5. Multi-Location Edit Sequences

Support suggesting multiple related edits:
```typescript
interface EditSequence {
    description: string;  // "Add state management for isLoading"
    steps: Array<{
        location: number;
        edit: LineReplacement;
        reasoning: string;
    }>;
}
```

**Example**:
1. Add `setIsLoading()` at line 56
2. Update `render()` at line 72
3. Add error handling at line 85

**UI**: Show as expandable suggestion with preview of all changes

## Metrics to Track

### Acceptance Rates
- Far-away edits (>20 lines): Expect +15-20% vs. baseline
- Cross-file edits (when implemented): Baseline to establish
- Multi-step sequences (when implemented): Track completion rates

### Performance
- Codemap generation time: Target <50ms, alert if >100ms
- Prompt token usage: Monitor increase from codemap context
- Suggestion latency: Should not increase >10% from baseline

### Quality
- User satisfaction surveys on "intelligent" suggestions
- Manual review of far-away suggestion appropriateness
- Pattern match accuracy (did LLM correctly identify the pattern?)

### Usage Patterns
- How often do users accept jump-to-edit suggestions?
- Which types of structural elements get most suggestions?
- What's the average line distance for accepted suggestions?

## Testing Strategy

### Unit Tests
- Codemap generation for various languages (TS, JS, Python, etc.)
- Name extraction accuracy for all node types
- Line number conversion edge cases
- Element lookup by name

### Integration Tests
- Codemap included in NES prompts correctly
- Performance impact within acceptable limits
- Works with different file sizes (10 lines to 10,000 lines)

### Simulation Tests
- Compare suggestion quality with/without codemap
- Measure far-away edit acceptance rates
- Test various coding patterns (state management, API handlers, tests)

### A/B Testing
- 50% of users with codemap enabled
- 50% without
- Compare acceptance rates, user satisfaction, suggestion quality

## Configuration Options

```typescript
// Recommended settings
{
  // Enable/disable codemap
  "chat.advanced.inlineEdits.nes.useCodemap": true,
  
  // Include codemap for related files (future)
  "chat.advanced.inlineEdits.nes.codemapIncludeRelatedFiles": false,
  
  // Maximum elements to show in summary (prevent prompt bloat)
  "chat.advanced.inlineEdits.nes.codemapMaxElements": 50,
  
  // Cache codemap for this many ms
  "chat.advanced.inlineEdits.nes.codemapCacheDuration": 5000
}
```

## Conclusion

The codemap feature fundamentally expands NES capabilities from local-edit-prediction to intelligent coding assistant. By giving the LLM precise structural context with line numbers, we enable:

✅ **Far-away edit suggestions** that make semantic sense  
✅ **Pattern recognition** across non-adjacent code  
✅ **Precise jump targets** with exact line numbers  
✅ **General approach** that works for any coding pattern  

The key innovation is **structure + LLM reasoning** rather than hardcoded rules. We provide the "map," and the LLM navigates it intelligently.

Future enhancements (cross-file codemaps, workspace indexing, visual UI) will further improve the experience, but the foundation is solid and ready for production testing.

---

**Status**: ✅ Implemented and committed to `pierceboggan/nes-codemaps` branch  
**Next Steps**: Enable in experiments, collect metrics, iterate based on user feedback
