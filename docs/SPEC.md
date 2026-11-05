# Product specification

Version 0.1, 2026-11-05. **Confirmed** means the owner stated it. **Assumed** means it is a proposed default.

## Purpose

Make 3D creation faster, cheaper and easier without losing professional usefulness. Output must be real, editable and exportable, not a picture of 3D.

## Confirmed by the owner

- Audience is everyone, from beginners to professional artists, designers, architects, game developers and product makers.
- The first benchmark is image-to-3D clothing, with an oversized hoodie as the example.
- Users need one-click generation, conversational edits and manual controls.
- Generation is progressive: coarse preview first, then refine.
- Hidden geometry, measurements and material physics are uncertain, must be labelled, and must never be called verified.
- No paid compute or public deployment without approval.
- **The product must work fully in the browser, and Blender is not to be downloaded (2026-11-05).**

## Assumed

- The first release supports hoodies only, on three procedural body shapes and four procedural motions.
- All work happens on the user's device. Accounts, sharing and cloud sync are out of scope for now.
- A plain background is the expected input. Real-photo accuracy is unknown.

## First-release journey

1. Add a hoodie front image, optionally a back image and measurements.
2. See measured, inferred and assumed values, each labelled.
3. Generate. A coarse draped mesh appears in under a second, and the user can orbit it during refinement.
4. Inspect parts, seams, pattern, material, stretch and contact.
5. Bake and scrub cloth motion on a walking avatar.
6. Change sleeve length by command or slider. See the affected parts first. The edit becomes a new version.
7. Compare with references, read the checks, restore or approve.
8. Export GLB or OBJ with a validation report.

The brief's final step, reopening a Blender project, is **not met**. See [DECISIONS.md](DECISIONS.md).

## Capabilities

| Capability | State |
|---|---|
| Hoodie from front and back images | Available, DEMO BASELINE |
| Hoodie with no image | Available, plain template |
| Editable dimensions, fabric, colour, pocket, cords | Available |
| Rule-based edit commands, scoped and previewed | Available |
| Undo through versions, restore, approval | Available |
| Avatar fit on 3 body shapes, pinning | Available |
| Cloth: gravity, stretch, bend, collision, particle self-collision | Available |
| Motion: walk, jog, arm lift, idle, baked | Available |
| GLB and OBJ export with validation | Available |
| Quality checks and outline comparison | Available |
| Real-photo accuracy | Partial, untested |
| Flat pattern view | Partial, for inspection, not for manufacture |
| "For Blender" package | Partial, script untested |
| AI reconstruction and language-model edits | Planned, contract only |
| Other garments | Planned |
| Video, CAD, blueprint and existing model as inputs | Planned, stored only |
| Real `.blend` from the browser | Unsupported |
| FBX, USD | Planned, untested and not offered |
| Products, vehicles, architecture, environments | Planned, none started |
| Live in-browser cloth simulation during playback | Unsupported, playback is baked |

## Measures of success

Thresholds are **PROPOSED** and await owner approval. Current results are in [QUALITY.md](QUALITY.md).

| Measure | Proposed | Measured, Standard quality in browser |
|---|---|---|
| Time to first viewable mesh | Under 2 s | 0.46 s |
| Time to refined asset | Under 30 s | 6.0 s |
| Total with walk bake | Under 60 s | 10.0 s |
| Fabric stretch, 99th percentile | Pass ≤ 10%, warn ≤ 25% | 13.5 to 14.8%, a warning |
| Vertices inside the avatar | Pass ≤ 1% | 0% |
| GLB validator errors | 0 | 0 |
