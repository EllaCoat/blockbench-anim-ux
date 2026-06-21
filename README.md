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

### v0.4 — Multi-window sync (experimental)

Synchronize state across multiple Blockbench windows opened on the same project
(via *File > Open in New Window*). Useful in multi-monitor setups:
keep one window focused on 3D, another on the timeline, and they stay in step.

Toggles (BB *Settings > General*, each independent):

- **Sync timeline time** — playback / scrub position
- **Sync keyframe selection** — selected keyframes
- **Sync play / pause** — playback state
- **Sync outliner selection** — bone / element selection
- **Sync animation switch** — currently selected animation
- **Sync keyframe edit** *(experimental, default OFF)* — value changes via `Keyframe.prototype.set` (covers x/y/z input, Molang editor, graph drag, numeric drag; not time changes or batch-only ops)

#### Notes on multi-window

- Uses unofficial Electron IPC via `window.require('electron')` + `@electron/remote`
  (Blockbench's renderer has `nodeIntegration: true`, which makes this possible).
  Future Blockbench / Electron updates may break this path; the plugin
  falls back silently (other features stay live) when the IPC API is unavailable.
- Concurrent complex edits across windows are **not recommended**. The edit sync
  applies updates last-writer-wins with no locking. The Phase 4 toggles let you
  isolate which channels are synced if behavior gets surprising.

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
