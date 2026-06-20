# blockbench-anim-ux

Blockbench plugin: Animator panel UX improvements for animating models with many bones.

Inspired by patterns from Blender (Outliner / Dope Sheet), Spine (Skeleton tree sync),
and Adobe After Effects (Shy / property-based filtering).

## Features (v0.1)

- **A. Incremental search** — filter animator rows by name (case-insensitive partial match)
- **B. "Keyframes only" toggle** — show only animators that have keyframes in the current animation
- **C. "Only show selected" toggle** — sync the animator list to the current 3D selection
- **D. Hierarchy-preserving filter** — keep parent indentation / breadcrumbs visible when filtering
- **F. Keyframe jump shortcuts** — arrow keys jump the playhead to the next / previous keyframe of the selected animator

## Build

```bash
npm install
npm run build       # production build (minified)
npm run dev         # dev build with inline sourcemap
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
