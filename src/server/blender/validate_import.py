# Runs inside Blender only, in a process separate from the one that wrote the file.
# Opens a .blend, or imports a .glb or .obj, then reports what Blender actually sees.
import json
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1 :]
path, report_path = argv[0], argv[1]

if path.endswith(".blend"):
    bpy.ops.wm.open_mainfile(filepath=path)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if path.endswith(".glb"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif path.endswith(".obj"):
        bpy.ops.wm.obj_import(filepath=path)

scene = bpy.context.scene
depsgraph = bpy.context.evaluated_depsgraph_get()


def evaluated_coords(obj):
    ev = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = ev.to_mesh()
    coords = [tuple(ev.matrix_world @ v.co) for v in mesh.vertices]
    ev.to_mesh_clear()
    return coords


objects = []
for obj in bpy.data.objects:
    entry = {"name": obj.name, "type": obj.type, "parent": obj.parent.name if obj.parent else None}
    if obj.type == "MESH":
        me = obj.data
        entry.update(
            vertices=len(me.vertices),
            polygons=len(me.polygons),
            uv_layers=len(me.uv_layers),
            materials=[m.name for m in me.materials if m],
            shape_keys=len(me.shape_keys.key_blocks) if me.shape_keys else 0,
            vertex_groups=len(obj.vertex_groups),
            dimensions=[round(d, 4) for d in obj.dimensions],
        )
    if obj.type == "ARMATURE":
        entry["bones"] = len(obj.data.bones)
    objects.append(entry)

images = [
    {"name": i.name, "size": list(i.size), "packed": i.packed_file is not None}
    for i in bpy.data.images
    if i.size[0] > 0
]

# Check that motion really plays: measure the same vertices on different frames.
motion = {"checked": False}
shape_objects = [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys and len(o.data.shape_keys.key_blocks) > 2]
if shape_objects:
    obj = next((o for o in shape_objects if o.name.startswith("Sleeve")), shape_objects[0])
    start, end = scene.frame_start, scene.frame_end
    last = max(end, 2)
    for action in bpy.data.actions:
        last = max(last, int(round(action.frame_range[1])))
    mid = max(2, last // 2)
    scene.frame_set(1)
    a = evaluated_coords(obj)
    scene.frame_set(mid)
    b = evaluated_coords(obj)
    move = max(max(abs(p[i] - q[i]) for i in range(3)) for p, q in zip(a, b))
    motion = {"checked": True, "object": obj.name, "frames": [1, mid], "max_vertex_move_m": round(move, 5), "frame_end": last}

skeletal = {"checked": False}
arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
if arm and bpy.data.actions:
    skeletal = {"checked": True, "actions": [a.name for a in bpy.data.actions][:12], "bones": len(arm.data.bones)}

bboxes = {}
for obj in bpy.data.objects:
    if obj.type == "MESH" and obj.name.startswith("Hem"):
        scene.frame_set(1)
        coords = evaluated_coords(obj)
        bboxes[obj.name] = {"min_z": round(min(c[2] for c in coords), 4), "max_z": round(max(c[2] for c in coords), 4)}

report = {
    "blender": bpy.app.version_string,
    "file": path,
    "unit_system": scene.unit_settings.system,
    "unit_scale": scene.unit_settings.scale_length,
    "fps": scene.render.fps,
    "frame_range": [scene.frame_start, scene.frame_end],
    "objects": objects,
    "materials": sorted(m.name for m in bpy.data.materials),
    "images": images,
    "motion": motion,
    "skeletal": skeletal,
    "bboxes": bboxes,
}
with open(report_path, "w") as f:
    json.dump(report, f, indent=1)
