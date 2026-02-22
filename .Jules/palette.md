## 2025-05-27 - [Hidden Warning Context]
**Learning:** Found a pattern where visual "Warning" labels were hidden from screen readers (`aria-hidden="true"`), causing context loss. The warning text was decorative visually but critical semantically.
**Action:** Ensure warning labels are accessible (e.g., remove `aria-hidden`, use semantic HTML like `<strong>`, or appropriate roles) and consistently use icons with text alternatives if needed.
