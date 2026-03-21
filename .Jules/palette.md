## 2023-10-27 - [Avoid redundant aria-labels or titles on textual buttons]
**Learning:** Adding a title or aria-label that exactly matches the visible text of a button is redundant and can cause screen readers to announce the text twice.
**Action:** Reserve title attributes for icon-only buttons or use them to provide *additional* contextual information (e.g., "Click to insert this suggestion into your code" instead of "Accept suggestion 1").
