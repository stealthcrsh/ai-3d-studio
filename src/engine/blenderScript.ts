/**
 * Offered to Blender users as a plain text file. It is the only way to get a genuine .blend, because only Blender can
 * write one. It has NOT been run: Blender is not installed here by the owner's decision (2026-11-05).
 */
export const MAKE_BLEND_PY = `# AI 3D Studio: turn hoodie.glb into a real .blend. UNTESTED: this script has not been run in Blender yet.
# Run from a terminal:  blender --background --factory-startup --python make_blend.py -- hoodie.glb hoodie.blend
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
glb_path, blend_path = argv[0], argv[1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb_path, import_pack_images=True)

scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0
scene.render.fps = 30

last_frame = 1
for action in bpy.data.actions:
    last_frame = max(last_frame, int(round(action.frame_range[1])))
scene.frame_start = 1
scene.frame_end = last_frame

bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=blend_path, compress=True)
print("Saved", blend_path)
`;

export const BLENDER_README = `Using this hoodie in Blender

Quickest: open Blender, choose File > Import > glTF 2.0, and pick hoodie.glb.
To save a .blend: run make_blend.py as described at the top of that file.

Not yet tested: neither route has been opened in Blender. hoodie.glb has passed the Khronos glTF Validator and an
independent parser. Those checks do not prove how Blender will display it.

Expected after import, per the glTF format: named parts, UVs, materials, the avatar rig, and baked cloth as shape keys.
`;
