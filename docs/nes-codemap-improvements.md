# NES Codemap Improvements - General Approach

## Overview

This document outlines improvements to Next Edit Suggestions (NES) using codemap for better far-away and cross-file edit suggestions. The approach is **general and pattern-agnostic** - instead of hardcoding specific patterns (like "state management"), we provide rich structural context and let the LLM reason about relationships.

## Current Implementation

The codemap service now provides:
1. **Hierarchical structure** - Classes, functions, methods, interfaces with their locations
2. **Named elements** - Actual names of code elements (not just types)
3. **Rich summaries with line numbers** - Both counts and named lists of key elements with their locations
4. **Element lookup** - Ability to fetch code for specific structural elements by name

This is included in the NES prompt via the `<CODEMAP>` section.

### Example Codemap Output

```
<CODEMAP>
File structure summary: 2 classes, 8 functions/methods, 1 interface
Classes: UserService (lines 10-85), AuthService (lines 90-150)
Functions/Methods: validateUser (line 12), createUser (line 25), updateUser (line 45), deleteUser (line 60), login (line 92), logout (line 110)
Interfaces: IUser (lines 5-8)
</CODEMAP>
```

**Key improvement**: The LLM now sees WHERE each structural element is located, enabling it to:
- Suggest edits outside the current edit window (e.g., "add method at line 70 in UserService class")
- Understand spatial relationships (e.g., "current edit is in UserService, which ends at line 85")
- Request specific code segments (e.g., "to suggest an edit to updateUser method, I need lines 45-58")

## Key Philosophy

**Don't hardcode patterns - provide structure and let the LLM infer relationships.**

Instead of teaching the system "if you see a state variable, suggest a setter method," we:
1. Give the LLM the full structural map of the file
2. Show it where classes, functions, and methods are located
3. Let it reason: "User added property X at line 50, class has no methods yet, suggest adding a method at line 75"

## Improvements for Better Suggestions

### 1. Enhanced Structural Context (DONE)

**What we added:**
- Extract actual names from AST nodes (function names, class names, etc.)
- Include line ranges for all structural elements
- Generate summaries that list key elements by name

**Why it helps:**
- LLM can see "Class `UserManager` has methods: `getUser`, `deleteUser`"
- When user adds a field, LLM knows what methods already exist
- Can suggest adding complementary methods based on naming patterns

**Example scenario:**
```typescript
class User {
    name: string;
    email: string;
    // User just added: age: number;
}
```

Codemap provides:
```
Classes: User
Properties in User: name (line 2), email (line 3), age (line 4)
Methods in User: (none)
```

LLM can reason: "User added a property but no getter/setter exists. Suggest adding methods around line 5."

### 2. Cross-File Structure Awareness (TODO - High Priority)

**Problem:** NES currently only has codemap for the active file.

**Solution:**
- When generating NES prompt, include codemaps for recently viewed/edited files
- Add codemaps for files identified by `GitRelatedFilesProvider`
- Include in prompt as: `<RELATED_FILE path="test.ts"><CODEMAP>...</CODEMAP></RELATED_FILE>`

**Implementation:**
```typescript
// In xtabProvider.ts
const relatedFiles = await this.getRelatedFiles(activeDocument);
const relatedCodemaps = await Promise.all(
    relatedFiles.map(file => this.codemapService.getCodemap(file, token))
);
```

**Why it helps:**
- LLM sees "main.ts has class User, test.ts has no tests for User"
- Can suggest jumping to test.ts to add tests
- Understands cross-file relationships naturally

**Example:**
User edits `UserService.ts` → LLM sees `UserService.test.ts` has methods `testGetUser`, `testDeleteUser` but no `testUpdateUser` → Suggests adding test when user adds `updateUser` method.

### 3. Edit History + Structure Correlation (TODO - Medium Priority)

**Problem:** Edit history shows diffs but not structural context of those edits.

**Solution:**
- Annotate edit history with what structural element was modified
- "Line 45: Modified method `handleClick` in class `Button`"
- Helps LLM understand the semantic meaning of recent changes

**Implementation:**
```typescript
// Enhance IXtabHistoryEntry with structural context
interface IXtabHistoryEntry {
    // ... existing fields
    structuralContext?: {
        element: string; // "method handleClick"
        parent: string;  // "class Button"
        type: string;    // "method_definition"
    };
}
```

**Why it helps:**
- LLM can recognize patterns: "User modified 3 event handlers, might want to modify the 4th"
- Understands intent better: "Refactoring error handling across all methods"

### 4. Workspace-Wide Codemap Index (TODO - Low Priority, High Impact)

**Problem:** Only active file and a few related files have codemaps.

**Solution:**
- Background index all workspace files → codemap cache
- When NES runs, query index for semantically similar structures
- "Files with similar class structures to current file"

**Why it helps:**
- LLM can see: "5 other files have class `*Service` with methods following pattern X"
- Suggests conforming to workspace patterns
- Better for large codebases

### 5. Intelligent Edit Window Expansion (TODO - Medium Priority)

**Problem:** Current edit window is fixed size (N lines above/below).

**Solution:**
- Use codemap to determine natural boundaries
- Expand window to include entire function/class if cursor is inside it
- Don't cut off in the middle of a method

**Implementation:**
```typescript
function getSmartEditWindow(cursorLine: number, codemap: Codemap): Range {
    // Find the structural element containing cursor
    const element = findContainingElement(cursorLine, codemap.structure);
    if (element && element.range) {
        // Expand to include full element
        return element.range;
    }
    return getDefaultEditWindow(cursorLine);
}
```

**Why it helps:**
- LLM sees complete context, not truncated code
- Better understanding of what the function/class does
- More accurate suggestions

### 6. Semantic Distance Calculation (TODO - High Priority)

**Problem:** NES doesn't know if line 100 is "far" semantically or just physically.

**Solution:**
- Calculate semantic distance using codemap structure
- Two lines in same function = close
- Two lines in different classes = far
- Use this to adjust suggestion confidence

**Implementation:**
```typescript
function getSemanticDistance(line1: number, line2: number, codemap: Codemap): number {
    const el1 = findContainingElement(line1, codemap.structure);
    const el2 = findContainingElement(line2, codemap.structure);
    
    if (el1 === el2) return 0; // Same element
    if (sameParent(el1, el2)) return 1; // Same class/file section
    return 2; // Different contexts
}
```

**Why it helps:**
- Better ranking of suggestions
- Can suggest edits 100 lines away if they're in the same class
- Avoid suggesting edits in unrelated code sections

## Implementation Priority

### Phase 1: Core Enhancements (Current Sprint)
- [x] Extract named elements in codemap
- [x] Rich structural summaries
- [ ] Register CodemapService in test services (for simulation tests)
- [ ] Add configuration flag for codemap features

### Phase 2: Cross-File Intelligence (Next Sprint)
- [ ] Include codemaps for related files in prompt
- [ ] Integrate with `GitRelatedFilesProvider`
- [ ] Add related file codemaps to prompt

### Phase 3: Smart Boundaries (Future)
- [ ] Intelligent edit window expansion
- [ ] Semantic distance calculation
- [ ] Edit history structural annotation

### Phase 4: Workspace-Wide (Future)
- [ ] Background codemap indexing
- [ ] Workspace pattern matching
- [ ] Cross-project code structure learning

## Metrics to Track

1. **Acceptance rate** for suggestions >20 lines away
2. **Cross-file suggestion acceptance** (when implemented)
3. **Prompt token usage** (codemap adds context - measure impact)
4. **Time to first suggestion** (ensure codemap generation doesn't add latency)
5. **User satisfaction** with "smart" suggestions that understand code structure

## Testing Strategy

### Unit Tests
- Codemap generation for various code structures
- Name extraction accuracy
- Summary generation

### Integration Tests
- Codemap included in NES prompts correctly
- Performance impact < 50ms
- Works with TypeScript, JavaScript, Python, etc.

### Simulation Tests
- Compare suggestion quality with/without codemap
- Measure far-away edit acceptance rates
- Test cross-file scenarios (when implemented)

## Example Scenarios

### Scenario 1: Adding Related Methods
```typescript
// User edits
class Calculator {
    add(a, b) { return a + b; }
    subtract(a, b) { return a - b; }
    // Cursor here - user just added subtract
}
```

**Codemap provides:**
- Class Calculator has methods: add (line 2), subtract (line 3)
- No multiply, divide methods

**LLM can suggest:**
- Adding `multiply` method at line 4
- Adding `divide` method at line 5
- Following the established pattern

### Scenario 2: Missing Test Coverage (Cross-File)
```typescript
// UserService.ts
class UserService {
    getUser() { }
    createUser() { }
    updateUser() { } // Just added
}
```

**With cross-file codemap:**
- UserService.test.ts has: testGetUser, testCreateUser
- Missing: testUpdateUser

**LLM suggests:**
- Jump to UserService.test.ts
- Add testUpdateUser method

### Scenario 3: Consistent Error Handling
```typescript
class ApiClient {
    async fetchUser() {
        try { } catch { }
    }
    async fetchOrder() {
        try { } catch { }
    }
    async fetchProduct() {
        // Just added - no try/catch yet
    }
}
```

**Codemap shows:**
- fetchUser and fetchOrder both have try/catch at similar positions
- fetchProduct is missing the pattern

**LLM suggests:**
- Adding try/catch to fetchProduct
- Maintaining consistency with existing methods

## Key Insight

The power comes from **structure + LLM reasoning**, not hardcoded rules.

By providing:
- Exact locations of code elements
- Names and types of those elements  
- Hierarchical relationships

The LLM can naturally infer:
- "This class is missing complementary methods"
- "This file has a pattern, the new code should follow it"
- "Related file needs updating"

This works for **any** coding pattern, not just the ones we anticipate.

## How Line Numbers Enable Far-Away Edit Suggestions

### The Key Innovation

By including **line numbers** in the codemap, the LLM can now:

1. **Understand spatial context**: "Current edit window is lines 1-30, but class extends to line 100"
2. **Calculate distances**: "Method I want to suggest is at line 75, which is 45 lines away"  
3. **Make informed suggestions**: "Suggest edit at line 75 because that's where the getter methods are"
4. **Request additional context**: "I need to see lines 70-80 to properly suggest the edit"

### Example Flow: Adding a Property → Suggesting a Getter

**User Action**: Adds `age` property at line 25

```typescript
// Current edit window (lines 20-30)
class UserProfile {
    name: string;
    email: string;
    age: number; // ← User just added this
}
```

**Codemap in Prompt**:
```xml
<CODEMAP>
Classes: UserProfile (lines 20-100)
Functions/Methods: getName (line 50), getEmail (line 60), setName (line 75), setEmail (line 85)
</CODEMAP>

<EDIT_WINDOW>
Lines 20-30 shown above
</EDIT_WINDOW>
```

**LLM Reasoning**:
- "User added `age` property at line 25 (within edit window)"
- "UserProfile class has getters at lines 50 and 60 (outside edit window)"
- "Pattern: properties get corresponding getters ~25-35 lines later"
- "UserProfile class spans to line 100, so line 70 is within the class"
- "**Suggestion**: Add `getAge()` method at line 70, between existing getters"

**NES Output**: 
- Suggests edit at line 70 (far from current cursor)
- Provides context: "Add getter method following the pattern in UserProfile class"
- User can accept → cursor jumps to line 70, edit is applied

### Integration with NES Provider

The XtabProvider can now use codemap data to:

```typescript
// Pseudo-code for enhanced suggestion logic
if (codemap) {
    // Find what structural element contains the current edit
    const currentElement = findContainingElement(cursorLine, codemap);
    
    // Find related elements that might need edits
    const relatedElements = findRelatedElements(currentElement, codemap);
    
    // For each related element outside the edit window
    for (const element of relatedElements) {
        if (isOutsideEditWindow(element.lineRange, editWindow)) {
            // Include hint in prompt about this far-away location
            prompt += `\nNote: ${element.type} "${element.name}" at lines ${element.lineRange.start}-${element.lineRange.end}`;
        }
    }
}
```

### Benefits

1. **Precision**: LLM knows EXACTLY where to suggest edits (line number, not just "somewhere")
2. **Context**: Understands WHY that location makes sense (it's in the same class, near similar code)
3. **Confidence**: Can calculate semantic distance (same method = close, different class = far)
4. **Actionability**: NES can generate a specific jump target with exact line numbers

### Next Steps

To fully leverage this capability:

1. **Enhance prompt** to explicitly tell LLM: "You can suggest edits at any line number shown in the codemap"
2. **Add response parsing** to detect when LLM suggests edits outside edit window  
3. **Implement multi-location edits**: Support suggesting edits at multiple locations in one response
4. **Add visualization**: Show user a mini-map of where suggested edits are in the file

