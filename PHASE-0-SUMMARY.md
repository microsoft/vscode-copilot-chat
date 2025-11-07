# Phase 0: Cursor Prediction - Implementation Summary

## ✅ What Was Implemented

### 1. Enhanced Prompt with Cursor Prediction Instructions
**File**: `src/extension/xtab/common/promptCrafting.ts`

Added instructions to the prompt when codemap is available:
```typescript
CURSOR PREDICTION:
After providing your edit, predict where the developer should move their cursor next.
Consider:
- Related code that needs updating (React hooks, async functions, JSX)
- Pattern completion (state → setter → usage)
- File structure from codemap

Format:
<next_cursor_line>[line_number]</next_cursor_line>
<cursor_reasoning>[explanation]</cursor_reasoning>
```

### 2. Cursor Prediction Metadata Extraction
**File**: `src/platform/inlineEdits/common/dataTypes/cursorPredictionMetadata.ts`

Created utilities to:
- Extract `<next_cursor_line>` and `<cursor_reasoning>` from LLM response
- Parse line numbers and reasoning text
- Remove tags from response before edit processing

### 3. Telemetry Integration
**File**: `src/platform/inlineEdits/common/statelessNextEditProvider.ts`

Added to telemetry:
- `predictedNextCursorLine`: Line number LLM suggests
- `cursorPredictionReasoning`: Why that location
- `cursorPredictionConfidence`: Confidence score

### 4. XtabProvider Integration  
**File**: `src/extension/xtab/node/xtabProvider.ts`

- Extract cursor metadata from full LLM response
- Log predictions: `"Cursor prediction: line 690 - should update async function"`
- Store in telemetry for analysis

## 📊 How to Validate

### Run NES Simulation
```bash
npm run simulate -- --nes
```

### Check Logs for Cursor Predictions
Look in `.simulation/` output for lines like:
```
Cursor prediction: line 690 - User added loading state, should update downloadWallpaper async function to set isLoading
```

### Access Telemetry Data
Cursor predictions are in telemetry with:
- `predictedNextCursorLine`: 690
- `cursorPredictionReasoning`: "should update async function..."  
- `cursorPredictionConfidence`: 0.85

## 🎯 Success Criteria

**Phase 0 validates if the LLM can predict next location:**

✅ **Good** (Proceed to Phase 1):
- LLM predicts cursor location >70% of time
- Predictions align with actual user intent
- Codemap provides useful context for predictions

❌ **Needs Work** (Iterate on Phase 0):
- Predictions are random/unhelpful
- LLM ignores codemap context
- Low confidence scores

## 🚀 What's Next

### If Phase 0 Success Rate >70%:

**Immediate (Week 2):**
- Implement actual cursor movement after edit acceptance
- Show subtle UI hint about cursor jump
- Add user preference to disable

**Phase 1 (Weeks 3-4):**
- Multi-location edit sequences UI
- Pattern detection (loading states, error handling, etc.)
- Expandable preview widget

### If Phase 0 Success Rate <70%:

**Debugging:**
1. Check if codemap is reaching the prompt (enable verbose logging)
2. Improve prompt instructions
3. Add more examples to prompt
4. Try different model (GPT-4 vs Claude)

## 📁 Files Changed

```
src/extension/xtab/common/promptCrafting.ts
src/extension/xtab/node/xtabProvider.ts  
src/platform/inlineEdits/common/dataTypes/cursorPredictionMetadata.ts (NEW)
src/platform/inlineEdits/common/statelessNextEditProvider.ts
PHASE-0-CURSOR-PREDICTION.md (NEW - Design doc)
PHASE-0-SUMMARY.md (NEW - This file)
```

## 💡 Key Insights

1. **No UI Changes Yet** - This is pure telemetry/logging to validate capability
2. **Codemap is Critical** - LLM needs file structure to make smart predictions
3. **Telemetry-Driven** - Collect data first, build features second
4. **De-risks Phase 1** - Don't build 31 hours of UI if LLM can't predict locations

## 🧪 Example LLM Response

**Input (with codemap):**
```
User edited line 118: const [isLoading, setIsLoading] = useState(false);

Codemap shows:
- async function downloadWallpaper() at line 690
- JSX return statement at line 720
- onClick handlers at lines 705, 710
```

**Expected LLM Output:**
```typescript
<EDIT>
const [isLoading, setIsLoading] = useState(false); // Added loading state
</EDIT>
<next_cursor_line>690</next_cursor_line>
<cursor_reasoning>User added loading state - should update downloadWallpaper async function to call setIsLoading(true) at start and setIsLoading(false) on completion</cursor_reasoning>
```

## 📈 Metrics to Track

From telemetry:
- `predictedNextCursorLine` distribution
- Average confidence scores
- Correlation with actual user cursor movements (if tracked)
- Percentage of predictions that match user's next edit location

## ⚠️ Known Limitations

1. **Codemap might not be reaching simulation** - Need to verify in logs
2. **No actual cursor movement yet** - Just prediction logging
3. **Confidence scores are placeholder** (hardcoded 0.85) - Should come from LLM
4. **Only works when codemap is available** - Falls back gracefully

## 🔄 Iteration Plan

**Week 1 (Done):** ✅ Implement cursor prediction extraction and telemetry
**Week 2:** Analyze telemetry, validate prediction accuracy
**Week 3:** If >70% accurate, implement cursor movement
**Week 4:** If cursor movement works, start Phase 1 multi-location UI

---

**Branch**: `pierceboggan/nes-codemaps`
**Status**: Ready for testing and telemetry collection
**Next Action**: Run NES simulation and analyze cursor prediction logs
