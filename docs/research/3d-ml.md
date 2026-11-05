# 3D/ML options for image-to-editable-garment (benchmark: oversized hoodie)

Researched 2026-11-05 via web search and fetching official repo/doc pages. **Nothing here was tested by me (not tested).** "Unverified" means I could not confirm it from a first-party page. Machine: M6, 16 GB, no CUDA, no API keys.

## Comparison

| Option | Commercial licence | Source / weights | Compute | API price / retention | Output | Apple Silicon? |
|---|---|---|---|---|---|---|
| Hunyuan3D 2.1 | Tencent community licence: territory excludes EU, UK, South Korea; licence request needed above 1M MAU; outputs cannot train other models ([LICENSE](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/LICENSE)) | Open weights ([repo](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1), Jun 2025) | 10 GB shape, 21 GB texture, 29 GB both | Self-host | Textured PBR mesh; UV unverified | README says macOS supported, but install is CUDA-based; not tested. Remote GPU |
| Hunyuan3D 3.x (API only) | Tencent Cloud terms, unverified | Closed; only 2.x is open per [CostGoat](https://costgoat.com/pricing/hunyuan-3d) (third party) | Hosted | 25 credits per textured model, about $0.375-0.50; 200 free credits; retention not stated ([Tencent](https://intl.cloud.tencent.com/document/product/1284/75281), updated 2026-01-06) | Offers UV Unfold, Smart Topology add-ons | Hosted |
| TRELLIS.2 (4B) | MIT stated in README ([repo](https://github.com/microsoft/TRELLIS.2)); project page carries a research-only disclaimer, so get legal review | Open | NVIDIA 24 GB, Linux only | Self-host | GLB with PBR; handles open surfaces | No |
| TripoSR | MIT ([repo](https://github.com/VAST-AI-Research/TripoSR)) | Open | About 6 GB VRAM | Self-host | Vertex colours or baked texture; low fidelity | MPS not mentioned; not tested |
| Tripo API | Terms not shown; verify | Closed | Hosted | $0.01 per credit; image or multiview to 3D 20-30 credits, retopo 10-40, segmentation 30-50 ([docs](https://developers.tripo3d.ai/)); retention and training use not stated | GLB/FBX/OBJ/USDZ, native quad (P2.0), PBR; UV not stated | Hosted |
| Meshy API | Not stated on docs pages | Closed | Hosted | Multi-image 20 credits (mesh), +10 texture; **credit price not on page** ([pricing](https://docs.meshy.ai/api/pricing)); API assets deleted after 3 days, Enterprise indefinite ([retention](https://docs.meshy.ai/api/asset-retention)) | Remesh and UV Unwrap endpoints (5 credits each) | Hosted |
| Rodin / Hyper3D | Commercial licence listed on Business tier ([pricing](https://hyper3d.ai/pricing)) | Closed | Hosted | API only on Business, $120/month; $1.50 per direct credit; per-generation cost unverified; retention not stated | High-poly quads, baked normals; UV unverified | Hosted |
| SAM 3 / 3.1 | SAM License (custom, Meta); commercial use appears permitted, read the text ([repo](https://github.com/facebookresearch/sam3), 3.1 dated 2026-03-27) | Open weights | CUDA 12.6+ listed | Self-host | Masks (use for garment/background isolation) | Not mentioned; not tested |
| GarmentCode / PyGarment | MIT ([repo](https://github.com/maria-korosteleva/GarmentCode)) | Open code; some SMPL-related body assets restricted | Pattern generation is CPU Python; simulation (Warp) hardware unstated | Self-host | Parametric 2D panels and stitching | Pattern side likely; simulation not tested |
| AIpparel | Code MIT; weights licence unverified ([code](https://github.com/georgeNakayama/AIpparel-Code)) | Code and weights | Tested on PyTorch 2.3.1 with CUDA 12.1; needs LLaVA 1.5 parts | Self-host | Image or text to sewing pattern (GarmentCode-style) | No (CUDA) |
| ChatGarment | Apache-2.0 ([repo](https://github.com/biansy000/ChatGarment)); built on LLaVA/LISA, check their licences | Code, dataset; checkpoint status unverified | GPU unstated | Self-host | Image to GarmentCode JSON, then sim via ContourCraft | Remote GPU |
| Sewformer | Repo shows no licence ([repo](https://github.com/sail-sg/sewformer)); treat as unlicensed | Weights on HF | Single GPU, unstated | Self-host | Image to sewing pattern (SewFactory) | Unlikely |
| Garment3DGen (Meta) | Licence not shown ([repo](https://github.com/nsarafianos/Garment3DGen)); assume non-commercial until read | Code | CUDA 11.8, nvdiffrast, PyTorch3D | Self-host | Template-mesh stylisation, UV texture, not patterns | No |
| NeuralTailor | Paper is real (Korosteleva & Sorkine-Hornung, 2022); I did not find a repo or licence. **Unverified** | - | - | - | Pattern prediction from point clouds | - |

## Surface reconstruction vs sewing-pattern + drape

- **Surface (Hunyuan, Tripo, Meshy, Rodin, TRELLIS):** fast and visually convincing, but the result is a baked shell. An oversized hoodie's hood, pocket and cuffs are fused geometry. Topology is arbitrary unless quad retopo is bought. No seams, fabric or grading, so edits are mesh sculpting only.
- **Pattern + drape (GarmentCode, AIpparel, ChatGarment, Sewformer):** output is panels, stitches and parameters, so users can edit sleeve length, ease and hem, then re-drape. Weaknesses: limited garment vocabulary, so oversized hoodie fidelity is unknown, and drape needs a simulator I have not tested on Mac.
- **Conclusion:** surface output is a preview and texture source. The editable product needs the pattern track. Run both behind one contract.

## Recommended adapter contract

Async job model, one interface per capability, so providers are swappable and a mock works without keys:

```
Provider { id, capabilities: {surface, multiview, pattern, drape, segment}, license: {commercial, regions, outputsTrainable}, retentionDays }
segment(image) -> Mask[]
reconstructSurface({images[], quality}) -> Job -> {glb, uvPresent, pbr, topology: tri|quad, providerMeta}
estimatePattern({images[], bodyParams?}) -> Job -> {garmentCodeJson, panels[], confidence}
drape({pattern, body, fabric}) -> Job -> {glb}
Job: {id, status, cost, error, expiresAt}   // always download and persist outputs
```

Rules: persist outputs immediately (Meshy deletes in 3 days); store licence and region flags per provider; never send user images to a provider whose retention is unverified; keep GarmentCode JSON as the canonical editable format.

## First real provider

**Tripo API** for the surface track: clear first-party pricing (about $0.20-0.30 per multiview model), multiview, segmentation, quad retopo, and standard formats. Its terms, retention and commercial-use text must be read first (not found in docs I saw). Hunyuan via Tencent Cloud is the cheaper alternative, but its licence territory clause matters for EU/UK users.

Right after: **GarmentCode (MIT) plus AIpparel on a rented NVIDIA GPU** for the pattern track, because it is the only path to genuinely editable garments. Local M6 work is limited to the adapter, mocks, SAM-style masking (unverified on MPS) and pattern editing UI.

## Not verified

Tripo, Meshy, Rodin data-training policies; Hunyuan 3.x release dates; Rodin per-call price; AIpparel weights licence; Sewformer, Garment3DGen licences; any Apple Silicon claim; GarmentCode simulation hardware needs.
