import { z } from 'zod';
import { TransformSchema, Vec2Schema, Vec3Schema, WorldPatchSchema, type RegionSpec, type Vec2, type Vec3, type WorldPatch } from '@worldengine/schema';

export interface RasterMask {
  width: number;
  height: number;
  values: Uint16Array;
  regionIds: string[];
}

export function rasterizeRegions(
  regions: readonly Pick<RegionSpec, 'id' | 'polygon'>[],
  bounds: { min: Vec2; max: Vec2 },
  width: number,
  height: number,
): RasterMask {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Raster dimensions must be positive integers');
  if (regions.length > 65_534) throw new Error('Raster mask supports at most 65,534 regions');
  const values = new Uint16Array(width * height);
  const spanX = bounds.max[0] - bounds.min[0];
  const spanZ = bounds.max[1] - bounds.min[1];
  regions.forEach((region, regionIndex) => {
    for (let row = 0; row < height; row += 1) {
      const z = bounds.min[1] + ((row + 0.5) / height) * spanZ;
      for (let column = 0; column < width; column += 1) {
        const index = row * width + column;
        if (values[index] !== 0) continue;
        const x = bounds.min[0] + ((column + 0.5) / width) * spanX;
        if (pointInPolygon([x, z], region.polygon)) values[index] = regionIndex + 1;
      }
    }
  });
  return { width, height, values, regionIds: regions.map((region) => region.id) };
}

export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    const crosses = (a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

export interface ReferenceCamera {
  id: string;
  position: Vec3;
  target: Vec3;
  up: Vec3;
  verticalFovDegrees: number;
  aspect: number;
  width: number;
  height: number;
}

export function referenceCamerasForRegion(region: Pick<RegionSpec, 'id' | 'polygon' | 'elevation'>, count = 3): ReferenceCamera[] {
  const minX = Math.min(...region.polygon.map((point) => point[0]));
  const maxX = Math.max(...region.polygon.map((point) => point[0]));
  const minZ = Math.min(...region.polygon.map((point) => point[1]));
  const maxZ = Math.max(...region.polygon.map((point) => point[1]));
  const center: Vec3 = [(minX + maxX) / 2, (region.elevation.min + region.elevation.max) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(maxX - minX, maxZ - minZ) * 0.75;
  return Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2 + Math.PI / 4;
    return {
      id: `${region.id}:reference:${index}`,
      position: [center[0] + Math.cos(angle) * radius, center[1] + radius * 0.78, center[2] + Math.sin(angle) * radius],
      target: center, up: [0, 1, 0], verticalFovDegrees: 48, aspect: 3 / 2, width: 1536, height: 1024,
    };
  });
}

export const ObjectDescriptorSchema = z.object({
  id: z.string().min(1),
  assetClass: z.string().min(1),
  description: z.string().min(1),
  screenBox: z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() }),
  desiredHeightMeters: z.number().positive(),
  isolatedReferenceUri: z.string().url().optional(),
  tags: z.array(z.string()).default([]),
});
export type ObjectDescriptor = z.infer<typeof ObjectDescriptorSchema>;

export function rayFromScreen(camera: ReferenceCamera, pixel: Vec2): { origin: Vec3; direction: Vec3 } {
  const forward = normalize(subtract(camera.target, camera.position));
  const right = normalize(cross(forward, camera.up));
  const up = normalize(cross(right, forward));
  const tangent = Math.tan((camera.verticalFovDegrees * Math.PI) / 360);
  const ndcX = (pixel[0] / camera.width) * 2 - 1;
  const ndcY = 1 - (pixel[1] / camera.height) * 2;
  const direction = normalize(add(forward, add(scale(right, ndcX * tangent * camera.aspect), scale(up, ndcY * tangent))));
  return { origin: [...camera.position], direction };
}

export function raycastTerrain(
  ray: { origin: Vec3; direction: Vec3 },
  sampleHeight: (x: number, z: number) => number,
  maxDistance = 10_000,
  step = 8,
): Vec3 | undefined {
  let previousDistance = 0;
  let previousAbove = ray.origin[1] - sampleHeight(ray.origin[0], ray.origin[2]);
  for (let distance = step; distance <= maxDistance; distance += step) {
    const point = add(ray.origin, scale(ray.direction, distance));
    const above = point[1] - sampleHeight(point[0], point[2]);
    if (above <= 0 && previousAbove > 0) {
      let low = previousDistance;
      let high = distance;
      for (let iteration = 0; iteration < 16; iteration += 1) {
        const middle = (low + high) / 2;
        const sample = add(ray.origin, scale(ray.direction, middle));
        if (sample[1] > sampleHeight(sample[0], sample[2])) low = middle; else high = middle;
      }
      const hit = add(ray.origin, scale(ray.direction, (low + high) / 2));
      return [hit[0], sampleHeight(hit[0], hit[2]), hit[2]];
    }
    previousDistance = distance;
    previousAbove = above;
  }
  return undefined;
}

export function placeObjectFromComposition(descriptorInput: ObjectDescriptor, camera: ReferenceCamera, sampleHeight: (x: number, z: number) => number): z.infer<typeof TransformSchema> {
  const descriptor = ObjectDescriptorSchema.parse(descriptorInput);
  const center: Vec2 = [descriptor.screenBox.x + descriptor.screenBox.width / 2, descriptor.screenBox.y + descriptor.screenBox.height];
  const hit = raycastTerrain(rayFromScreen(camera, center), sampleHeight);
  if (!hit) throw new Error(`Object ${descriptor.id} screen-space ray did not intersect terrain`);
  const projectedFraction = descriptor.screenBox.height / camera.height;
  const distance = length(subtract(hit, camera.position));
  const projectedMeters = 2 * distance * Math.tan((camera.verticalFovDegrees * Math.PI) / 360) * projectedFraction;
  const uniformScale = Math.max(0.05, Math.min(20, descriptor.desiredHeightMeters / Math.max(projectedMeters, 0.001)));
  return TransformSchema.parse({ position: hit, rotation: [0, 0, 0, 1], scale: [uniformScale, uniformScale, uniformScale] });
}

export function validateVisualReviewPatch(input: unknown, worldId: string, baseRevision: number): WorldPatch {
  const patch = WorldPatchSchema.parse(input);
  if (patch.worldId !== worldId) throw new Error('Visual review patch targets a different world');
  if (patch.baseRevision !== baseRevision) throw new Error('Visual review patch targets a stale revision');
  if (patch.operations.length > 100) throw new Error('Visual review patches may contain at most 100 operations');
  const allowed = new Set(['set-transform', 'set-visual-state', 'set-environment']);
  const disallowed = patch.operations.filter((operation) => !allowed.has(operation.op));
  if (disallowed.length > 0) throw new Error('Visual review may only adjust existing transforms, visual states, or environment values');
  return patch;
}

function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(vector: Vec3, scalar: number): Vec3 { return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar]; }
function length(vector: Vec3): number { return Math.hypot(vector[0], vector[1], vector[2]); }
function normalize(vector: Vec3): Vec3 { const magnitude = length(vector); return magnitude === 0 ? [0, 0, 0] : scale(vector, 1 / magnitude); }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
