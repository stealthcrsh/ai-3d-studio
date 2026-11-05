# Garment physics research (XPBD cloth, fabrics, avatars)

Accessed 2026-11-05. All numeric values are approximate. Items marked **[A]** are my assumptions or engineering judgement, not from a source. Treat every default as a starting point for tuning.

## 1. XPBD small-steps parameters
- Method: split each frame into n substeps, one XPBD iteration each; this beats one big step with n iterations ([Macklin et al., SCA 2019](https://diglib.eg.org/items/322424d5-a24f-490a-a6bb-542233852032/full)). Compliance is time-scaled, alpha_tilde = alpha/dt^2 (Müller's code uses `alpha = compliance/dt/dt`).
- Reference demos ([self-collision](https://raw.githubusercontent.com/matthias-research/pages/master/tenMinutePhysics/15-selfCollision.html), [cloth](https://raw.githubusercontent.com/matthias-research/pages/master/tenMinutePhysics/14-cloth.html), Müller, Ten Minute Physics): 60 Hz frame, 10-15 substeps, stretch compliance 0, shear 1e-4, bending compliance 1.0 (distance-across-hinge, mesh-scale dependent, not physical units).
- **Recommended [A]:** bake at 60 Hz with 10 substeps (dt_sub about 1.7 ms), 1 iteration; raise to 20 for denim or fast motion. Stretch 0 to 1e-8 m/N; shear 1e-5 to 1e-4; bend (dihedral, tune visually) denim 1e-3, fleece 1e-2, jersey 1e-1. Velocity damping 0.5-1 /s.

## 2. Self-collision and thickness
- Müller's five tricks: particle-based collision with a spatial hash, rest-distance-aware minimum distance, substeps instead of CCD, a velocity clamp, and friction. The collision distance is min(2r, rest spacing) so collision and stretch constraints do not fight. The demo uses thickness = hash spacing = rest spacing (1 cm), velocity clamp maxV = 0.2*thickness/dt_sub (about 1.2 m/s at 600 Hz), and rebuilds the hash once per frame ([notes PDF](https://matthias-research.github.io/pages/tenMinutePhysics/15-selfCollision.pdf), could not parse; details from the code).
- Cost: hash build is O(N) and neighbour queries are about constant per particle, so a particle approach is cheap. Vertex-triangle CCD is costly; I-Cloth reports collision handling taking up to 70-80% of frame time ([Tang et al., SIGGRAPH 2018](https://min-tang.github.io/home/ICloth/)). Offline bake of about 20-30k vertices with the particle hash is feasible server-side **[A]**.
- **Recommended [A]:** avatar capsule offset 3 mm (fleece/denim) or 2 mm (jersey) plus 1-2 mm margin; self-collision radius about 0.4x mean edge length (about 4 mm for a 1 cm mesh); hash cell = 2r; rebuild hash every 2 substeps; clamp speed to 0.2*thickness/dt_sub.

## 3. Fabric values (approximate)
| Fabric | g/m² | Bending B, gf·cm²/cm [A unless noted] |
|---|---|---|
| Single jersey | 120-200 | 0.002-0.05 (knit cotton range from a [patent](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/5427156)) |
| Fleece/French terry (hoodie) | 280-400 | 0.02-0.1 |
| Denim | 270-400 (8-12 oz) | 0.1-0.5 |

GSM ranges come from vendor guides ([Thygesen](https://thygesenapparel.com/blog/what-is-gsm-in-fabric), [Threads](https://www.threadsmagazine.com/2022/04/19/matters-of-fabric-weights)), which disagree at the edges. The only measured KES-FB data I verified: a 227 g/m² cotton/poly twill has B about 0.36 (warp) and 0.09 (weft) in the paper's units ([PMC12349057](https://pmc.ncbi.nlm.nih.gov/articles/PMC12349057/), 2025). Fleece and denim bending rows are unsourced guesses; measure real swatches before trusting them. Unit conversion: 1 gf·cm²/cm is about 9.8e-5 N·m. Particle mass = gsm x vertex area.

## 4. Stability failure modes and detection thresholds ([A], tune on real bakes)
- **Explosion:** NaN/Inf; max vertex speed > 20 m/s; per-frame vertex displacement > 0.25 m; kinetic energy > 10x its rolling median.
- **Tunneling:** any vertex signed distance to a capsule < -0.5*thickness after the solve; per-substep travel > thickness; vertex normal pointing against the body-outward normal.
- **Stretch:** edge strain > 5% warns, > 10% fails (jersey: 20%); 99th-percentile strain > 5%; triangle area ratio < 0.5 or > 2; dihedral flip.
- Response: re-run the frame with 2x substeps; fail the bake after 2 retries.

## 5. Avatars and mocap
- **Mixamo:** the [FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html) (403 to my fetch) is summarised via [search](https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400): royalty-free for commercial projects with an Adobe ID, no redistribution of raw files, no ML training, not available for Enterprise/Federated IDs. A web studio streaming the rig and animation to users arguably redistributes files, so get legal review. Forum posts are not official.
- **CMU mocap:** [mocap.cs.cmu.edu](http://mocap.cs.cmu.edu/) failed TLS in my fetch. Secondary sources quote it as free for research and commercial use, no direct resale; the [4TU FBX conversion](https://data.4tu.nl/datasets/0448aab2-3332-449f-a8e2-d208cb58c7df) is CC BY-NC 4.0, so use the original BVH. Verify the official wording.
- **SMPL:** [license](https://smpl.is.tue.mpg.de/modellicense.html) is non-commercial only; commercial use requires a paid license via Meshcapade. Excluded for MVP.
- **CC0:** [Quaternius Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) (120+ clips, glTF/FBX, CC0; Library 2 adds 130+, Jan 2026) per search results; confirm on the site.

**Recommendation:** procedural mannequin for the MVP. Capsule colliders can match the rendered body exactly (no mesh/collider mismatch), there is no licensing risk, and it has deterministic proportions for size sliders. Drive it with CC0 Quaternius clips retargeted to the mannequin skeleton. Add a licensed or CC0 mesh avatar later.
