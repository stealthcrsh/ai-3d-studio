# Market and cost analysis (checked 2026-11-05)

Method: web search plus fetches of vendor pages. "V" = read on vendor page today. "3P" = third-party aggregator only. "U" = could not verify. No sign-ups, no spend.

## Competitor table

| Tool | Capability | Editable output? | Export formats | Pricing (checked 2026-11-05) | Data-use terms |
|---|---|---|---|---|---|
| Meshy | Text/image to 3D mesh, retexture | Mesh only, no patterns | FBX, GLB, OBJ, STL, USDZ, BLEND (3P) | V: Free 100 cr; Pro 1,000 cr, ~$20/mo (3P; vendor page rendered in BRL); Studio ~$60/mo (3P). Text-to-3D 20 cr, image-to-3D 20-25 cr (V) | V: Free assets CC BY 4.0; paid assets private, customer-owned |
| Tripo | Text/image to 3D | Mesh only | GLB, FBX, OBJ, USD, STL (3P) | U: vendor page returned 403. 3P: ~$16-19/mo entry, Premium 25k cr | U |
| Rodin / Hyper3D | High-detail image/text to 3D, API | Mesh only | GLB, FBX, OBJ, STL, USDZ (3P; vendor page lists none) | V: Free; Creator $30/mo (~60 models); Business $120/mo (~416 models); direct credits $1.50 | V: paid plans have commercial rights; terms not summarised. Other terms U |
| Luma | Video/image models; Genie 3D | Mesh only | U | V: Plus $30, Pro $90, Ultra $300/mo; page does not mention 3D, so Genie pricing is U | U (page silent) |
| CSM | Image/text to 3D, API | Mesh only | glTF, OBJ, FBX, USDZ, STL (3P) | U: csm.ai unreachable; 3P prices conflict ($20-$2,000/mo) | U |
| Spline AI | AI 3D, texture and style add-on in a web 3D editor | Editable scene; AI geometry is a mesh | V: Pro adds USDZ, STL, GLTF with textures, web/code exports | V: Free (watermark); Hobby $15; Pro $30; Max $70 per seat/mo. AI credits 2,000-10,000/mo; extra 1,000 cr = $5 | U |
| CLO3D | Pattern-based garment CAD with physics | Yes: 2D patterns, seams, fabric physics | U (page lists none) | V: Individual $50/mo; Enterprise by quote | U |
| Marvelous Designer | Same family as CLO, game/VFX focus | Yes | U (page lists none) | V: Individual $23.3/mo billed annually; Student $8.25/mo; Enterprise $199/seat/mo; Indie by application | U. Page mentions "AI Studio" in Individual plan, details U |
| Style3D (Studio / AI) | Garment CAD plus AI. Aug 2026 press release (company-reported): text, sketch, image or pattern to structured assets, seams and initialised simulation | Claimed yes (patterns) | Conflicting: DXF, OBJ, and possibly GLB/FBX (vendor blog) | U: quote-based. One vendor blog shows $99/mo | U |

Garment-specific AI: no other commercial product verified. Research prototypes (GarmentCode, Design2GarmentCode, ChatGarment, AIpparel, DressCode) generate sewing patterns from text or images, but they are papers, not products with SLAs. Catalyst AI and Refabric appear only in low-quality listicles (U).

## Differentiation: editable pattern + physics + verified Blender export

- General AI-to-3D tools (Meshy, Tripo, Rodin, Luma, CSM) output fixed meshes. None has patterns, seams or fabric properties, so they can't resize, regrade or re-simulate a garment.
- CLO, Marvelous Designer and Style3D have patterns and physics but are manual CAD. Only Style3D claims text-to-pattern, and that claim is company-reported.
- I found no product that guarantees a Blender-ready export. "Verified" would mean an automated headless Blender import that checks scale, seam and part counts, no self-intersection, UVs, and a rest-pose match with the simulator. This is the strongest unclaimed gap. I couldn't confirm CLO or MD export lists, so the gap is unproven there.
- Risk: Style3D's AI roadmap and CLO's AI Studio could close the gap. Pattern accuracy against research baselines is unmeasured.

## Compute cost per generation (estimates)

Prices (RunPod page, fetched 2026-11-05, USD/hr): L40S $1.09 secure, $0.79 community; H100 SXM $3.99 secure, $2.69 community. Other clouds differ (3P: Lambda H100 ~$3.3-4.3, AWS ~$6.88).

Assumptions (mine, unmeasured): per-second billing, 40% effective utilisation (idle, cold start, retries), 30% overhead (storage, egress, failed jobs), and about $0.01 of CPU for Blender verification.

Light pipeline: VLM-to-pattern program, cloth sim and Blender check, 90 GPU-s on L40S.
- $1.09 / 3,600 = $0.000303 per s. 90 s x $0.000303 = $0.027.
- / 0.40 = $0.068. + $0.01 CPU = $0.078. x 1.30 = **about $0.10**.

Heavy pipeline: adds diffusion texture and mesh generation, 300 GPU-s on H100.
- $3.99 / 3,600 = $0.001108 per s. 300 s x $0.001108 = $0.332.
- / 0.40 = $0.831. + $0.01 = $0.841. x 1.30 = **about $1.09**.

Community-tier prices cut these by about 25-30%, but they are less reliable.

Market anchors: Meshy Pro $20 / 1,000 cr = $0.02 per credit, so text-to-3D at 20 cr = $0.40. Rodin Creator $30 / 60 = $0.50 per model; Business $120 / 416 = $0.29.

Implication: a 70% gross margin needs a price of at least $0.33 (light) to $3.63 (heavy) per generation (cost / 0.3). Light fits inside competitor per-model pricing; heavy does not unless it is gated or the premium is justified by editability.

## Gaps to close
Tripo, CSM and Luma 3D pricing; export lists for CLO, MD and Style3D; all data-use and training terms except Meshy; actual GPU-seconds per generation (needs a prototype benchmark).
