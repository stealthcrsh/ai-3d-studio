# Runs inside Blender only. Imports the verified GLB and saves a genuine .blend with packed textures.
import json
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
glb_path, blend_path, report_path = argv[0], argv[1], argv[2]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb_path, import_pack_images=True)

scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.unit_settings.scale_length = 1.0
scene.render.fps = 30

garment = bpy.data.collections.new("Garment")
avatar = bpy.data.collections.new("Avatar")
scene.collection.children.link(garment)
scene.collection.children.link(avatar)
PART_PREFIXES = ("Body_", "Sleeve_", "Cuff_", "Hem_", "Hood_", "Pocket", "Drawcord_")
for obj in list(bpy.data.objects):
    is_part = obj.name.startswith(PART_PREFIXES) or obj.name == "Garment_Hoodie"
    target = garment if is_part else avatar
    for coll in list(obj.users_collection):
        coll.objects.unlink(obj)
    target.objects.link(obj)

# Set the playback range from whatever animation the importer produced.
last_frame = 1
for action in bpy.data.actions:
    last_frame = max(last_frame, int(round(action.frame_range[1])))
for key in bpy.data.shape_keys:
    if key.animation_data and key.animation_data.action:
        last_frame = max(last_frame, int(round(key.animation_data.action.frame_range[1])))
scene.frame_start = 1
scene.frame_end = last_frame

scene["studio_note"] = "Created by AI 3D Studio. Parametric DEMO BASELINE. Cloth is baked to shape keys, not a live Blender simulation."
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=blend_path, compress=True)
with open(report_path, "w") as f:
    json.dump({"blender": bpy.app.version_string, "saved": blend_path, "frame_end": last_frame}, f)
