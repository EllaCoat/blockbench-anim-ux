# blockbench-anim-ux

Blockbench plugin: Animator panel UX improvements for animating models with many bones.

Inspired by patterns from Blender (Outliner / Dope Sheet), Spine (Skeleton tree sync),
and Adobe After Effects (Shy / property-based filtering).

## Features

### v0.7.1 — Timeline lifecycle + explicit texel UV layout

- **Single-owner Timeline window lifecycle** — pop-out state, document listeners,
  Blockbench compatibility bridges, restoration, and cleanup now share one lifecycle.
- **Narrow companion API** — `window.AnimUX.timeline.subscribeDocuments(listener)`
  immediately reports the parent / pop-out document set and follows later transitions.
  Plugins loaded before anim_ux can listen for Blockbench's `animux:ready` event.
- **Explicit Texel UV Layout** — choose one cube, one existing texture, and integer
  `{x, y, z}` texel dimensions. The action places only the cube's existing, enabled
  faces as independent physical rectangles in unused texture space. Deleted or
  disabled faces are left untouched, including their UVs and rotations. Geometry,
  bitmap content, and texture resolution remain unchanged in one Undo entry.

### v0.1 — Animator panel UX

- **A. Incremental search** — filter animator rows by name (case-insensitive partial match)
- **B. "Keyframes only" toggle** — show only animators that have keyframes in the current animation
- **C. "Only show selected" toggle** — sync the animator list to the current 3D selection
- **D. Hierarchy-preserving filter** — keep parent indentation / breadcrumbs visible when filtering
- **F. Keyframe jump shortcuts** — arrow keys jump the playhead to the next / previous keyframe of the selected animator

### v0.2 — Onion Skin + A-B loop

- **Onion Skin** — show ghost meshes of the previous / next frame (past blue, future orange) in the 3D view
- **A-B loop playback** — set A / B markers (`Alt+Shift+A` / `B`), toggle loop (`Alt+Shift+L`), clear (`Alt+Shift+X`); status shown in the filter bar

### v0.3 — Onion Skin range + A-B loop markers

- **Onion Skin Range dialog** — adjust onion skin span (±1〜5 frames) with linear distance fade; values persist in localStorage
- **A-B loop timeline markers** — vertical lines on the timeline (A green / B red), scroll & zoom aware

### v0.5 — Pop-out completeness

- **Ctrl + wheel zoom inside the pop-out** — the v0.4 limitation is gone. Wheel events
  in the child window are mirrored as `mousewheel` to the in-place handler so the
  pop-out timeline behaves identically to the docked one (zoom, vertical scroll,
  Shift-horizontal scroll all work).

### v0.4 — TIMELINE pop-out (experimental)

Detach the TIMELINE panel into a separate window so you can keep it on a
different monitor while the main editor (3D view, outliner, properties, etc.)
stays on the primary window.

- **Animation menu → Anim UX: Detach Timeline** — toggle pop-out / restore
- The pop-out window is fully interactive: playhead drag, playback (3D view
  stays in sync on the main window), keyframe click / drag, A-B loop markers,
  Onion Skin range, breadcrumb tooltips, animator search / filter toggles, and
  global shortcuts (Undo, anim_ux `Alt+Shift+...`, etc.) all work.
- Resizing the pop-out window resizes the timeline interior (header, filter
  bar, time axis, animator rows) accordingly.
- Closing the pop-out window (manual close, plugin unload, or even a crash
  fallback) automatically reattaches the TIMELINE to the main window.

#### Known limitations / notes

- **Implementation depth.** The pop-out relies on `window.open` + `adoptNode`
  + a layered set of DOM hooks (`jQuery` id selector fallback,
  `Document.prototype.getElementById` fallback, mouse / touch / keyboard event
  proxying to the parent document, and a popout-aware listener bus for
  anim_ux's own handlers). These are tied to Blockbench's current renderer
  configuration (`nodeIntegration: true`, single Electron process). A future
  Blockbench release that disables node integration or moves the renderer to
  an isolated context will most likely break this path.
- **IME / text input.** Inside the pop-out, plain keys typed while an
  `<input>` / `<textarea>` / `contenteditable` element is focused are *not*
  proxied to the main window (so they edit the text instead of firing
  shortcuts). Modifier-bearing combinations (Ctrl / Meta) that map to global
  shortcuts (Undo, Redo, Save, Copy / Paste / Cut, Select-All, Find) still
  pass through; text-editing combinations such as `Ctrl+Arrow` / `Ctrl+Home` /
  `Ctrl+Backspace` are kept inside the pop-out input so they don't accidentally
  fire a main-window shortcut. IME composition events are also suppressed so a
  Japanese / Chinese conversion-confirming Enter doesn't accidentally fire a
  global shortcut.

## Build

The repository pins pnpm and rejects newly published dependency versions for seven days.
Dependency install scripts are denied unless explicitly listed in `pnpm-workspace.yaml`;
currently only `esbuild` is allowed.

```bash
pnpm install
pnpm build       # production build (minified)
pnpm dev         # dev build with inline sourcemap
```

Output: `dist/anim_ux.js`

## Tests

Run `pnpm test` with Node.js 24 or later. The shared wrapper builds the test
modules and runs Node's standard test runner. To select files, use
`pnpm test test/explicitTexelLayout.test.mjs`.

Successful runs print the selected scope, aggregate counts, and exit result.
Failures include assertion or loading diagnostics; lengthy output is bounded
and the complete log path is printed. Build errors prevent the tests from
starting. Empty runs, test timeouts, and abnormal exits fail the command.
The build and test processes have 60-second and 120-second limits, respectively;
individual tests have a 30-second default timeout. Logs remain in the OS
temporary directory for inspection.

## Compatibility

- Designed for general Blockbench projects. No project-format gate, so it activates on any
  project that has an animator panel.
- Tested primarily with [AnimatedJava](https://animated-java.dev/) workflows. AJ extended
  animator types (`NullObject`, `Locator`, `VanillaItemDisplay`) are treated as standard
  `BoneAnimator` subclasses and supported transparently.

## License

[MIT](./LICENSE)
