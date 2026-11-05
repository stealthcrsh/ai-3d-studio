# DCC interoperability: GLB, .blend, OBJ (FBX/USD for comparison)

Accessed 2026-11-05. Latest stable found: Blender 5.2 LTS (blender.org/releases/5-2/; 5.3 unverified). "Unverified" marks items not confirmed from a fetched page.

## 1. Blender glTF importer mapping
- Morph targets become shape keys, one per target, on a single mesh. Names come from `mesh.extras.targetNames`, else the first primitive's POSITION target accessor name, else `target_N`. Targets that do not morph POSITION are skipped; primitives lacking targets are tolerated (glTF-Blender-IO commits 3e09faa, 70ee1a5, 06bb353, 2022).
- Weights: `mesh.weights` sets default key values. Animation path `weights` imports as a shape-key action. Imported animations become actions stashed on NLA tracks, named per glTF animation, split per object. The manual does not say how weight channels map in detail (unverified).
- Skins: `skin.joints` become armature bones; Bone Direction/heuristic, Guess Original Bind Pose and Disable Bone Shape options exist. JOINTS_n/WEIGHTS_n become vertex groups. The manual notes the non-animated rest pose of an animated model cannot be viewed.
- Spec (Khronos glTF 2.0, spec text read via the repo's Specification.adoc): clients SHOULD support at least eight morphed attributes; all primitives with targets MUST have equal target counts; `mesh.weights` length MUST equal the target count; `weights` accessors are SCALAR, targets x frames, and may be sparse; joint sets are 4 influences each and clients MAY support only one set; unorm weights MUST sum to exactly 1.0.

## 2. Morph target limits
- Blender: the manual states no hard shape-key cap (unverified). Practical limits are RAM and the per-key dense delta stored on export.
- three.js: targets are packed into a float `DataArrayTexture`, one layer per target; row width wraps at `maxTextureSize`; WebGLMorphtargets.js enforces no count cap. WebGL2 `MAX_ARRAY_TEXTURE_LAYERS` guarantees only 256 layers (from GL spec, not fetched), so budget under 256 and test target devices. Texture memory is not freed on unload (three.js issue 23095).
- Spec floor is only eight attributes, so other viewers may cap lower.

## 3. Safe headless flags (untrusted content)
`blender --background --factory-startup --disable-autoexec --offline-mode --python-exit-code 1 --python export.py -- in.glb out.blend`
- `--factory-startup` ignores user startup file and prefs. `--disable-autoexec` blocks drivers and registered text-block scripts; the manual says it is the default, so pass it anyway. `--offline-mode` blocks network. Do not pass `--python-use-system-env` (Blender manual, command-line arguments).
- Python Security page: manually run scripts still execute with autoexec off. Never open untrusted .blend with Trusted Source enabled.
- Importer: `import_pack_images` (default on) packs textures into the .blend. For an output .blend, also call `bpy.ops.file.pack_all()`; save with `compress=True`. Optionally `merge_vertices`, which cannot merge vertices with differing normals.
- Run inside a sandbox (container, no network, resource limits). Blender itself is not a sandbox.

## 4. Feature matrix
Y = yes, P = partial, N = no. General knowledge, not verified against fetched pages.

| Feature | GLB | .blend | OBJ | FBX | USD |
|---|---|---|---|---|---|
| Geometry | Y | Y | Y | Y | Y |
| Hierarchy | Y | Y | P (groups) | Y | Y |
| UVs | Y | Y | Y | Y | Y |
| PBR | Y core metal-rough | P (Principled) | N (MTL) | P | Y (UsdPreviewSurface/MaterialX) |
| Rig/skin | Y | Y | N | Y | Y (UsdSkel) |
| Skeletal anim | Y | Y | N | Y | Y |
| Morph/blendshape | Y | Y | N | Y | Y |
| Vertex cache | N | Y (MDD/Alembic modifiers) | N | P | Y (time-sampled points) |
| Physics | N (extension drafts) | Y (internal sim) | N | N | P (UsdPhysics) |

## 5. Round-trip checks
- Structure: `gltf_validator` (Khronos) returns non-zero on errors; it checks JSON, GLB, accessors, sparse, and animation I/O; its README says nothing on skins or morph counts, so add custom checks. glTF-Validator README, github.com/KhronosGroup/glTF-Validator.
- Morphs: same key count and names, then evaluate each key at weight 1.0 and compare vertex deltas under ~1e-5.
- Skin: same joint count, hierarchy, inverse bind matrices; pose at three frames and compare skinned vertices.
- Animation: sample the weights channel and bone TRS at fixed times; compare curves.
- UV/PBR: compare UV bounds, texture hashes, and factor values.
- Cloth cache: compare vertex positions per frame after baking.
- OBJ proves only geometry, UVs, groups and MTL.

## 6. Cache fallback
When cloth morph count is too high, use per-frame vertex cache: Alembic (.abc) or MDD (point cache) applied to a fixed-topology mesh in Blender (Mesh Cache modifier). The modifier and fixed-topology constraint are unverified from docs.

## Sources
- https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html (read via projects.blender.org raw, 2026-11-05)
- https://docs.blender.org/manual/en/latest/advanced/scripting/security.html (same method)
- https://docs.blender.org/api/latest/bpy.ops.import_scene.html (via search snippet; direct fetch returned 403)
- https://github.com/KhronosGroup/glTF-Blender-IO (docs and commits)
- https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
- https://github.com/KhronosGroup/glTF-Validator
- https://github.com/mrdoob/three.js/blob/dev/src/renderers/webgl/WebGLMorphtargets.js
- https://www.blender.org/releases/5-2/
