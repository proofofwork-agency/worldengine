# SPDX-License-Identifier: GPL-3.0-or-later
"""Allowlisted WorldEngine Blender worker. Never evaluates model-authored code."""
import argparse
import json
import math
import os
import struct
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Quaternion, Vector

ALLOWED = {
    "validate-mesh", "fix-normals", "normalize-origin", "normalize-materials",
    "fix-ground-contact", "export-glb",
    "render-turntable", "render-passes",
}


def diagnostic(severity, code, message):
    return {"severity": severity, "code": code, "message": message}


def safe_filename(value):
    cleaned = "".join(character if character.isalnum() or character in "-_" else "-" for character in str(value))[:120]
    return cleaned or "artifact"


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


def terrain_material_from_job(material_spec, terrain_size):
    """Build the fixed, non-generated triplanar terrain PBR node preset."""
    material = bpy.data.materials.new(f"WorldEngineTerrainPBR-{material_spec['id']}")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    coordinates = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    repeat = max(1.0, float(terrain_size) / float(material_spec["metersPerTile"]))
    mapping.inputs["Scale"].default_value = (repeat, repeat, repeat)
    material.node_tree.links.new(coordinates.outputs["Generated"], mapping.inputs["Vector"])

    def image_node(name, path, color):
        image = bpy.data.images.load(path, check_existing=False)
        image.colorspace_settings.name = "sRGB" if color else "Non-Color"
        node = nodes.new("ShaderNodeTexImage")
        node.name = name
        node.image = image
        node.projection = "BOX"
        node.projection_blend = 0.22
        node.extension = "REPEAT"
        material.node_tree.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
        return node

    base = image_node("WorldEngineBaseColor", material_spec["baseColorPath"], True)
    macro = image_node("WorldEngineMacroVariation", material_spec["macroVariationPath"], False)
    normal = image_node("WorldEngineNormal", material_spec["normalPath"], False)
    roughness = image_node("WorldEngineRoughness", material_spec["roughnessPath"], False)
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs["Fac"].default_value = 0.28
    material.node_tree.links.new(base.outputs["Color"], multiply.inputs[1])
    material.node_tree.links.new(macro.outputs["Color"], multiply.inputs[2])
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = 0.45
    material.node_tree.links.new(normal.outputs["Color"], normal_map.inputs["Color"])
    material.node_tree.links.new(multiply.outputs["Color"], principled.inputs["Base Color"])
    material.node_tree.links.new(roughness.outputs["Color"], principled.inputs["Roughness"])
    material.node_tree.links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
    material.node_tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    return material


def make_region_terrain(job):
    terrain = job["terrain"]
    samples = int(terrain["samples"])
    with open(terrain["heightfieldPath"], "rb") as handle:
        values = struct.unpack(f"<{samples * samples}f", handle.read(samples * samples * 4))
    stride = max(1, math.ceil((samples - 1) / 128))
    indexes = list(range(0, samples - 1, stride)) + [samples - 1]
    origin_x, origin_z = terrain["origin"]
    spacing = float(terrain["sizeMeters"]) / (samples - 1)
    vertices = [(origin_x + x * spacing, -(origin_z + z * spacing), values[z * samples + x]) for z in indexes for x in indexes]
    row = len(indexes)
    faces = []
    for z in range(row - 1):
        for x in range(row - 1):
            a = z * row + x
            faces.extend([(a, a + row, a + 1), (a + 1, a + row, a + row + 1)])
    mesh = bpy.data.meshes.new("WorldEngineRegionTerrain")
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new("WorldEngineRegionTerrain", mesh)
    bpy.context.scene.collection.objects.link(obj)
    material_specs = job.get("materials", [])
    if not material_specs:
        raise RuntimeError("refine-region requires at least one fixed terrain material set")
    material = terrain_material_from_job(material_specs[0], terrain["sizeMeters"])
    obj.data.materials.append(material)
    return obj, values


def nearest_height(job, values, world_x, world_z):
    terrain = job["terrain"]
    samples = int(terrain["samples"])
    spacing = float(terrain["sizeMeters"]) / (samples - 1)
    x = max(0, min(samples - 1, round((world_x - terrain["origin"][0]) / spacing)))
    z = max(0, min(samples - 1, round((world_z - terrain["origin"][1]) / spacing)))
    return float(values[z * samples + x])


def world_transform_matrix(transform):
    """Convert the canonical right-handed Y-up transform to Blender Z-up."""
    x, y, z = transform["position"]
    qx, qy, qz, qw = transform["rotation"]
    sx, sy, sz = transform["scale"]
    axis = Matrix(((1.0, 0.0, 0.0, 0.0), (0.0, 0.0, -1.0, 0.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0)))
    rotation = Quaternion((qw, qx, qy, qz)).to_matrix().to_4x4()
    scale = Matrix.Diagonal((sx, sy, sz, 1.0))
    return Matrix.Translation((x, -z, y)) @ axis @ rotation @ scale @ axis.inverted()


def setup_registered_camera(camera, resolution):
    data = bpy.data.cameras.new(camera["id"])
    obj = bpy.data.objects.new(camera["id"], data)
    bpy.context.scene.collection.objects.link(obj)
    position = camera["position"]
    target = camera["target"]
    obj.location = Vector((position[0], -position[2], position[1]))
    target_vector = Vector((target[0], -target[2], target[1]))
    obj.rotation_euler = (target_vector - obj.location).to_track_quat("-Z", "Y").to_euler()
    data.angle = math.radians(float(camera["verticalFovDegrees"]))
    scene = bpy.context.scene
    scene.camera = obj
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = int(resolution * float(camera["aspect"]))
    scene.render.resolution_y = int(resolution)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    return obj


def configure_region_world(environment, diagnostic_pass=False):
    world = bpy.context.scene.world
    if world is None:
        world = bpy.data.worlds.new("WorldEngineWorld")
        bpy.context.scene.world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputWorld")
    background = nodes.new("ShaderNodeBackground")
    background.inputs["Color"].default_value = (0.055, 0.075, 0.10, 1.0) if not diagnostic_pass else (0.0, 0.0, 0.0, 1.0)
    background.inputs["Strength"].default_value = 0.32 if not diagnostic_pass else 0.0
    world.node_tree.links.new(background.outputs["Background"], output.inputs["Surface"])
    fog_density = 0.0 if diagnostic_pass else float(environment.get("fogDensity", 0.0))
    if fog_density > 0:
        volume = nodes.new("ShaderNodeVolumePrincipled")
        volume.inputs["Density"].default_value = fog_density
        volume.inputs["Color"].default_value = (0.72, 0.79, 0.82, 1.0)
        world.node_tree.links.new(volume.outputs["Volume"], output.inputs["Volume"])


def apply_asset_transform(objects, source_matrices, transform):
    desired = world_transform_matrix(transform)
    for obj, source in zip(objects, source_matrices):
        obj.matrix_world = desired @ source


def projected_asset_bounds(objects, camera_object, width, height):
    scene = bpy.context.scene
    points = []
    for obj in objects:
        for corner in obj.bound_box:
            coordinate = world_to_camera_view(scene, camera_object, obj.matrix_world @ Vector(corner))
            if coordinate.z > 0:
                points.append((coordinate.x * width, (1.0 - coordinate.y) * height))
    if not points:
        raise RuntimeError("Asset projects no visible bounds into its registered camera")
    return (min(point[0] for point in points), min(point[1] for point in points), max(point[0] for point in points), max(point[1] for point in points))


def rotation_with_yaw(rotation, degrees):
    base = Quaternion((rotation[3], rotation[0], rotation[1], rotation[2]))
    adjusted = Quaternion((0.0, 1.0, 0.0), math.radians(degrees)) @ base
    return [adjusted.x, adjusted.y, adjusted.z, adjusted.w]


def fit_asset_projection(objects, source_matrices, transform, placement_target, camera_spec, target_height):
    """Fit bounded uniform scale/yaw against the real imported mesh projection."""
    camera = setup_registered_camera(camera_spec, int(placement_target["sourceHeight"]))
    scene = bpy.context.scene
    scene.render.resolution_x = int(placement_target["sourceWidth"])
    scene.render.resolution_y = int(placement_target["sourceHeight"])
    target = placement_target["screenBox"]
    target_aspect = float(target["width"]) / float(target["height"])
    best = None
    for yaw in (-30.0, -15.0, 0.0, 15.0, 30.0):
        candidate = dict(transform)
        candidate["rotation"] = rotation_with_yaw(transform["rotation"], yaw)
        apply_asset_transform(objects, source_matrices, candidate)
        low, _ = world_bounds(objects)
        candidate["position"] = [transform["position"][0], transform["position"][1] + target_height - low.z, transform["position"][2]]
        apply_asset_transform(objects, source_matrices, candidate)
        bounds = projected_asset_bounds(objects, camera, placement_target["sourceWidth"], placement_target["sourceHeight"])
        width = max(1e-5, bounds[2] - bounds[0])
        height = max(1e-5, bounds[3] - bounds[1])
        score = abs(math.log(max(1e-5, width / height) / target_aspect))
        if best is None or score < best[0]:
            best = (score, candidate, width, height)
    corrected = best[1]
    scale_factor = max(0.25, min(4.0, math.sqrt((float(target["width"]) * float(target["height"])) / (best[2] * best[3]))))
    corrected["scale"] = [value * scale_factor for value in corrected["scale"]]
    apply_asset_transform(objects, source_matrices, corrected)
    low, _ = world_bounds(objects)
    corrected["position"] = [corrected["position"][0], corrected["position"][1] + target_height - low.z, corrected["position"][2]]
    apply_asset_transform(objects, source_matrices, corrected)
    bpy.data.objects.remove(camera, do_unlink=True)
    return corrected


def evaluate_asset_silhouette(objects, placement_target, camera_spec, directory, asset_id):
    scene = bpy.context.scene
    camera = setup_registered_camera(camera_spec, int(placement_target["sourceHeight"]))
    scene.render.resolution_x = int(placement_target["sourceWidth"])
    scene.render.resolution_y = int(placement_target["sourceHeight"])
    previous_transparency = scene.render.film_transparent
    scene.render.film_transparent = True
    all_meshes = mesh_objects()
    hidden = [(obj, obj.hide_render) for obj in all_meshes]
    for obj in all_meshes:
        obj.hide_render = obj not in objects
    configure_region_world({"timeOfDay": 12.0, "fogDensity": 0.0}, True)
    artifact_id = safe_filename(asset_id)
    path = os.path.join(directory, f"{artifact_id}-silhouette.png")
    try:
        render_override(objects, path, [emission_material(f"WorldEngineSilhouette-{artifact_id}-{index}", (1.0, 1.0, 1.0)) for index in range(len(objects))])
    finally:
        for obj, was_hidden in hidden:
            obj.hide_render = was_hidden
        scene.render.film_transparent = previous_transparency
        bpy.data.objects.remove(camera, do_unlink=True)
    candidate = bpy.data.images.load(path, check_existing=False)
    target = bpy.data.images.load(placement_target["maskPath"], check_existing=False)
    width = int(placement_target["sourceWidth"])
    height = int(placement_target["sourceHeight"])
    if tuple(candidate.size) != (width, height) or tuple(target.size) != (width, height):
        raise RuntimeError("Silhouette render and SAM target mask must match the registered camera dimensions")
    candidate_pixels = list(candidate.pixels)
    target_pixels = list(target.pixels)
    intersection = union = target_count = candidate_count = 0
    target_x = target_y = candidate_x = candidate_y = 0.0
    for index in range(width * height):
        offset = index * 4
        target_on = max(target_pixels[offset], target_pixels[offset + 1], target_pixels[offset + 2]) > 0.5
        candidate_on = max(candidate_pixels[offset], candidate_pixels[offset + 1], candidate_pixels[offset + 2], candidate_pixels[offset + 3]) > 0.5
        if target_on and candidate_on:
            intersection += 1
        if target_on or candidate_on:
            union += 1
        x = index % width
        y = index // width
        if target_on:
            target_x += x
            target_y += y
            target_count += 1
        if candidate_on:
            candidate_x += x
            candidate_y += y
            candidate_count += 1
    bpy.data.images.remove(candidate)
    bpy.data.images.remove(target)
    iou = 1.0 if union == 0 else float(intersection) / float(union)
    center_error = 1.0e9 if target_count == 0 or candidate_count == 0 else math.hypot(target_x / target_count - candidate_x / candidate_count, target_y / target_count - candidate_y / candidate_count)
    return iou, center_error, path


def render_region_passes(objects, terrain_object, cameras, directory, resolution, environment):
    outputs = []
    sun_data = bpy.data.lights.new("WorldEngineSun", "SUN")
    time_of_day = float(environment.get("timeOfDay", 16.5))
    daylight = max(0.08, math.sin((time_of_day - 6.0) / 12.0 * math.pi))
    sun_data.energy = 0.4 + daylight * 3.2
    sun = bpy.data.objects.new("WorldEngineSun", sun_data)
    bpy.context.scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(18 + daylight * 42), 0.0, (time_of_day / 24.0) * math.pi * 2.0)
    for camera in cameras:
        camera_object = setup_registered_camera(camera, resolution)
        camera_file_id = safe_filename(camera["id"])
        configure_region_world(environment, False)
        rgb_path = os.path.join(directory, f"{camera_file_id}-rgb.png")
        bpy.context.scene.render.filepath = rgb_path
        bpy.ops.render.render(write_still=True)
        outputs.append({"kind": "blender-rgb", "cameraId": camera["id"], "path": rgb_path})
        configure_region_world(environment, True)
        low, high = world_bounds(objects)
        extent = max((high - low).length, 1.0)
        normal_path = os.path.join(directory, f"{camera_file_id}-normal.png")
        render_override(objects, normal_path, [normal_material()] * len(objects))
        outputs.append({"kind": "blender-normal", "cameraId": camera["id"], "path": normal_path})
        depth_path = os.path.join(directory, f"{camera_file_id}-depth.png")
        render_override(objects, depth_path, [depth_material(0.01, extent * 12)] * len(objects))
        outputs.append({"kind": "blender-depth", "cameraId": camera["id"], "path": depth_path})
        semantic_path = os.path.join(directory, f"{camera_file_id}-semantic.png")
        semantic_materials = [emission_material("WorldEngineSemanticTerrain", (0.12, 0.65, 0.18)) if obj == terrain_object else emission_material(f"WorldEngineSemanticAsset{index}", (0.72, 0.32, 0.12)) for index, obj in enumerate(objects)]
        render_override(objects, semantic_path, semantic_materials)
        outputs.append({"kind": "blender-semantic", "cameraId": camera["id"], "path": semantic_path})
        palette = [((index * 73 % 251) / 250.0, (index * 151 % 251) / 250.0, (index * 199 % 251) / 250.0) for index in range(1, len(objects) + 1)]
        instance_path = os.path.join(directory, f"{camera_file_id}-instance.png")
        render_override(objects, instance_path, [emission_material(f"WorldEngineRegionInstance{index}", color) for index, color in enumerate(palette)])
        outputs.append({"kind": "blender-instance", "cameraId": camera["id"], "path": instance_path})
        bpy.data.objects.remove(camera_object, do_unlink=True)
    return outputs


def refine_region(job):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    terrain_object, heights = make_region_terrain(job)
    transforms = []
    terrain_edits = []
    silhouette_renders = []
    diagnostics = []
    for asset in job.get("assets", []):
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=asset["path"])
        imported = [obj for obj in bpy.context.scene.objects if obj not in before and obj.type == "MESH"]
        if not imported:
            diagnostics.append(diagnostic("error", "REGION_ASSET_EMPTY", f"{asset['id']} imported no mesh"))
            continue
        transform = asset["transform"]
        source_matrices = [obj.matrix_world.copy() for obj in imported]
        x, old_y, z = transform["position"]
        target_y = nearest_height(job, heights, x, z)
        for obj in imported:
            for polygon in obj.data.polygons:
                polygon.use_smooth = True
        normalize_materials(imported)
        placement_target = asset["placementTarget"]
        camera_spec = next((camera for camera in job["cameras"] if camera["id"] == placement_target["cameraId"]), None)
        if camera_spec is None:
            diagnostics.append(diagnostic("error", "PLACEMENT_CAMERA_MISSING", f"{asset['id']} has no registered placement camera"))
            continue
        corrected = fit_asset_projection(imported, source_matrices, transform, placement_target, camera_spec, target_y)
        low, high = world_bounds(imported)
        contact_delta = target_y - low.z
        corrected["position"] = [corrected["position"][0], corrected["position"][1] + contact_delta, corrected["position"][2]]
        apply_asset_transform(imported, source_matrices, corrected)
        low, high = world_bounds(imported)
        radius_x = max(0.25, (high.x - low.x) * 0.5)
        radius_z = max(0.25, (high.y - low.y) * 0.5)
        contact_error = abs(low.z - target_y)
        silhouette_iou, center_error, silhouette_path = evaluate_asset_silhouette(imported, placement_target, camera_spec, job["renderDirectory"], asset["id"])
        transforms.append({"id": asset["id"], "transform": corrected, "contactErrorMeters": contact_error, "silhouetteIou": silhouette_iou, "centerErrorPixels": center_error})
        silhouette_renders.append({"kind": "blender-instance", "cameraId": f"{camera_spec['id']}:silhouette:{asset['id']}", "path": silhouette_path})
        if silhouette_iou < 0.85 or center_error > 4.0:
            diagnostics.append(diagnostic("error", "SILHOUETTE_GATE", f"{asset['id']} silhouette IoU {silhouette_iou:.4f}, center error {center_error:.3f}px"))
        terrain_edits.append({"footprint": [[x - radius_x, z - radius_z], [x + radius_x, z - radius_z], [x + radius_x, z + radius_z], [x - radius_x, z + radius_z]], "targetHeight": target_y, "supportMarginMeters": 2, "falloffEndMeters": 5})
    objects = mesh_objects()
    renders = silhouette_renders + render_region_passes(objects, terrain_object, job["cameras"], job["renderDirectory"], int(job["renderResolution"]), job.get("environment", {"timeOfDay": 16.5, "fogDensity": 0.0}))
    with open(job["resultPath"], "w", encoding="utf-8") as handle:
        json.dump({"workerVersion": "blender-5.1-worker-1.1.0", "transforms": transforms, "terrainEdits": terrain_edits, "renders": renders, "diagnostics": diagnostics}, handle)


def main(job_path):
    with open(job_path, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    if job.get("operation") == "refine-region":
        refine_region(job)
        return
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
