# SPDX-License-Identifier: GPL-3.0-or-later
"""A probe room for Plan 14: a floor, a box and a camera, with Plan 4's extras, exported as GLB."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # so `lib` imports under blender -P

import bpy  # noqa: E402
from lib.args import parse_args  # noqa: E402
from lib.extras import tag  # noqa: E402

args = parse_args()          # --out, --params (json): {"size": 4.0, "box": [1.0, 0.0, -1.0]}
size = float(args.params.get("size", 4.0))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
floor = bpy.context.object
floor.name = "region:floor"
tag(floor, region="floor", walkable=True)
bx, by, bz = args.params.get("box", [1.0, 0.0, -1.0])
bpy.ops.mesh.primitive_cube_add(size=1, location=(bx, -bz, by + 0.5))   # Blender is z-up; the exporter's +Y up turns it
box = bpy.context.object
box.name = "hotspot:probe"
tag(box, object="probe", pickable=True, kind="object")
bpy.ops.object.camera_add(location=(0, -6, 2))
cam = bpy.context.object
cam.name = "camera:main"
cam.rotation_euler = (1.4, 0, 0)
tag(cam, projection="perspective", horizonY=150)
bpy.ops.export_scene.gltf(filepath=args.out, export_format="GLB", export_extras=True, export_cameras=True, export_yup=True)
