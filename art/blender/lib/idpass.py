# SPDX-License-Identifier: GPL-3.0-or-later
"""Plan 16 R3: the flat ID pass and a solid look render, both Workbench, from the set's own camera."""
import bpy

from lib.layout import linear


def _workbench(scene, width, height):
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.render.dither_intensity = 0.0     # no dither noise: the ID pass is flat colour
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.display_settings.display_device = "sRGB"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("world")
    scene.world.color = (0.0, 0.0, 0.0)
    sh = scene.display.shading
    sh.show_object_outline = False
    sh.show_cavity = False
    sh.show_specular_highlight = False
    sh.show_shadows = False
    sh.show_xray = False


def render_id(scene, camera, out_png, colours, background, width=640, height=480):
    """`colours` maps an object name to 0xRRGGBB; every other mesh gets `background`. Flat, unsmoothed, one colour per object."""
    _workbench(scene, width, height)
    scene.display.render_aa = "OFF"
    sh = scene.display.shading
    sh.light = "FLAT"
    sh.color_type = "OBJECT"
    for obj in scene.objects:
        if obj.type == "MESH":
            obj.color = (*linear(colours.get(obj.name, background)), 1.0)
    scene.camera = camera
    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)


def render_solid(scene, camera, out_png, width=1280, height=960):
    """A look render: studio light on each material's viewport colour, antialiased."""
    _workbench(scene, width, height)
    scene.display.render_aa = "8"
    sh = scene.display.shading
    sh.light = "STUDIO"
    sh.color_type = "MATERIAL"
    scene.camera = camera
    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)


def render_look(scene, camera, out_png, width=960, height=720, samples=32):
    """The look render (R6): Cycles on the CPU with the set's lights and materials, denoised, sRGB, no tone mapping (as the browser)."""
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.seed = 5
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("world")
    scene.world.color = (0.02, 0.022, 0.03)        # the engine's own hemisphere light stands in for ambient; Blender's is a little dark blue
    scene.camera = camera
    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)


def render_ortho(scene, out_png, keep, view, centre, size, width=1000, height=700):
    """An orthographic look at the objects `keep(name)` says yes to, from above ("top", far side up) or from the viewer ("front"),
    centred on the design point `centre`, `size` metres across. Workbench, studio light, antialiased."""
    from lib.layout import b
    hidden = [o for o in scene.objects if not keep(o.name) and not o.hide_render]
    for o in hidden:
        o.hide_render = True
    data = bpy.data.cameras.new("ortho")
    data.type = "ORTHO"
    data.ortho_scale = size
    data.clip_start = 0.01
    data.clip_end = 100.0
    cam = bpy.data.objects.new("ortho", data)
    scene.collection.objects.link(cam)
    cx, cy, cz = b(centre)
    if view == "top":
        cam.location = (cx, cy, cz + 20.0)
        cam.rotation_euler = (0.0, 0.0, 0.0)
    else:
        cam.location = (cx, cy - 20.0, cz)
        cam.rotation_euler = (1.5707963, 0.0, 0.0)
    _workbench(scene, width, height)
    scene.display.render_aa = "8"
    sh = scene.display.shading
    sh.light = "STUDIO"
    sh.color_type = "MATERIAL"
    scene.camera = cam
    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)
    for o in hidden:
        o.hide_render = False
    bpy.data.objects.remove(cam, do_unlink=True)
