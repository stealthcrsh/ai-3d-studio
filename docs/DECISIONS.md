# Decision register and architecture record

2026-11-05. Research reports in [research/](research) are findings, not proof. Only the tests in [QUALITY.md](QUALITY.md) count as proof.

## Decision register

| # | Decision | Status | Needs approval | Risk | Evidence |
|---|---|---|---|---|---|
| 1 | Runs fully in the browser with no server | **CONFIRMED**, owner 2026-11-05 | No | Device limits compute. Heavy AI models cannot run here | Full flow run in browser, [QUALITY.md](QUALITY.md) |
| 2 | Do not download or require Blender | **CONFIRMED**, owner 2026-11-05 | No | The brief's Blender gate stays unmet | See decision 3 |
| 3 | Do not fake a `.blend`. Offer validated GLB plus a script | PROPOSED DEFAULT | **Yes** | Blender import unverified | Only Blender writes a genuine file. A hand-written one could not be checked here |
| 4 | Hoodie first, labelled DEMO BASELINE | CONFIRMED scope, PROPOSED label | No | Users may expect AI | Label shown on every version and written into every GLB |
| 5 | Pattern panels plus drape, not surface reconstruction | PROPOSED DEFAULT | No | Output is limited to what the template can express | `research/3d-ml.md`: surface tools give a baked shell with no seams. Edit locality tests pass |
| 6 | Classical silhouette fit as first provider | PROPOSED DEFAULT | No | Untested on real photos | Recovers synthetic proportions within 10%, `tests/vision.test.ts` |
| 7 | XPBD solver with analytic capsule colliders | PROPOSED DEFAULT | No | Particle self-collision can miss thin layers | Stress matrix stable, `reports/benchmark.json` |
| 8 | Baked playback, not live simulation | PROPOSED DEFAULT | No | Motion changes need a re-bake, about 4 s | Bake measured in browser |
| 9 | Procedural mannequin and clips | PROPOSED DEFAULT | No | Motion is less natural than mocap | `research/garment-physics.md`: avoids SMPL and Mixamo licence questions |
| 10 | Rule-based edit commands | PROPOSED DEFAULT | **Yes, to add an AI model** | Limited vocabulary | No credentials exist. Refusal tests pass |
| 11 | React, three.js, Vite, TypeScript | PROPOSED DEFAULT | No | None significant | Builds and runs |
| 12 | three.js directly, not React Three Fiber | PROPOSED DEFAULT | No | Slightly more code | Viewport needs direct control of mesh buffers |
| 13 | IndexedDB as project storage | PROPOSED DEFAULT | No | Clearing site data deletes projects | Atomic stage writes tested |
| 14 | Each stage in its own Web Worker | PROPOSED DEFAULT | No | Small startup cost per stage | Cancel stopped a running solver in 6 ms |
| 15 | GLB and OBJ only. No FBX or USD | PROPOSED DEFAULT | No | Some pipelines need them | Nothing is offered untested |
| 16 | Quality thresholds | **NEEDS APPROVAL** | **Yes** | Could be too lax or too strict | Uncalibrated, labelled PROPOSED in the UI |
| 17 | Publish as a private Claude Artifact | PROPOSED DEFAULT | No, private | Not tested in the hosted frame | Owner can share or delete it |
| 18 | Which business owns this product | **NEEDS APPROVAL** | **Yes** | Must stay separate from Blue Tower and CRSH | Not stated in the brief. Stored under `Projects/Claude` |

## Architecture record

### Context

The brief suggested Python, a queue, PostgreSQL and Blender workers. The owner then required the product to work fully in the browser. That rules out any server and any native dependency for the first release.

### Decision

All product logic is platform-neutral TypeScript, split into three layers:

- `src/core`: pure geometry, physics, file writers and analysis.
- `src/engine`: projects, jobs, stages, validators and the provider contract. It depends only on `Storage`, `StageRunner` and `ImageCodec` interfaces.
- `src/web`: the UI, plus browser implementations of those interfaces.

The test suite runs the same engine with stand-in implementations, so failure handling can be tested without a browser.

### Alternatives rejected

| Alternative | Why not |
|---|---|
| Keep the Bun server built first | The owner requires browser-only. The server was removed, and its logic moved to `src/engine` |
| Blender compiled to WebAssembly | No official build found. The research did not establish that one exists |
| Hand-written `.blend` writer | Could not be verified without Blender, and could silently break on a Blender update |
| Surface reconstruction first | Needs a remote GPU. Produces a shell with no editable seams |
| Reduced simulation on the page thread | Would freeze the UI and could not be cancelled mid-solve |

### Reconciled disagreements between specialists

- **Backend versus platform requirement:** the backend review assumed Bun Workers and subprocesses. Browser Workers do not have Bun's termination limit, so `terminate()` gives real cancellation.
- **Physics values:** research recommended dihedral bending. This build uses a simpler distance-based bend with values tuned by eye, which needs higher compliance numbers. Values are labelled approximate in the UI.
- **Formats:** research favoured a real `.blend` round trip. The owner's browser-only decision overrides it, and the gap is reported.
- **Product scope:** research proposed five edit verbs and a Chrome-only target. This build has more verbs, and browser support beyond the tested pane is unverified.
