# QA / Red-Team Plan: hoodie image-to-garment studio (2026-11-05)

All thresholds are PROPOSED and uncalibrated; tune on a pilot run.

## Fixtures

| Fixture | Input | Expected | Pass metric | PROPOSED threshold |
|---|---|---|---|---|
| Single front | 1 front photo | Full garment; back marked inferred | Silhouette IoU; inferred label | IoU >= 0.90; label 100% |
| Multi-view | Front/back/side | Consistent mesh | Held-out view IoU; Chamfer vs GT | IoU >= 0.92; CD <= 1.5% bbox diagonal |
| Patterned | Stripes, logo, plaid | Pattern mapped, unstretched | UV stretch; pattern breaks | stretch <= 1.25x; breaks <= 5% |
| Contradictory | Zip front, pullover back | Conflict flagged | Flag rate | >= 95%; 0 silent blends |
| Missing refs | Hood hidden, cropped sleeves | Unseen parts marked | Uncertainty per part | 100% marked |
| Body shapes | XS to 5XL | Refit, no penetration | Penetration area; NaN | < 0.5%; 0 NaN |
| Fast motion | Run, jump, spin | Stable sim | Self-intersection; strain | < 1% faces; < 20% |
| Unusual fabric | Sheer, sequin, leather | Distinct drape; unsupported flagged | Preset response | monotonic; flagged |
| Corrupt upload | Truncated JPEG, polyglot, 0 bytes | Clean rejection | 4xx, no crash, nothing stored | 100% in < 1 s |
| Large asset | 100 MP image, 2 GB archive | Limit or downscale | Memory ceiling | no OOM; clear error |
| Interrupted worker | Kill mid-sim/export | Resume or honest failure | Job state; export integrity | 100% correct; 0 corrupt GLB |
| Provider down | Timeout, 429, blocked | Retry then explicit failure | Backoff; fallback | 0 silent fallbacks |

Cross-cutting: export round-trip (glTF-Validator passes, .blend loads, viewer render matches Blender render), determinism (same seed, CD < 0.1%), edit test (change sleeve length, sim reruns).

## Geometry vs image similarity

Pixel similarity only scores appearance from the fitted camera. One projection loses depth, so many shapes share one silhouette: a flat relief can match the photo and be wrong from every other angle. Textures can also fake shading.

- Image metrics (report, never sole gate): SSIM (Wang et al. 2004, https://doi.org/10.1109/TIP.2003.819861), LPIPS (Zhang et al. 2018, https://arxiv.org/abs/1801.03924). Score held-out views only.
- Geometry (gate): Chamfer distance (Fan et al. 2017, https://arxiv.org/abs/1612.00603), F-score (Tatarchenko et al. 2019, https://arxiv.org/abs/1905.03678), normal consistency. Chamfer is outlier-sensitive and blind to thin or inner surfaces, so pair it with F-score.
- No-GT checks: manifold/watertight, self-intersection, penetration, edge strain, flattening distortion, symmetry.
- Real photos lack GT: use held-out view consistency plus human ratings (3+ raters, PROPOSED).

All URLs accessed 2026-11-05.

## Datasets for later real-photo tests

- GarmentCodeData v2 (synthetic patterns + 3D): CC BY 4.0 per a Hugging Face mirror (https://huggingface.co/datasets/chibifire/datasource-garmentcodedata-v2-parquet). The ETH record (DOI 10.3929/ethz-b-000690432) returned HTTP 500, so upstream licence is UNVERIFIED. A paper mirror shows CC BY-SA 4.0, probably for the paper.
- Deep Fashion3D (scanned real garments): https://github.com/GAP-LAB-CUHK-SZ/deepFashion3D requires a form for the unzip password. No licence text found; UNVERIFIED, assume research-only.
- CLOTH3D (synthetic): https://chalearnlap.cvc.uab.cat/dataset/38/description/ requires registration and states no licence. UNVERIFIED.
- DeepFashion 2D: https://mmlab.ie.cuhk.edu.hk/projects/DeepFashion/DeepFashionAgreement.pdf, non-commercial research only per search summary (PDF not opened).

Gap: none offers consented real hoodie photos with 3D GT. Capture an own set (signed releases, scan GT).

## How demos deceive, and detection

1. Cherry-picked inputs: run the fixed fixtures; report all failures.
2. Canned asset behind the UI: feed a nonsense image (blank wall must fail) and an unseen garment; hash outputs.
3. Fake depth (relief, billboard): orbit 360 degrees; check normals and Chamfer.
4. Hallucinated back/sides: held-out view test; require inferred-region labels.
5. Pre-baked sim video: change body shape or gravity at runtime; result must change.
6. Single demo pose: run fast-motion fixture.
7. Export differs from viewer: round-trip render comparison.
8. Hidden manual fixing: log human interventions; time raw upload to result.
9. Metric gaming (high SSIM, bad shape): gate on geometry metrics.
10. Silent provider fallback: provider-down fixture plus call logs.
11. Leakage: perceptual-hash inputs against dataset images.
