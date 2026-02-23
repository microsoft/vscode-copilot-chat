## 2026-02-15 - [Command Injection via spawn(shell:true) on Windows]
**Vulnerability:** Found `spawn('cmd', ['/c', 'start', '""', `"${uri}"`], { shell: true })` in `src/extension/onboardDebug/node/copilotDebugWorker/open.ts`. This allows command injection if `uri` contains double quotes (e.g., `url" & calc.exe & "`).
**Learning:** `spawn` with `shell: true` on Windows is extremely dangerous when combined with manual quoting of arguments, as `cmd.exe` parsing rules are complex and easily bypassed.
**Prevention:** Avoid `shell: true` whenever possible. Use `spawn('cmd', ['/c', 'start', '""', uri], { shell: false })` (or omit `shell` option) to let Node.js handle argument escaping safely.
