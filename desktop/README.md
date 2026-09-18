# Aval Desktop

Aval Desktop is a trusted Electron shell for the hosted Aval dashboard. It starts `codex app-server` locally and exposes a deliberately narrow bridge to the renderer so interactive Ask Aval questions can use the signed-in user's ChatGPT plan.

The desktop bridge uses an app-specific Codex home, never reads another Codex installation's `auth.json`, removes API-key environment variables from the child process, keeps authentication URLs and credentials out of the renderer, and runs model turns in an empty read-only workspace with network access disabled. Cloud automations remain server-hosted because they must keep running when the laptop is closed.

## Development

Requirements: Node.js 22+, the Codex CLI, and a ChatGPT account eligible for Codex.

```sh
cd desktop
npm install
npm test
npm start
```

Set `AVAL_DESKTOP_URL=http://localhost:3000` to point the shell at a local Aval development server. Set `AVAL_CODEX_PATH=/absolute/path/to/codex` only when the CLI is not discoverable on `PATH` or in a standard install location.

## Packaging

```sh
npm run package:mac
```

For a local development installer using the already installed Electron runtime:

```sh
npm run package:mac:local
```

This local package is ad-hoc signed and is not notarized. Run the command in a
normal macOS terminal: restricted automation sessions may reject disk-image
creation with `hdiutil: create failed - Device not configured`. The packaged
`dist/mac-arm64/Aval.app` and ZIP can still be produced when DMG creation fails.
Production signing requirements remain enabled for `package:mac` and GitHub.

Desktop loads `https://app.aval.llc` by default. The release workflow waits for the
Cloudflare production workflow for the same commit to succeed before publishing
`desktop-latest`, so the released desktop wrapper and its hosted UI agree.

`npm run package:mac` is the production path and fails unless a Developer ID identity is available. The GitHub release workflow imports the signing certificate, notarizes the app and DMG with an App Store Connect API key, staples both tickets, verifies them with `codesign`, `stapler`, and Gatekeeper, and publishes SHA-256 checksums. Required repository secrets are documented in `docs/AGENT_PRODUCTION_RUNBOOK.md`.

When npm is unavailable, `npm run package:mac:offline` can create an Apple-silicon development DMG from an already-installed Electron 44 runtime. The resulting app is ad-hoc signed for local testing, not notarized for public distribution. The DMG uses the same 660×420 Aval-branded Finder layout as the normal electron-builder package, including a live `/Applications` link; eject any older Aval disk image before rebuilding.

## Local app and DMG delivery

From the repository root, run `npm run build` followed by `npm run start:local`.
The latter applies local-only migrations and keeps the scheduled import worker running.
Leave it running while using the local DMG at `http://127.0.0.1:3000`.

A local installer can bake that URL into its own package metadata:

```sh
npm run package:mac:local -- --config.extraMetadata.avalDesktopUrl=http://127.0.0.1:3000 '--config.artifactName=Aval-${version}-local-arm64.${ext}'
```

This changes only the local artifact. The default release still opens the hosted app.
Refresh the DMG when delivering application changes; do not distribute an older installer
alongside a newer local build. Local installers are ad-hoc signed and not notarized.

If port 3000 belongs to another project, run `AVAL_LOCAL_PORT=3010 npm run start:local`
and package with `--config.extraMetadata.avalDesktopUrl=http://127.0.0.1:3010`.
The September 7 harness-audit delivery uses port 3010 to preserve the active KiraLabs server.

## Chat window controls

Ask Aval uses a frosted panel with independence and workspace context in an
animated disclosure. The agent pill selects who handles both **Chat** and
**Run task**; the message-type pill selects the operation, and the arrow submits it.
Tool progress in web chat comes from existing execution events and costs no
additional model calls. Desktop ChatGPT questions show a working indicator;
agent tasks retain their server-generated plan and approval progress.

Drag the title to move the panel, release at the right edge to dock, or release
outside the page to open a separate window. The pop-out button provides the same
window action. Drag any panel edge or corner to resize; shrink vertically below
the collapse threshold to minimize. Header controls also minimize, expand, dock,
and restore. Closing the separate window returns the conversation and draft to
the dashboard. The dashboard must remain open: the separate window shares its
React state and trusted desktop bridge. Browsers may require pop-ups to be enabled.

The independence introduction is acknowledged once per user and workspace in
saved preferences. The guide remains available from the expanded controls.

In **Settings → Preferences → Chat window background**, choose **White** or
**Frosted glass**, then save. Changes preview in an already-open chat window.
White uses a light, opaque surface. On macOS, glass uses the native `under-window`
vibrancy material with a transparent renderer; browser pop-outs use a solid tint.
The preference syncs with the account's appearance settings. Existing profiles
without this preference default to White. macOS Reduce Transparency is respected.

Question progress appears above the composer as a complete, task-specific label.
It does not depend on main-window typewriter timers, which can be throttled while
the detached window is active. Tool events update that label without another
model request.
