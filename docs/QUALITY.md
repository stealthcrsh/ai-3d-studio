# Quality evidence

2026-11-05. Hardware: Apple M6, 12 cores, 16 GB RAM. All thresholds are **PROPOSED**. All fixtures are synthetic, so nothing here proves accuracy on real photographs.

## Automated tests

`bun run test`: **58 pass, 0 fail.** They run the same engine as the browser, with stand-ins for IndexedDB, Workers and canvas.

## Real browser run

Chromium-based browser pane in the Claude desktop app, against the built static site at a local address. **The pane was hidden and throttled for most of the run, so frame rates and playback speed were not validly measured.**

| Quality | Cloth vertices | First mesh | Refined | Total with walk | Checks |
|---|---|---|---|---|---|
| Preview | about 1,100 | 0.47 s | 1.3 s | 1.6 s | 17 pass, 2 warn, 0 fail |
| Standard | about 4,900 | 0.46 s | 6.0 s | 10.0 s | 17 pass, 2 warn, 0 fail |
| High | about 11,000 | 0.46 s | 17.4 s | 29.8 s | 16 pass, 3 warn, 0 fail |

| Scenario | Result |
|---|---|
| Fake, empty, truncated and WebP uploads | All 4 rejected with clear messages. No reference added. WebP was accepted from 2026-11-06, see below |
| Still WebP product photos, front and back, 2026-11-06 | Both accepted and measured, arms-down warning shown, hoodie generated with front print projected. No console errors |
| Cancel a running solver | Worker terminated. Job cancelled in 6 ms. No partial output |
| Retry after cancel | Completed. Earlier stages reused |
| Reload the page mid-solve | Job shown as interrupted. Resume completed in 10.6 s and reused 2 stages |
| Orbit while refining | Draft visible from about 0.75 s. Camera moved throughout |
| Edit "make the sleeves 3 cm shorter" | Showed 4 affected parts first. New version. Locality check passed |
| Walk: load, play, pause, scrub | Frame counter advanced. Scrub landed on the expected frame. Mid-stride inspected |
| GLB, OBJ and Blender package export in the browser | Completed in 0.1 to 0.5 s |
| Khronos validator running in a Worker | Ran, 0 errors, 13 warnings |
| Keyboard | Orbit, zoom, front view and reset work. Hide, isolate and select work |
| Phone width, 390 px | No horizontal overflow. Layout stacks |
| Network | All resource requests stayed on the app's own origin |
| Console | No errors in final runs |

Hosted Artifact frame: the owner confirmed on 2026-11-05 that the link opens and generates the sample hoodie. No measurements were taken there.

Not exercised: download buttons in a browser, reduced-motion mode, screen readers, Safari, Firefox, Windows, and weak or integrated GPUs.

## Benchmark set

| Fixture | Expected | Result |
|---|---|---|
| Single front hoodie | Back and hood marked inferred | Pass |
| Front and back hoodie | Each image projected onto its panel | Pass |
| Patterned garment | Outline still found | Pass, after fixing a segmentation bug this fixture exposed |
| Chest print | Print projected onto the front | Measurement tested. Print appearance not visually inspected |
| Contradictory front and back | Warns about proportions and colour | Pass |
| No hood | Reported, not invented | Pass |
| Busy background | Lower confidence, warning | Pass |
| Blank image | No garment found | Pass |
| Corrupt, fake, oversized header | Rejected | Pass |
| Unavailable AI provider | Falls back, says so, keeps the baseline label | Pass |
| Interrupted run | Resumes | Pass |
| Failed storage write | Job fails with the message and leaves no partial output | Pass |
| Large asset | Limits enforced in code | Only the header check tested, not a 30 MB file |
| Real photographs | Unknown | **Not tested. No consented photo set exists** |

## Measurement accuracy, synthetic images only

Width-to-length and sleeve-to-length ratios recover within the test tolerance of 10% and 15%. For example, 0.957 was measured against a true 0.92. Absolute size cannot come from one image, and the UI says so.

Outline overlap between the sample image and the static render is **56%**. The image is a flat lay and the render is worn, so this is expected and is not a geometry score. The app says the same. Pixel or outline similarity is not proof of 3D accuracy.

## Stress matrix

From `reports/benchmark.json`, Preview quality. Stretch is the 99th percentile on the worst frame.

| Body | Motion | Fabric | Stretch | Inside body | Deepest | Peak speed |
|---|---|---|---|---|---|---|
| Slim | Walk | Fleece | 23% | 0% | 0 mm | 2.6 m/s |
| Regular | Walk | Fleece | 25% | 0% | 2.3 mm | 2.6 m/s |
| Regular | Walk | Jersey | 20% | 0.09% | 6.7 mm | 2.6 m/s |
| Regular | Walk | Denim | 33% | 0.09% | 5.5 mm | 6.3 m/s |
| Regular | Walk | Nylon | 13% | 0.09% | 12.6 mm | 2.1 m/s |
| Regular | Jog | Fleece | 30% | 0.09% | 7.8 mm | 8.0 m/s |
| Regular | Arm lift | Fleece | 28% | 0.09% | 6.5 mm | 2.4 m/s |
| Broad | Walk | Fleece | 44% | 0.63% | 20.1 mm | 2.8 m/s |
| Broad | Jog | Fleece | 25% | 0.36% | 17.3 mm | 6.2 m/s |

No run diverged, and the same seed reproduces byte for byte. **The default hoodie is tight on the broad body**, which shows up as higher stretch and deeper contact.

## Format reports

Example files and machine-readable reports are in [`examples/`](../examples).

| Check | GLB | OBJ | For Blender |
|---|---|---|---|
| Khronos glTF Validator 2.0.0-dev.3.10 | 0 errors, 13 warnings | n/a | Same GLB |
| Independent parser | gltf-transform, all checks pass | Line parser passes | Same GLB |
| Named parts, UVs, materials, embedded textures | Yes | Yes, texture separate | Same GLB |
| Skinned avatar, walk clip, 33 morph frames, 12 weight channels | Yes | n/a | Same GLB |
| **Opened in Blender** | **Not run** | **Not run** | **Not run** |
| Status | Passed | Passed | **Unverified** |

Validator warnings are `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE`: normal maps rely on tangents the importer generates, so shading may vary slightly between tools.

## Known defects

- Two tiny pale marks remain at the collar, where the mannequin nearly touches the fabric. They are visible only up close.
- Fabric stretch sits in the warning band at 14 to 15% on the static drape and about 30% in motion. Causes include the neckline carrying the hood's weight.
- One 1 mm rest edge at the neck centre can read as a high "worst edge" stretch, up to about 240% at High quality with default sizes. It is only 2.7 mm of actual lengthening. Investigation stopped there, and the rest mesh could be cleaned up.
- Walk and jog are procedural and look stylised, with a long stride.
- Drawcords do not swing, and the pocket has no real depth.
- Fabric is a single layer with no thickness, and inner and outer faces share a texture.
- Particle self-collision can let thin layers pass through each other.
- The outline comparison does not mirror the back view. The sample is symmetric, so this did not affect it.
- Sample images are flat synthetic drawings, so projected texture shows little real detail.
- Test projects from early development remain in the git-ignored `data/` folder. They are unused and safe to delete by hand.
