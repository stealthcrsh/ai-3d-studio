# UX Research: Workspace Patterns and Screen Spec (2026-11-05)

## 1. Reference workspaces
- **CLO3D**: 3D window plus 2D pattern window, Object Browser, context-sensitive Property Editor. [CLO](https://support.clo3d.com/hc/en-us/articles/115004877468)
- **Marvelous Designer**: same model; Object Browser lists scene items in creation order. [OB](https://support.marvelousdesigner.com/hc/en-us/articles/47358171722265-Object-Browser-Ver-2025-0), [PE](https://support.marvelousdesigner.com/hc/en-us/articles/47358318005913-Property-Editor)
- **Blender**: workspaces are task layouts; default Viewport, Outliner, Properties, Timeline. [Manual](https://docs.blender.org/manual/en/3.3/interface/window_system/workspaces.html)
- **Meshy**: untextured preview first, user chooses to refine. [Docs](https://docs.meshy.ai/text-to-3d)
- **Tripo**: draft, refine, texture, retopology. Secondary sources only; no official docs found. [Source](https://www.cutout.pro/learn/?p=2008)
- **Spline**: Agent/Objects/Assets sidebar, central viewport, right property panels. [Docs](https://docs.spline.design/basics/understanding-splines-ui)

**Adopted**: one persistent viewport; left structure tree, right contextual inspector, bottom timeline; user-gated generation stages; chat as peer of sliders.

## 2. Screen inventory
States: **E** empty, **L** loading, **F** failed, **P** paused, **I** interrupted, **Pa** partial, **S** success, **O** offline, **X** inaccessible.

- **S01 Library**: E (no garments), L, F, O (cached, read-only), X (revoked share), S.
- **S02 Import**: E (dropzone), L (bytes sent), P (user pause), I (tab closed, resumable), Pa (some files rejected), F (corrupt/unsupported), O, X, S.
- **S03 Setup**: L (analysing), Pa (low-confidence parts flagged), F, X, S (geometry confirmed).
- **S04 Studio viewport**: L, Pa (coarse mesh, refining), P, I (job lost, resume), F, O, S.
- **S05 Inspector**: E (nothing selected), Pa (params locked while refining), X (read-only), S.
- **S06 Timeline**: E (no clip), L (simulating), P, I, F (solver diverged), Pa (cached to frame N), S.
- **S07 Quality review**: E (checks not run), L, Pa (some skipped), F, S (pass/warn/fail list).
- **S08 Export**: E, L, P, I, F, O, X (permission), S.

## 3. Reference journey
1. **S02** Upload hoodie. Real byte progress; pausable, resumable.
2. **S03** Inspect inferred geometry (panels, seams, scale). Each item has a confidence label; user confirms or corrects.
3. **S03 to S04** Generate. Queued, then actual stage name ("Building coarse mesh").
4. **S04** Orbit coarse mesh during refinement. Badge "Coarse, refining"; orbit never blocked; finer mesh swaps in at idle.
5. **S04/S05** Inspect seams: tree toggle highlights and focuses a seam; list mirrors canvas.
6. **S06** Simulate walking. Cached-frame count grows; scrub only cached frames.
7. **S05** Edit sleeve by chat ("shorten sleeve 2 cm") or slider. Chat proposes a diff, user applies; both write the same parameter.
8. **S04** Compare: A/B toggle or split, plus numeric diff list.
9. **S07** Check: measured values with units; unrun checks read "Not run".
10. **S08** Export: summary first; "ready" only once the file exists.

## 4. Keyboard and non-canvas alternatives
Every viewport action has a panel control and a shortcut. Canvas is `role="application"` with a live-region announcer.

- Orbit/pan/zoom: Arrows / Shift+Arrows / +/-; camera panel with numeric angles and preset views.
- Reset/frame: Home / F; buttons.
- Select seam or panel: Tab and Enter in structure tree (listbox).
- Isolate/hide: I / H; tree row toggles.
- Play/step: Space / comma, period; transport and frame field.
- Edit parameter: Enter, arrows nudge; slider with numeric input.
- Compare: C; A/B toggle.
- Cancel job: Esc with confirm; Cancel button.

Focus ring always visible; `?` lists shortcuts, remappable.

## 5. Reduced motion
Honour `prefers-reduced-motion` plus an in-app toggle. Disable camera easing (cut to preset), auto-rotate, shimmer and parallax. Simulation playback defaults to paused/stepped. Replace crossfades with instant swap and text badge. Progress is static text and bars.

## 6. Truthful progress
- **Determinate** only for measurable units (bytes, frames cached N of total); show units, not a bare percentage.
- **Indeterminate**: stage name, elapsed time, queue position if the server supplies it. No fake percentage, no looping ETA, never advance on a timer.
- Partial results labelled "Coarse, not final"; never exportable as final.
- Failures state stage, cause if known, and recovery (retry, resume, discard).
- Offline: show last-synced time; queue edits only if the queue is real.
- Interrupted: "Last confirmed update 14:02" with resume; never assume completion.
