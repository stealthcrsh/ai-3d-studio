Using this hoodie in Blender

Quickest: open Blender, choose File > Import > glTF 2.0, and pick hoodie.glb.
To save a .blend: run make_blend.py as described at the top of that file.

Not yet tested: neither route has been opened in Blender. hoodie.glb has passed the Khronos glTF Validator and an
independent parser. Those checks do not prove how Blender will display it.

Expected after import, per the glTF format: named parts, UVs, materials, the avatar rig, and baked cloth as shape keys.
