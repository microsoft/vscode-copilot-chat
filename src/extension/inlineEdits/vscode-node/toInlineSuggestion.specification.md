# `toInlineSuggestion` Specification

## Purpose

`toInlineSuggestion` determines whether a proposed text edit can be rendered as an **inline suggestion** (ghost text) in VS Code. If it can, the function returns an adjusted `{ range, newText }` whose range touches the cursor position — a requirement for VS Code's ghost text renderer. If the edit cannot be shown as ghost text, it returns `undefined`.

## Signature

```ts
function toInlineSuggestion(
  cursorPos: Position,
  doc: TextDocument,
  range: Range,
  newText: string,
  advanced?: boolean       // default: true
): InlineSuggestionEdit | undefined
```

## Key Invariant

The returned `{ range, newText }` always produces the **same document result** as the original `{ range, newText }` input. The function only adjusts the range/text boundaries so the range starts at the cursor — it never changes the semantic meaning of the edit.

## Decision Branches

The function evaluates three branches in order. The first match wins.

---

### Branch 1 — Next-Line Insertion

**When:** The edit is a pure insertion (`range.isEmpty`) on the line immediately below the cursor (`cursorPos.line + 1 === range.start.line`), the cursor is at the end of its line, the range starts at column 0, and the new text spans multiple lines.

**Additional constraint on `newText`:**
- Either `newText` ends with `'\n'`, **or**
- `newText` contains `'\n'` and the target line has no remaining content after the insertion point (i.e. range.end is at end of the line).

**Result:** Returns an empty range at the cursor position with the newline between cursor and original range prepended to `newText`.

**Rejects when:**
- Cursor is not at end of line
- Range is not empty
- Range is not on the immediately next line
- Range does not start at column 0
- `newText` is single-line (no `'\n'`)
- `newText` doesn't end with `'\n'` and the target line already has content

#### Examples

**Accepted:** Insert new lines after a function signature.
```
Document:       "function foo(\n\nother"
Cursor:         (0, 13)           — end of "function foo("
Range:          (1, 0)-(1, 0)     — empty range on empty line
newText:        "  a: string,\n  b: number\n)"

Result.range:   (0, 13)-(0, 13)   — empty range at cursor
Result.newText: "\n  a: string,\n  b: number\n)"
```

**Rejected:** Single-line text without `\n`.
```
Document:       "function foo(\n\nother"
Cursor:         (0, 13)
Range:          (1, 0)-(1, 0)
newText:        "  a: string"

Result:         undefined          — no newline in newText
```

**Rejected:** Cursor not at end of line.
```
Document:       "function foo(bar\n\nother"
Cursor:         (0, 8)            — middle of line
Range:          (1, 0)-(1, 0)
newText:        "  param1,\n  param2\n"

Result:         undefined
```

---

### Branch 2 — Multi-Line Prefix Stripping (advanced mode only)

**When:** `advanced` is true and the range spans multiple lines.

Computes the longest common prefix between the replaced text and `newText`, finds the last newline within it, and strips everything up to and including that newline from both the range start and `newText`. This can reduce a multi-line range down to a single-line range on the cursor's line, which then falls through to Branch 3.

**Rejects when:**
- No newline exists in the common prefix (nothing to strip)
- After stripping, the range still spans multiple lines
- After stripping, the range is on a different line from the cursor

#### Examples

**Accepted:** Multi-line range reduced to single line.
```
Document:       "abc\ndef\nother"
Cursor:         (1, 0)
Range:          (0, 0)-(1, 3)    — spans 2 lines, replaced = "abc\ndef"
newText:        "abc\ndefghi"

Prefix:         "abc\ndef" common with "abc\ndefghi" up to index 7
Last newline:   index 3 → strip "abc\n"
Reduced range:  (1, 0)-(1, 3)
Reduced text:   "defghi"

→ Falls through to Branch 3, succeeds
Result.range:   (1, 0)-(1, 3)
Result.newText: "defghi"
```

**Rejected:** After stripping, still multi-line.
```
Document:       "a\nb\nc\nother"
Cursor:         (1, 0)
Range:          (0, 0)-(2, 1)    — replaced = "a\nb\nc"
newText:        "a\nB\nC"

Prefix:         "a\n" → strip "a\n"
Reduced range:  (1, 0)-(2, 1)   — still multi-line

Result:         undefined
```

---

### Branch 3 — Same-Line Edit

**When:** After any prefix stripping, the range is entirely on a single line that matches the cursor's line.

**Checks (in order):**

1. **Cursor within range:** `cursorOffset >= rangeStartOffset`. If cursor is before the range start → reject.

2. **Text before cursor matches:** The portion of `replacedText` before the cursor equals the same-length portion of `newText`. If they differ → reject.

3. **Subword check:** The full `replacedText` must be a subsequence (subword) of `newText`. This ensures ghost text can interleave the new characters around the existing ones. If not → reject.

4. **Prefix trimming:** If the cursor is past the range start (common prefix exists), the range start is moved to the cursor position and the corresponding prefix is stripped from `newText`. This ensures the ghost text range starts exactly at the cursor.

#### Examples

**Accepted:** Cursor at end of replaced text, common prefix trimmed.
```
Document:       "\t/**\n\t * \n\t */\n\tprivate ..."
Cursor:         (1, 4)           — end of "\t * "
Range:          (1, 0)-(1, 4)    — covers "\t * "
newText:        "\t * The order of the subsequent edit"

replacedText:   "\t * "
Prefix match:   "\t * " === "\t * " ✓
Subword:        "\t * " is subword of "\t * The order..." ✓
Trim 4 chars:   range → (1, 4)-(1, 4), newText → "The order of the subsequent edit"

Result.range:   (1, 4)-(1, 4)
Result.newText: "The order of the subsequent edit"
```

**Accepted:** Cursor at start of range, no trimming needed.
```
Document:       "hello"
Cursor:         (0, 0)
Range:          (0, 0)-(0, 5)
newText:        "hello world"

Subword:        "hello" is subword of "hello world" ✓
No prefix to trim (cursor at range start)

Result.range:   (0, 0)-(0, 5)
Result.newText: "hello world"
```

**Accepted:** Subword expansion mid-word with prefix trimming.
```
Document:       "clog"
Cursor:         (0, 1)
Range:          (0, 0)-(0, 4)
newText:        "console.log"

replacedText:   "clog"
Prefix match:   "c" === "c" ✓
Subword:        "clog" is subword of "console.log" ✓ (c→o→l→og)
Trim 1 char:    range → (0, 1)-(0, 4), newText → "onsole.log"

Result.range:   (0, 1)-(0, 4)
Result.newText: "onsole.log"
```

**Rejected:** Cursor before range.
```
Document:       "abcdef"
Cursor:         (0, 1)
Range:          (0, 3)-(0, 6)

cursorOffsetInReplacedText = 1 - 3 = -2 < 0

Result:         undefined
```

**Rejected:** Text before cursor differs.
```
Document:       "abcdef"
Cursor:         (0, 4)
Range:          (0, 0)-(0, 6)
newText:        "XXXX_modified"

replaced[0..4]: "abcd" ≠ "XXXX"

Result:         undefined
```

**Rejected:** Replaced text is not a subword of newText.
```
Document:       "abcxyz"
Cursor:         (0, 0)
Range:          (0, 0)-(0, 6)
newText:        "abc"

Subword:        "abcxyz" is NOT a subword of "abc" ✗

Result:         undefined
```

---

## `isSubword` Helper

`isSubword(a, b)` returns `true` if every character of `a` appears in `b` in the same order, possibly with gaps. It is used to verify that the existing text can be "expanded" into the new text without reordering.

```
isSubword("clog", "console.log") → true    (c...o...l...og)
isSubword("abc",  "abc")         → true
isSubword("abcxyz", "abc")       → false   (xyz not found)
isSubword("", "anything")        → true
isSubword("a", "")               → false
```

## Summary of Rejection Reasons

| Reason | Branch |
|---|---|
| Range not on cursor's line and not a next-line insertion | 1, 3 |
| Cursor not at end of line (next-line insertion) | 1 |
| Range not empty (next-line insertion) | 1 |
| Range not at column 0 on next line | 1 |
| `newText` has no newline (next-line insertion) | 1 |
| `newText` doesn't end with `\n` and target line has content | 1 |
| Multi-line range with no common-prefix newline to strip | 2 |
| Still multi-line after prefix stripping | 2 |
| Cursor before range start | 3 |
| Text before cursor differs between old and new | 3 |
| Replaced text is not a subword of `newText` | 3 |
