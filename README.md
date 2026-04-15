# Sidecar for VS Code's GitHub Copilot

**Dispatch into VS Code's Copilot Chat from your phone, from anywhere**

> prototype; this is an early-stage experiment. It works, but expect rough edges. PRs are very welcome.

*Sidecar* is a lightweight orchestration layer for mobile access to your active Copilot Chat workflow. It lets a phone sync with and interact with the same chat session that is open on desktop, without adding relay infrastructure or installing a native phone app.

## Why this exists

Primarily because I like VS Code and don't use Claude Code - the former fits my workflow well, and I like the flexibilty Copilot provides whereby I can swap models on the fly.

Actual features of sidear:
- **Resume desktop context, not just repo context**
   Continue the exact repo/branch/chat thread already running in your desktop editor.
- **Work with local-first state**
   Interact with unpushed changes, local files, and the real host machine state.
- **Phone-first access to your IDE**
   Open from a QR pairing flow and use a touch-optimised UI.
- **Faster pick-up flow**
   Useful for quickly continuing one thread, answering a follow-up, or checking progress while you're grabbing lunch and left your Copilot running.

## Quickstart: Install as a VSIX

If you just want to run Sidecar without setting up the full dev environment, you can package and install it as a `.vsix`:

1. Install dependencies:

   ```
   npm ci
   ```

2. Disable the official `Github Copilot Chat` extension

2. Run the VS Code task **Package & Install VSIX** (Terminal → Run Task), or run it manually:

   ```
   npm run compile && npx vsce package --out copilot-chat-sidecar.vsix --allow-package-secrets sendgrid
   ```

   Then install:

   ```
   code-insiders --install-extension copilot-chat-sidecar.vsix --force
   # or: code --install-extension copilot-chat-sidecar.vsix --force
   ```

3. Reload VS Code and re-enable the `Github Copilot Chat` - this over-rides it. The Sidecar extension is now installed - **click the "Sidecar" panel at the bottom-right-hand-corner of your VS Code window** to launch.

4. Accept the default URL (`https://davidobot.net/vscode-copilot-chat-sidecar/`) unless you're self-hosting; this is just the visual layer

## Development

### Sidecar architecture

- The extension starts a local HTTP + WebSocket bridge server on localhost.
- Sidecar bootstraps Dev Tunnels directly by running `devtunnel host -p <port> --allow-anonymous` and using the resulting `*.devtunnels.ms` endpoint.
- If direct devtunnel bootstrap is unavailable or fails, Sidecar prompts you to [install it](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started).
- A QR code in VS Code opens the PWA with a signed pairing URL (`ws` + session `token`).
- The phone PWA syncs conversation list, history, and streaming assistant chunks.
- Prompts sent from the phone are forwarded back into Copilot Chat on desktop.
- The status bar entry is `Sidecar` on the **bottom-right-hand-corner** of your window:
   - Disconnected state shows a disconnect icon.
   - Clicking `Sidecar` starts the bridge and then opens the pairing panel.

### PWA deployment

The `pwa/` directory is a static web app designed for GitHub Pages deployment. This repository includes `.github/workflows/deploy-pwa.yml`, which deploys `pwa/` to Pages on pushes to `main`.

Use my deployed Github pages URL (`https://davidobot.net/vscode-copilot-chat-sidecar/`) in the Sidecar panel when generating pairing QR codes, or deploy your own.

### Local PWA dev server

You can test without deploying GitHub Pages.

1. Start the local PWA server:

   ```
   npm run pwa:dev
   ```

   (or run the VS Code task `PWA: Dev Server`)

2. Point Sidecar to your local PWA URL:

   - For phone testing on same Wi-Fi: `http://<your-lan-ip>:4173/`
   - For desktop-only testing: `http://localhost:4173/`

3. Optional override: set `COPILOT_PWA_DEV_URL` before launching the extension host.

   - Example: `COPILOT_PWA_DEV_URL=http://<your-lan-ip>:4173/`
   - Sidecar prefers this env value over saved settings.

### Run and test locally

1. Install dependencies in the repo root:

   ```
   npm ci
   ```

2. Build and launch the extension host (VS Code task):

   ```
   Compile & Launch Extension Host
   ```

   The task prefers VS Code Insiders. If `code-insiders` is not installed, it falls back to `code` with `--enable-proposed-api github.copilot-chat`.

3. In the Extension Development Host window:

   - Disable the official GitHub Copilot Chat extension to avoid conflicts.
   - Sign in to GitHub Copilot.
   - Install [Azure Dev Tunnels CLI](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started) and sign in for direct tunnel bootstrap:
   - Open a workspace and open the Chat view.

4. In the status bar, confirm Sidecar starts in disconnected state (`$(debug-disconnect) Sidecar`).

5. Click `Sidecar` to start the bridge and open the pairing panel.

6. Set a PWA URL:
   - Default hosted URL: https://davidobot.net/vscode-copilot-chat-sidecar/
   - Local dev URL: `http://0.0.0.0:4173/`

7. Scan the QR code from your phone and open the PWA.

8. Validate bidirectional sync:
   - Send a desktop chat prompt and confirm it appears on phone.
   - Send a phone prompt and confirm it appears in desktop chat.
   - Confirm assistant streaming chunks render live on phone.
   - Confirm status bar item updates from disconnected yellow to active Sidecar after startup.
   - Confirm the Sidecar panel shows a non-loopback bridge endpoint (if it shows a loopback warning, phone pairing will fail).

9. Validate reconnect behavior:
   - Disconnect/reconnect phone network.
   - Confirm status changes to reconnecting, then connected, and conversation list refreshes.

10. If pairing fails:
   - Verify `devtunnel` CLI is installed and signed in.
   - Regenerate token from the Sidecar panel and rescan.
   - Reopen the Sidecar panel to refresh the pairing URL.

## Original Repo

This is just a fork. The original repo can be found [here](https://github.com/microsoft/vscode-copilot-chat/).

## License

Original repo licensed under the [MIT](LICENSE.txt) license.

New changes in this fork are also licensed under the [MIT](LICENSE.txt) license.
