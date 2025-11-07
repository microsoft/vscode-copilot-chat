# Codemap with Line Numbers - Enabling Far-Away Edit Suggestions

## Problem Solved

**Before**: NES could only suggest edits within a small window around the cursor. The LLM had no way to know:
- Where structural elements are located in the file
- How far away relevant code is from the current edit
- Where to suggest edits outside the visible window

**After**: NES can suggest edits anywhere in the file where it makes semantic sense, because the LLM now knows the exact line numbers of all structural elements.

## Key Changes

### 1. Line Numbers in Codemap Summary

**Old output**:
```
Classes: UserService, AuthService
Functions: validateUser, createUser, updateUser
```

**New output**:
```
Classes: UserService (lines 10-85), AuthService (lines 90-150)
Functions/Methods: validateUser (line 12), createUser (line 25), updateUser (line 45)
```

### 2. New Service Method: `getElementCode()`

Allows fetching code for specific structural elements by name:

```typescript
// Get the code for a specific method
const result = await codemapService.getElementCode(document, 'updateUser');
// Returns: { code: "updateUser() { ... }", lineRange: { start: 45, end: 58 } }
```

## How It Works

### Step 1: LLM Sees Structural Map with Locations

```xml
<CODEMAP>
File structure: 1 class, 6 methods
Classes: UserService (lines 10-100)
Functions/Methods: getUser (line 15), createUser (line 25), updateUser (line 40), deleteUser (line 55)
</CODEMAP>

<EDIT_WINDOW>
// Lines 20-30 visible
class UserService {
    // ...
    createUser(data) { 
        // User just edited this method
    }
```

### Step 2: LLM Reasons About Far-Away Locations

"User modified `createUser` at line 25. Based on the pattern, `updateUser` at line 40 and `deleteUser` at line 55 likely need similar changes."

### Step 3: NES Suggests Edit at Line 55

Even though current edit window is lines 20-30, NES can suggest:
- Jump to line 55 (`deleteUser` method)
- Apply similar pattern from `createUser` 
- User accepts → cursor jumps, edit applied

## Real-World Example: Your State Management Use Case

```typescript
// Lines 1-30 (current edit window)
class TodoComponent {
    todos: Todo[] = [];
    filter: 'all' | 'active' | 'completed' = 'all';
    isLoading: boolean = false; // ← User just added this state
}

// Lines 50-80 (outside edit window, but LLM knows it's here)
class TodoComponent {
    // ... state above
    
    setFilter(f) { this.filter = f; }     // line 52
    // ← LLM suggests: add setIsLoading() here at line 56
    
    render() {
        // ← LLM suggests: add loading spinner display here at line 75
    }
}
```

**Codemap shows**:
```
Classes: TodoComponent (lines 1-90)
Functions/Methods: setFilter (line 52), addTodo (line 60), render (line 70)
```

**LLM reasoning**:
1. "User added `isLoading` state at line 4"
2. "TodoComponent has method `setFilter` for the `filter` state at line 52"
3. "Pattern suggests adding `setIsLoading` at line 56 (after setFilter)"
4. "Component has `render` method at line 70 that should display loading state"
5. "Suggest two edits: state manager at line 56, UI update at line 75"

## Benefits

### Precision
- Exact line numbers for suggestions, not vague "somewhere below"
- LLM can calculate: "45 lines away, but in same class, so semantically close"

### Intelligence
- Understands file structure: "This class spans lines 10-100, edits within that range are related"
- Recognizes patterns: "Methods at lines 50, 60, 70 all have similar structure"

### Usability
- User sees: "Add setIsLoading() at line 56" with jump action
- One click → cursor jumps to right location, edit applied
- No manual scrolling to find where to add code

## Implementation Status

- [x] Extract line numbers from AST
- [x] Include in codemap summary
- [x] Add `getElementCode()` method for fetching specific elements
- [x] Update test services registration
- [ ] Enhance NES prompt to instruct LLM about far-away suggestions
- [ ] Parse LLM responses for multi-location edit suggestions
- [ ] Add UI for showing where far-away edits will be applied

## Metrics to Track

1. **Far-away edit acceptance rate**: Suggestions >20 lines from cursor
2. **Jump frequency**: How often users accept edits that cause cursor to jump
3. **Pattern completion**: Success rate for "add matching method/handler" scenarios
4. **User satisfaction**: Feedback on "intelligent" far-away suggestions

## Next Steps

See `docs/nes-codemap-improvements.md` for full roadmap, including:
- Cross-file codemap support
- Workspace-wide structure indexing
- Multi-step edit sequences
- Smart edit window expansion
