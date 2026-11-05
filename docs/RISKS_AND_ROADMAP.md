# Cost, risks and roadmap

2026-11-05.

## Cost

| Item | Today | Note |
|---|---|---|
| Compute | $0 | Runs on the user's device |
| Hosting | $0 for the private Artifact | Public hosting not done, needs approval |
| AI providers | $0, none connected | Would need approval |
| Blender | $0, not used | Owner's decision |

If AI reconstruction is added later, `research/market-cost.md` estimates **$0.10 to $1.09 per generation** on rented GPUs. Those are unmeasured estimates built on assumed utilisation and overhead, with prices checked on 2026-11-05.

## Risks

| Risk | Severity | Mitigation today | What would resolve it |
|---|---|---|---|
| Blender gate unmet. No real `.blend`, and no export opened in Blender | **High** | Honest labelling, validated GLB, untested script | Owner tests the GLB in Blender, or approves a one-time test |
| Real photos may measure poorly | **High** | Warnings, confidence, everything editable | A consented photo benchmark, 30 images proposed |
| "AI" product has no AI yet | **High** | DEMO BASELINE on every version and file | A connected provider, which conflicts with browser-only unless a server is added |
| Browser-only blocks heavy AI models | **High** | Provider contract ready | Owner decision on a thin server or an in-browser model |
| Downloads untested in the hosted frame | Low | The link opens and generates, owner confirmed 2026-11-05 | Owner exports a ZIP once from the link |
| Clearing browser data deletes all work | Medium | Requests persistent storage, warns if blocked | Add project export and import |
| Other browsers and weak devices untested | Medium | Clear WebGL and storage errors | Test Safari, Firefox, Windows, older laptops |
| Frame rate unmeasured | Medium | None | Measure with a visible window |
| Thresholds uncalibrated | Medium | Labelled PROPOSED | Owner review against real garments |
| Style3D or CLO may add the same combination | Medium | None yet | `research/market-cost.md` calls this differentiation open but unproven |
| Competitor and licence facts age quickly | Low | Dated, with gaps marked | Re-check before relying on them |

## Roadmap

Order is proposed. Each step needs its own measured fixtures before any claim is made.

**Now**

1. Done 2026-11-05: the link opens and generates the sample. Next, export a ZIP from the link and try a real hoodie photo.
2. Open an exported GLB in Blender, on any machine that has it, and report what you see.
3. Decide how AI generation should work given browser-only. See below.

**Next, hoodie quality**

1. Project export and import, so work can be backed up.
2. Real-photo benchmark and better segmentation.
3. Fabric thickness, a real pocket, swinging cords.
4. Lower stretch and a cleaner neck rest mesh.
5. Hood-up option and more sizes.
6. Sleeve and hood photo projection.

**Then, more garments**

T-shirt, sweatshirt, jacket, trousers. Each adds a pattern template and its own fixtures. The pipeline, jobs, export and UI carry over.

**Later, other subjects, each with its own measured acceptance fixture**

1. Isolated objects and products.
2. Articulated toys.
3. Vehicles.
4. Rooms, architecture, environments.

No claim of universal coverage follows from the hoodie.

## Open decisions for the owner

1. **AI generation under browser-only.** Recommended: keep the browser app for everything it does now, and add a small optional server only for the AI step, since real models need 10 to 29 GB of graphics memory. The alternative is staying fully local, limited to classical methods and small in-browser models.
2. **The Blender gate.** Recommended: accept GLB as the Blender route, once you confirm it imports properly on your side.
3. **Which business owns this product.** It is not stated in the brief.
4. **Quality thresholds.** All are proposed and await your review.
