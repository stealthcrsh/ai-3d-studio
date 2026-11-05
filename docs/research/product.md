# Product Strategy: Image-to-Editable-3D-Garment Studio
Date: 2026-11-05. Tags: [S]=sourced, [A]=assumption (unvalidated), [H]=hypothesis to test.

## Evidence base
- Poliigon State of 3D 2025 (3,779 responses, via 80.lv, 2025-11-12): 22% of 3D artists use AI regularly; 68% never use AI 3D model generators; 46% of employers have no AI rules, 9% ban it. [S] https://80.lv/articles/despite-the-hype-only-22-of-3d-artists-regularly-use-ai (Self-selected sample; no reasons given.)
- Style3D Studio "AI Garment" (help page; released July 2025 per search summary, page itself returned 404 on re-fetch): text/image to 2D patterns plus 3D garment, trial access by request. [S, weakly] https://help.style3d.com/studio/en/c2c8/7cd2/b61b/
- Marvelous Designer 2026.0 (2026-04-20): glTF support, 3D Pencil, rigging/animation updates; I found no image-to-garment feature. [S] https://www.cgchannel.com/2026/04/clo-virtual-fashion-releases-marvelous-designer-2026-0/
- Research: AIpparel (https://arxiv.org/abs/2412.03937), DressWild (single in-the-wild photo to sewing patterns plus 3D garment, 2026-02-18, https://arxiv.org/abs/2602.16502), SwiftTailor (https://arxiv.org/abs/2603.19053). Papers, not products; robustness unproven. [S]
- Generic image-to-3D: Meshy (GLB/FBX, humanoid rigging), Tripo (quad option, FBX), Hunyuan3D (local, GLB, reported non-manifold meshes). No garment-specific evidence found. [S, blog level] https://www.tspi.at/2026/05/01/opensource3dassets.html, https://www.pixazo.ai/blog/?p=2770886
- Blender MCP runs unsandboxed Python. [S] https://dev.to/grove_chatforest/blender-mcp-server-ai-powered-3d-modeling-with-a-security-trade-off-4d6g

## Audience journeys
**Beginner** (maker, indie game dev, fashion student) [A]: upload photo, see hoodie on avatar within minutes, say "shorter sleeves", download a GLB that opens in their engine. Fear: jargon, broken downloads.
**Pro** (technical artist, 3D fashion designer) [A]: needs clean topology, pattern panels, real-unit scale, fabric parameters, edit history, and a .blend with materials intact. Distrusts black boxes; judges by round-tripping into Blender.

## Competitor gaps (hypotheses; no gap below is proven)
1. Generic generators produce fused, non-simulation-ready meshes; garment-specific pattern-based output is mostly academic. [H]
2. CLO/Marvelous are pro-grade, steep to learn, and AI image-to-garment was not found in them. [S+H]
3. Style3D AI Garment is gated by trial request and (unverified) uses a proprietary pipeline. [H]
4. No competitor found offering conversational edits plus verified GLB and genuine .blend. [H, absence of evidence]
5. Pros are skeptical of AI 3D (68% never use generators), so trust (editability, verification reports) matters more than novelty. [S]

## MVP boundary
**In:** oversized hoodie only; one reference image (front, optional back); one neutral avatar with size presets; pattern-panel-based garment; cloth drape; 5 edit verbs (length, width, sleeve, hood size, color/texture); GLB and .blend export with automated verification report; desktop Chrome only.
**Out:** other garments, layering, custom avatars, animation, multi-user, mobile, marketplace, non-garment subjects.

## Prioritized user stories
| # | Story | Acceptance criteria (measurable) |
|---|---|---|
| 1 | Beginner uploads a hoodie photo, gets an editable 3D hoodie | Median time to first draped result under 120 s on benchmark set of 30 photos; >=80% judged "same hoodie" by 2 of 3 blind reviewers |
| 2 | See it fit on an avatar | Zero visible mesh penetration at 3 body presets; sim stable (no explosions) in 95% of runs |
| 3 | Edit by chat | 5 verbs applied correctly in >=90% of 50 scripted prompts; change measurable (e.g. "shorten 5 cm" changes hem within +/-0.5 cm); undo restores state exactly |
| 4 | Export verified GLB | Passes Khronos glTF-Validator with 0 errors; loads in Blender and three.js; size within 2% of spec |
| 5 | Export real .blend | Opens in Blender LTS headless with no missing data; mesh, UVs, materials present; written by Blender, not a renamed GLB |
| 6 | Pro inspects panels/topology | Panels listed with real-unit dimensions; manifold mesh; no triangles under 1 mm edge |
| 7 | Trust report | Every export ships a pass/fail checklist; 0 silent failures in 100 exports |

## Failure cases and tests
- Occluded/odd-pose photos: 30 in-the-wild photos stratified by difficulty; report per stratum.
- Non-hoodie reference: reject or flag; test 20 other images.
- Chat edits misparsed or drift: scripted suite plus 10-step edit chains; geometry diff.
- Sim unstable/penetrating: fuzz parameters; detect self-intersection.
- Export opens but wrong (scale, flipped normals, lost materials): Blender and validator round-trip in CI.
- Pros reject quality: 5-pro session; >=3 would reuse the .blend (A: arbitrary threshold).
- Unsandboxed generated code (Blender MCP risk): never execute model-written Python; use fixed, typed operations.

## Next steps
Interview 8 beginners and 5 pros; benchmark Style3D AI Garment and one generic generator on the same 30 photos.
