## 2025-05-27 - [Hidden Warning Context]
**Learning:** Found a pattern where visual "Warning" labels were hidden from screen readers (`aria-hidden="true"`), causing context loss. The warning text was decorative visually but critical semantically.
**Action:** Ensure warning labels are accessible (e.g., remove `aria-hidden`, use semantic HTML like `<strong>`, or appropriate roles) and consistently use icons with text alternatives if needed.

## 2025-05-27 - [Hidden Decorative Icons]
**Learning:** Decorative icons (like `&#9888;` warning sign) can cause redundant screen reader announcements (e.g., "Warning sign Warning") if not hidden.
**Action:** Wrap decorative icons in `<span aria-hidden="true">` to hide them from assistive technology while keeping the semantic text visible.
## 2026-02-28 - [Webview loading a11y]
**Learning:** Dynamically rendered containers like `solutionsContainer` in webviews can disorient screen reader users if content is swapped out silently during loading.
**Action:** Always toggle `aria-busy="true"` on the container while async updates are happening and set it to `false` when done.
