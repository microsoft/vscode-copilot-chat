# NoEdit

```

Timeline (nested call hierarchy):
────────────────────────────────────────────────────────────
[  0ms] ├── [NES]
        │   │   │   │   ↳ invoked with trigger id = uuid = c90c2ca3-50a5-4ad1-b34c-ceb0eb52462d, reason = selectionChange
[  0ms] │   ├── [NextEditProvider]
        │   │   │   │   ↳ fetching next edit with shouldExpandEditWindow=false
[  0ms] │   │   ├── [9fdd]
        │   │   │   │   ↳ awaiting firstEdit promise
[  4ms] │   │   │   ├── [_getNextEdit]
        │   │   │   │   │   │   │   │   ↳ Debouncing for cursor NOT at end of line
[  4ms] │   │   │   │   ├── [fetchNextEdit]
        │   │   │   │   │   │   │   │   ↳ Using default nLinesBelow: 5
[  6ms] │   │   │   │   │   ├── [_executeNewNextEditRequest]
        │   │   │   │   │   │   │   │   ↳ Debouncing for 95 ms
[423ms] │   │   │   │   │   │   ├── [XtabProvider]
        │   │   │   │   │   │   │   │   │   │   ↳ Parsed edit_intent from first line: "no_edit" -> no_edit
[423ms] │   │   │   │   │   │   │   ├── [doGetNextEditWithSelection]
        │   │   │   │   │   │   │   │   │   │   ↳ Filtered out edit due to edit intent "no_edit" with aggressiveness "medium"
[424ms] │   │   │   │   │   │   ├── [pushEdit]
        │   │   │   │   │   │   │   ↳ processing edit #0 (starts at 0)
[424ms] │   │   │   │   │   │   │   ↳ no edit, reason: filteredOut
[425ms] │   │   │   │   ↳ resolved firstEdit promise
[425ms] │   │   │   │   ↳ First edit latency: 426 ms
[425ms] │   │   │   │   ↳ failed to fetch next edit filteredOut:editIntent:no_edit aggressivenessLevel:medium
[425ms] │   │   │   │   ↳ had no edit
[425ms] │   │   │   │   │   │   ├── [XtabProvider]
        │   │   │   │   │   │   │   │   │   │   ↳ Line 0 emitted with latency 310.2620999999999 ms
[428ms] │   │   │   │   │   │   │   ├── [doGetNextEditWithSelection]
        │   │   │   │   │   │   │   │   │   │   ↳ Line 1 emitted with latency 313.27710000000116 ms
[429ms] │   │   │   │   │   │   │   │   ├── [streamEditsWithFiltering]
        │   │   │   │   │   │   │   │   │   │   ↳ Line 2 emitted with latency 314.22490000000107 ms
```

# Medium + Medium agg

```

Timeline (nested call hierarchy):
────────────────────────────────────────────────────────────
[   0ms] ├── [NES]
         │   │   │   │   ↳ invoked with trigger id = undefined
[   1ms] │   ├── [NextEditProvider]
         │   │   │   │   ↳ fetching next edit with shouldExpandEditWindow=false
[   2ms] │   │   ├── [9306]
         │   │   │   │   ↳ awaiting firstEdit promise
[  10ms] │   │   │   ├── [_getNextEdit]
         │   │   │   │   │   │   │   │   ↳ Debouncing for cursor NOT at end of line
[  11ms] │   │   │   │   ├── [fetchNextEdit]
         │   │   │   │   │   │   │   │   ↳ Using default nLinesBelow: 5
[  16ms] │   │   │   │   │   ├── [_executeNewNextEditRequest]
         │   │   │   │   │   │   │   │   ↳ Debouncing for 90 ms
[1463ms] │   │   │   │   │   │   ├── [XtabProvider]
         │   │   │   │   │   │   │   │   │   │   ↳ Parsed edit_intent from first line: "medium" -> medium
[1464ms] │   │   │   │   │   │   │   ├── [doGetNextEditWithSelection]
         │   │   │   │   │   │   │   │   │   │   ↳ starting to diff stream against edit window lines with latency 1177.0332000000017 ms
[1465ms] │   │   │   │   │   │   │   │   ├── [streamEditsWithFiltering]
         │   │   │   │   │   │   │   │   │   │   ↳ Line 0 emitted with latency 1178.072500000002 ms
[1467ms] │   │   │   │   │   │   │   │   │   ├── [streamEdits]
         │   │   │   │   │   │   │   │   │   │   ↳ Line 1 emitted with latency 1180.5799000000006 ms
[1469ms] │   │   │   │   │   │   │   │   │   │   ↳ Line 2 emitted with latency 1181.7515000000021 ms
[3221ms] │   │   │   │   │   │   │   │   │   │   ↳ ResponseProcessor streamed edit #0 with latency 2934.4310000000005 ms
[3441ms] │   │   │   │   │   │   │   │   │   │   ↳ Ran diff for #0 with latency 3154.041100000002 ms
[3441ms] │   │   │   │   │   │   │   │   │   │   ↳ extracting edit #0: [3,5)->["    return a"]
[3443ms] │   │   │   │   │   │   │   │   │   ↳ Yielding an edit: [3,5)->["    return a"]
[3443ms] │   │   │   │   │   │   ├── [pushEdit]
         │   │   │   │   │   │   │   ↳ processing edit #0 (starts at 0)
[3443ms] │   │   │   │   │   │   │   ↳ resetting shouldExpandEditWindow to false due to receiving an edit
[3444ms] │   │   │   │   │   │   │   ↳ populated cache for 0
[3444ms] │   │   │   │   │   │   │   ↳ resolving firstEdit promise
[3445ms] │   │   │   │   ↳ resolved firstEdit promise
[3445ms] │   │   │   │   ↳ First edit latency: 1947 ms
[3445ms] │   │   │   │   ↳ fetch succeeded
[3445ms] │   │   │   │   ↳ cancelled
[3447ms] │   │   │   │   │   │   │   ↳ processing edit #1 (starts at 0)
[3447ms] │   │   │   │   │   │   │   ↳ 1 edits returned
```

# Low + Med agg

```
Timeline (nested call hierarchy):
────────────────────────────────────────────────────────────
[  0ms] ├── [NES]
        │   │   │   │   ↳ invoked with trigger id = uuid = f2d8b5bd-df25-4a1d-a2f3-07ea5ce715ad, reason = selectionChange
[  0ms] │   ├── [NextEditProvider]
        │   │   │   │   ↳ fetching next edit with shouldExpandEditWindow=false
[  0ms] │   │   ├── [c58b]
        │   │   │   │   ↳ awaiting firstEdit promise
[  5ms] │   │   │   ├── [_getNextEdit]
        │   │   │   │   │   │   │   │   ↳ Debouncing for cursor NOT at end of line
[  6ms] │   │   │   │   ├── [fetchNextEdit]
        │   │   │   │   │   │   │   │   ↳ Using default nLinesBelow: 5
[  9ms] │   │   │   │   │   ├── [_executeNewNextEditRequest]
        │   │   │   │   │   │   │   │   ↳ Debouncing for 93 ms
[310ms] │   │   │   │   │   │   ├── [XtabProvider]
        │   │   │   │   │   │   │   │   │   │   ↳ Parsed edit_intent from first line: "low" -> low
[310ms] │   │   │   │   │   │   │   ├── [doGetNextEditWithSelection]
        │   │   │   │   │   │   │   │   │   │   ↳ Filtered out edit due to edit intent "low" with aggressiveness "medium"
[311ms] │   │   │   │   │   │   ├── [pushEdit]
        │   │   │   │   │   │   │   ↳ processing edit #0 (starts at 0)
[311ms] │   │   │   │   │   │   │   ↳ no edit, reason: filteredOut
[311ms] │   │   │   │   ↳ resolved firstEdit promise
[311ms] │   │   │   │   ↳ First edit latency: 311 ms
[311ms] │   │   │   │   ↳ failed to fetch next edit filteredOut:editIntent:low aggressivenessLevel:medium
[311ms] │   │   │   │   ↳ had no edit
[311ms] │   │   │   │   │   │   ├── [XtabProvider]
        │   │   │   │   │   │   │   │   │   │   ↳ Line 0 emitted with latency 204.49589999999807 ms
[395ms] │   │   │   │   │   │   │   ├── [doGetNextEditWithSelection]
        │   │   │   │   │   │   │   │   │   │   ↳ Line 1 emitted with latency 287.5645999999979 ms
[396ms] │   │   │   │   │   │   │   │   ├── [streamEditsWithFiltering]
        │   │   │   │   │   │   │   │   │   │   ↳ Line 2 emitted with latency 288.9424999999974 ms
```
