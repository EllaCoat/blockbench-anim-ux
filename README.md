# blockbench-anim-ux

Blockbench plugin: Animator panel UX improvements for animating models with many bones.

Inspired by patterns from Blender (Outliner / Dope Sheet), Spine (Skeleton tree sync),
and Adobe After Effects (Shy / property-based filtering).

## Features

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
- **Ctrl + wheel zoom** on the timeline is not currently supported inside the
  pop-out window. (Blockbench distinguishes a pinch-zoom gesture from a real
  Ctrl-hold by checking `Pressing.ctrl`, which the proxied key events flip
  early. Working around it cleanly is on the wishlist; see the PR description.)
- **IME / text input.** Inside the pop-out, plain keys typed while an
  `<input>` / `<textarea>` / `contenteditable` element is focused are *not*
  proxied to the main window (so they edit the text instead of firing
  shortcuts). Modifier-bearing combinations (Ctrl / Meta) still pass through,
  so Undo etc. work. IME composition events are also suppressed so a
  Japanese / Chinese conversion-confirming Enter doesn't accidentally fire a
  global shortcut.

## Build

```bash
pnpm install
pnpm build       # production build (minified)
pnpm dev         # dev build with inline sourcemap
```

Output: `dist/anim_ux.js`

## Compatibility

- Designed for general Blockbench projects. No project-format gate, so it activates on any
  project that has an animator panel.
- Tested primarily with [AnimatedJava](https://animated-java.dev/) workflows. AJ extended
  animator types (`NullObject`, `Locator`, `VanillaItemDisplay`) are treated as standard
  `BoneAnimator` subclasses and supported transparently.

## License

[MIT](./LICENSE)
