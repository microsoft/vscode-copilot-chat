# Phase 0: Next Cursor Prediction (Before Multi-Location UI)

## **Problem**
User makes edit at line 118 → NES suggests next edit at line 690 → **User has to manually move cursor there**

## **Simple Solution**
When NES returns a far-away suggestion, **automatically move the cursor** to that location.

## **Implementation** (2 hours total)

### **1. Add Cursor Hint to NES Response**
**File**: `src/extension/xtab/common/types.ts`

```typescript
interface NESEnhancedResponse {
  edit: LineReplacement;
  metadata?: {
    suggestedNextCursorLine?: number;  // Line number for next cursor position
    reasoning?: string;                // Why this location?
    confidence?: number;               // 0-1 confidence in suggestion
  };
}
```

### **2. Enhance Prompt to Request Next Cursor Location**
**File**: `src/extension/xtab/common/promptCrafting.ts`

```typescript
function enhancePromptWithCursorPrediction(basePrompt: string, codemap: Codemap): string {
  return basePrompt + `

ADDITIONAL TASK:
After providing your edit suggestion, predict where the user should move their cursor next.

Consider:
- Related code that needs updating based on this change
- Pattern completion (if user added state, cursor should go to setter method)
- Structural relationships from the codemap:
${JSON.stringify(codemap.structured?.patterns, null, 2)}

Provide your response in this format:
<edit>
[your suggested code]
</edit>
<next_cursor_line>
[line_number]
</next_cursor_line>
<reasoning>
[brief explanation of why that location]
</reasoning>
`;
}
```

### **3. Parse LLM Response for Cursor Hint**
**File**: `src/extension/xtab/node/xtabProvider.ts`

```typescript
function parseLLMResponseWithCursor(response: string): NESEnhancedResponse {
  const editMatch = response.match(/<edit>(.*?)<\/edit>/s);
  const cursorMatch = response.match(/<next_cursor_line>(\d+)<\/next_cursor_line>/);
  const reasoningMatch = response.match(/<reasoning>(.*?)<\/reasoning>/s);
  
  return {
    edit: parseEdit(editMatch?.[1] || response),
    metadata: cursorMatch ? {
      suggestedNextCursorLine: parseInt(cursorMatch[1]),
      reasoning: reasoningMatch?.[1]?.trim(),
      confidence: 0.85  // Could be extracted from LLM response
    } : undefined
  };
}
```

### **4. Move Cursor After Edit Acceptance**
**File**: `src/extension/xtab/node/xtabProvider.ts`

```typescript
async function onNESAccepted(edit: NESEnhancedResponse, editor: TextEditor) {
  // Apply the edit
  await applyEdit(edit.edit, editor);
  
  // Move cursor to suggested location
  if (edit.metadata?.suggestedNextCursorLine) {
    const targetLine = edit.metadata.suggestedNextCursorLine;
    const targetPosition = new Position(targetLine - 1, 0);
    
    editor.selection = new Selection(targetPosition, targetPosition);
    editor.revealRange(
      new Range(targetPosition, targetPosition),
      TextEditorRevealType.InCenter
    );
    
    // Optional: Show hint
    showCursorHint(editor, edit.metadata.reasoning || 'Next suggested edit location');
  }
}

function showCursorHint(editor: TextEditor, message: string) {
  // Show subtle decoration or status message
  vscode.window.setStatusBarMessage(`💡 ${message}`, 3000);
}
```

## **User Experience**

### **Before:**
1. User adds `isLoading` state at line 118
2. NES suggests comment fix at line 119 ✅
3. User accepts
4. **User manually scrolls to line 690** ← Problem!
5. User adds cursor position at line 690
6. NES suggests `setIsLoading(true)` ✅

### **After (Phase 0):**
1. User adds `isLoading` state at line 118
2. NES suggests comment fix at line 119 ✅
3. User accepts
4. **Cursor automatically jumps to line 690** ✨
5. NES suggests `setIsLoading(true)` immediately ✅
6. User accepts
7. **Cursor jumps to line 695** (next suggestion) ✨

### **After (Phase 1 - Multi-Location):**
1. User adds `isLoading` state at line 118
2. NES shows: "Loading state pattern detected: 5 edits suggested"
3. User expands and sees all 5 suggested locations
4. User clicks "Accept All"
5. Done! ✅

## **Advantages of Phase 0**

1. **2 hours vs 31 hours** - Get value immediately
2. **No UI changes** - Uses existing NES UI
3. **No API changes** - Just enhanced prompting
4. **Validates LLM capability** - Tests if model can predict next location
5. **Smooth transition to Phase 1** - Same underlying logic, just different UI

## **Combined Timeline**

### **Week 1: Phase 0 (Cursor Prediction)**
- Day 1: Implement cursor prediction (2 hours)
- Day 2-5: Test and validate predictions are accurate

### **Week 2: Gather Data**
- Track cursor prediction accuracy
- Measure how often users accept cursor suggestions
- Identify most common patterns
- **Decision point**: Are predictions accurate enough? (Need >70% accuracy)

### **Week 3-4: Phase 1 (If Phase 0 validates)**
- Implement multi-location UI only if cursor predictions prove LLM can find all locations
- Use learnings from Phase 0 to refine pattern detection

## **Key Insight**

Phase 0 **validates the core assumption**: Can the LLM, with codemap context, predict the next relevant location?

If Phase 0 shows:
- ✅ LLM correctly predicts next location >70% of time → Proceed to Phase 1
- ❌ LLM predictions are random → Fix pattern detection before building UI

## **Recommended Path**

1. **This week**: Implement Phase 0 cursor prediction
2. **Next week**: Collect metrics on prediction accuracy
3. **Decision**: Only build Phase 1 multi-location UI if Phase 0 proves LLM can do it

This de-risks the 31-hour investment in Phase 1!
