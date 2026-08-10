# SPDX-License-Identifier: GPL-3.0-or-later
"""Allowlisted WorldEngine Blender worker. Never evaluates model-authored code."""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector

ALLOWED = {
    "validate-mesh", "fix-normals", "normalize-origin", "normalize-materials",
    "fix-ground-contact", "export-glb",
    "render-turntable", "render-passes",
}


def diagnostic(severity, code, message):
    return {"severity": severity, "code": code, "message": message}


def mesh_objects():
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def world_bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    return Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points))), Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))


def normalize_materials(objects):
    for obj in objects:
        for slot in obj.material_slots:
            material = slot.material
            if not material:
                continue
            material.use_nodes = True
            if not any(node.type == "BSDF_PRINCIPLED" for node in material.node_tree.nodes):
                material.node_tree.nodes.new("ShaderNodeBsdfPrincipled")


def setup_camera(objects, angle, resolution):
    low, high = world_bounds(objects)
    center = (low + high) * 0.5
    radius = max((high - low).length * 0.9, 2.0)
    camera_data = bpy.data.cameras.new("WorldEngineCamera")
    camera = bpy.data.objects.new("WorldEngineCamera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.location = center + Vector((math.cos(angle) * radius, math.sin(angle) * radius, radius * 0.55))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.lens = 55
    bpy.context.scene.camera = camera
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = True
    return camera


def render_turntable(objects, directory, resolution):
    outputs = []
    for index, angle in enumerate((0, math.pi / 2, math.pi, math.pi * 1.5)):
        camera = setup_camera(objects, angle, resolution)
        path = os.path.join(directory, f"turntable-{index}.png")
        bpy.context.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        outputs.append({"kind": "blender-rgb", "path": path})
        bpy.data.objects.remove(camera, do_unlink=True)
    return outputs


def emission_material(name, color):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (*color, 1.0)
    emission.inputs["Strength"].default_value = 1.0
    material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def normal_material():
    material = bpy.data.materials.new("WorldEngineNormalPass")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    geometry = nodes.new("ShaderNodeNewGeometry")
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "SCALE"
    scale.inputs[3].default_value = 0.5
    add = nodes.new("ShaderNodeVectorMath")
    add.operation = "ADD"
    add.inputs[1].default_value = (0.5, 0.5, 0.5)
    emission = nodes.new("ShaderNodeEmission")
    material.node_tree.links.new(geometry.outputs["Normal"], scale.inputs[0])
    material.node_tree.links.new(scale.outputs["Vector"], add.inputs[0])
    material.node_tree.links.new(add.outputs["Vector"], emission.inputs["Color"])
    material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def depth_material(near, far):
    material = bpy.data.materials.new("WorldEngineDepthPass")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    camera = nodes.new("ShaderNodeCameraData")
    mapping = nodes.new("ShaderNodeMapRange")
    mapping.clamp = True
    mapping.inputs[1].default_value = near
    mapping.inputs[2].default_value = far
    mapping.inputs[3].default_value = 1.0
    mapping.inputs[4].default_value = 0.0
    emission = nodes.new("ShaderNodeEmission")
    material.node_tree.links.new(camera.outputs["View Z Depth"], mapping.inputs[0])
    material.node_tree.links.new(mapping.outputs["Result"], emission.inputs["Color"])
    material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def render_override(objects, path, materials):
    original = [[slot.material for slot in obj.material_slots] for obj in objects]
    try:
        for obj, material in zip(objects, materials):
            if len(obj.data.materials) == 0:
                obj.data.materials.append(material)
            else:
                for index in range(len(obj.data.materials)):
                    obj.data.materials[index] = material
        bpy.context.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
    finally:
        for obj, slots in zip(objects, original):
            obj.data.materials.clear()
            for material in slots:
                obj.data.materials.append(material)


def render_diagnostic_passes(objects, directory, resolution):
    camera = setup_camera(objects, math.pi / 4, resolution)
    low, high = world_bounds(objects)
    extent = max((high - low).length, 1.0)
    camera.data.clip_start = max(0.01, extent * 0.005)
    camera.data.clip_end = max(100.0, extent * 8.0)
    outputs = []
    normal_path = os.path.join(directory, "normal.png")
    render_override(objects, normal_path, [normal_material()] * len(objects))
    outputs.append({"kind": "blender-normal", "path": normal_path})
    depth_path = os.path.join(directory, "depth.png")
    render_override(objects, depth_path, [depth_material(camera.data.clip_start, camera.data.clip_end)] * len(objects))
    outputs.append({"kind": "blender-depth", "path": depth_path})
    palette = [
        ((index * 73 % 251) / 250.0, (index * 151 % 251) / 250.0, (index * 199 % 251) / 250.0)
        for index in range(1, len(objects) + 1)
    ]
    instance_path = os.path.join(directory, "instance.png")
    render_override(objects, instance_path, [emission_material(f"WorldEngineInstance{index}", color) for index, color in enumerate(palette)])
    outputs.append({"kind": "blender-instance", "path": instance_path})
    bpy.data.objects.remove(camera, do_unlink=True)
    return outputs


def main(job_path):
    with open(job_path, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    operations = job.get("operations", [])
    unknown = sorted(set(operations) - ALLOWED)
    if unknown:
        raise RuntimeError(f"Disallowed Blender operations: {', '.join(unknown)}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=job["inputPath"])
    objects = mesh_objects()
    if not objects:
        raise RuntimeError("Input GLB contains no mesh objects")
    diagnostics = [diagnostic("info", "MESH_COUNT", f"Imported {len(objects)} mesh objects")]
    if "fix-normals" in operations:
        for obj in objects:
            for polygon in obj.data.polygons:
                polygon.use_smooth = True
    if "normalize-materials" in operations:
        normalize_materials(objects)
    low, high = world_bounds(objects)
    if "normalize-origin" in operations or "fix-ground-contact" in operations:
        offset = Vector((-(low.x + high.x) * 0.5, -(low.y + high.y) * 0.5, -low.z))
        for obj in objects:
            obj.location += offset
        diagnostics.append(diagnostic("info", "GROUND_CONTACT_FIXED", "Centered asset and placed its lowest point on the ground plane"))
    if job.get("targetHeightMeters"):
        low, high = world_bounds(objects)
        height = max(high.z - low.z, 1e-5)
        factor = float(job["targetHeightMeters"]) / height
        for obj in objects:
            obj.scale *= factor
    renders = render_turntable(objects, job["renderDirectory"], int(job["renderResolution"])) if "render-turntable" in operations else []
    if "render-passes" in operations:
        renders.extend(render_diagnostic_passes(objects, job["renderDirectory"], int(job["renderResolution"])))
    bpy.ops.export_scene.gltf(filepath=job["outputPath"], export_format="GLB", export_apply=True, export_yup=True)
    with open(job["resultPath"], "w", encoding="utf-8") as handle:
        json.dump({"workerVersion": "blender-5.1-worker-1.0.0", "renders": renders, "diagnostics": diagnostics}, handle)


if __name__ == "__main__":
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    main(parser.parse_args(arguments).job)
