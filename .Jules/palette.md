## 2025-05-27 - [Hidden Warning Context]
**Learning:** Found a pattern where visual "Warning" labels were hidden from screen readers (`aria-hidden="true"`), causing context loss. The warning text was decorative visually but critical semantically.
**Action:** Ensure warning labels are accessible (e.g., remove `aria-hidden`, use semantic HTML like `<strong>`, or appropriate roles) and consistently use icons with text alternatives if needed.

## 2025-05-28 - [Keyboard Accessible Code Snippets]
**Learning:** Dynamically rendered `<pre>` blocks for code snippets in webviews are not keyboard focusable by default, blocking keyboard users from scrolling long code.
**Action:** Always add `tabindex="0"` to `<pre>` or code containers in webview logic after rendering to ensure keyboard operability.
