import type { RegionSpec, TerrainLandformOperator, TerrainPlan, Vec2 } from '@worldengine/schema';
import { fbm2 } from './noise.js';
import { hash32 } from './random.js';

function pointInPolygon(x: number, z: number, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!; const b = polygon[previous]!;
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x: number, z: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]; const dz = b[1] - a[1]; const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared));
  return Math.hypot(x - (a[0] + dx * amount), z - (a[1] + dz * amount));
}

export function distanceToPolygon(point: Vec2, polygon: readonly Vec2[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) distance = Math.min(distance, distanceToSegment(point[0], point[1], polygon[previous]!, polygon[current]!));
  return distance;
}

/** A world-space soft mask. Evaluating only world coordinates makes adjacent
 * chunk borders byte-identical regardless of compile order. */
export function softRegionMask(region: Pick<RegionSpec, 'polygon'>, point: Vec2, blendMeters: number): number {
  if (!(blendMeters > 0)) throw new Error('Region blend width must be positive');
  const distance = distanceToPolygon(point, region.polygon);
  if (pointInPolygon(point[0], point[1], region.polygon)) return Math.min(1, 0.5 + distance / blendMeters);
  if (distance >= blendMeters) return 0;
  const amount = 1 - distance / blendMeters;
  return amount * amount * (3 - 2 * amount) * 0.5;
}

export function evaluateLandformOperator(operator: TerrainLandformOperator, seed: number, worldX: number, worldZ: number): number {
  const scale = operator.scaleMeters;
  const x = (worldX - operator.offset[0]) / scale;
  const z = (worldZ - operator.offset[1]) / scale;
  const noiseSeed = hash32(hash32(seed, Math.round(operator.offset[0]), Math.round(operator.offset[1])), operator.kind.length);
  const broad = fbm2(noiseSeed, x, z, operator.octaves);
  let value: number;
  switch (operator.kind) {
    case 'ridge': value = (1 - Math.abs(broad)) ** 2 * 2 - 0.65; break;
    case 'peak': value = Math.exp(-(x * x + z * z) * 1.6) * 1.7 - 0.18 + broad * 0.18; break;
    case 'dune': value = Math.sin((x + broad * 0.35) * Math.PI * 2) * 0.58 + Math.sin((z - x * 0.28) * Math.PI) * 0.22; break;
    case 'terrace': {
      const steps = operator.terraceSteps ?? 8;
      value = Math.round(broad * steps) / steps;
      break;
    }
    case 'erosion': {
      const detail = Math.abs(fbm2(noiseSeed ^ 0x9e3779b9, x * 4.2, z * 4.2, Math.min(6, operator.octaves + 1)));
      value = broad * 0.46 - detail * 0.54;
      break;
    }
    case 'riverbed': value = -Math.exp(-Math.abs(broad) * 12); break;
    case 'plateau': value = Math.tanh((broad + 0.08) * 5) * 0.55; break;
  }
  return value * operator.strength;
}

export function sampleTerrainPlanHeight(plan: TerrainPlan, regions: readonly RegionSpec[], seed: number, worldX: number, worldZ: number): number | undefined {
  const weighted: Array<{ height: number; weight: number }> = [];
  for (const regionPlan of plan.regions) {
    const region = regions.find((candidate) => candidate.id === regionPlan.regionId);
    if (!region) continue;
    const weight = softRegionMask(region, [worldX, worldZ], plan.maskBlendMeters);
    if (weight <= 0) continue;
    const midpoint = (region.elevation.min + region.elevation.max) / 2;
    const relief = Math.max(1, (region.elevation.max - region.elevation.min) / 2);
    const normalized = regionPlan.operators.reduce((sum, operator, index) => sum + evaluateLandformOperator(operator, hash32(seed, index, regions.indexOf(region)), worldX, worldZ), 0);
    weighted.push({ height: Math.max(region.elevation.min, Math.min(region.elevation.max, midpoint + normalized * relief)), weight });
  }
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  return total > 0 ? weighted.reduce((sum, entry) => sum + entry.height * entry.weight, 0) / total : undefined;
}

export interface CompiledTerrainChunk {
  heights: Float32Array;
  minHeight: number;
  maxHeight: number;
  splats: Array<{ materialSetId: string; weights: Uint8Array }>;
}

export function compileTerrainPlanChunk(options: {
  plan: TerrainPlan;
  regions: readonly RegionSpec[];
  seed: number;
  coordinate: { x: number; z: number };
  chunkSize: number;
  samples: number;
  fallbackHeight: (x: number, z: number) => number;
}): CompiledTerrainChunk {
  if (!Number.isInteger(options.samples) || options.samples < 3) throw new Error('Compiled heightfield requires at least three samples');
  const heights = new Float32Array(options.samples ** 2);
  const splats = options.plan.materialSets.map((material) => ({ materialSetId: material.id, weights: new Uint8Array(options.samples ** 2) }));
  const spacing = options.chunkSize / (options.samples - 1);
  let minHeight = Number.POSITIVE_INFINITY; let maxHeight = Number.NEGATIVE_INFINITY;
  for (let zIndex = 0; zIndex < options.samples; zIndex += 1) for (let xIndex = 0; xIndex < options.samples; xIndex += 1) {
    const x = options.coordinate.x * options.chunkSize + xIndex * spacing;
    const z = options.coordinate.z * options.chunkSize + zIndex * spacing;
    const index = zIndex * options.samples + xIndex;
    const planned = sampleTerrainPlanHeight(options.plan, options.regions, options.seed, x, z);
    const height = planned ?? options.fallbackHeight(x, z);
    heights[index] = height; minHeight = Math.min(minHeight, height); maxHeight = Math.max(maxHeight, height);
    const materialWeights = options.plan.materialSets.map((material) => {
      const region = options.regions.find((candidate) => candidate.biome === material.biome);
      return region ? softRegionMask(region, [x, z], options.plan.maskBlendMeters) : 0;
    });
    const total = materialWeights.reduce((sum, weight) => sum + weight, 0);
    materialWeights.forEach((weight, materialIndex) => { splats[materialIndex]!.weights[index] = total > 0 ? Math.round(weight / total * 255) : 0; });
  }
  return { heights, minHeight, maxHeight, splats };
}

export interface TerrainFootprintRefinement {
  footprint: readonly Vec2[];
  targetHeight: number;
  mode: 'raise' | 'lower' | 'flatten' | 'smooth';
  supportMarginMeters?: number;
  falloffEndMeters?: number;
}

export function coDeformHeightfield(options: {
  heights: Float32Array;
  samples: number;
  origin: Vec2;
  sizeMeters: number;
  refinement: TerrainFootprintRefinement;
}): Float32Array {
  if (options.heights.length !== options.samples ** 2) throw new Error('Heightfield dimensions do not match samples');
  if (options.refinement.footprint.length < 3) throw new Error('Mesh footprint requires at least three points');
  const supportMargin = options.refinement.supportMarginMeters ?? 2;
  const falloffEnd = options.refinement.falloffEndMeters ?? 5;
  if (supportMargin < 0 || falloffEnd <= supportMargin) throw new Error('Terrain support falloff must end beyond its support margin');
  const output = new Float32Array(options.heights);
  const spacing = options.sizeMeters / (options.samples - 1);
  for (let zIndex = 0; zIndex < options.samples; zIndex += 1) for (let xIndex = 0; xIndex < options.samples; xIndex += 1) {
    const index = zIndex * options.samples + xIndex;
    const point: Vec2 = [options.origin[0] + xIndex * spacing, options.origin[1] + zIndex * spacing];
    const inside = pointInPolygon(point[0], point[1], options.refinement.footprint);
    const distance = inside ? 0 : distanceToPolygon(point, options.refinement.footprint);
    if (distance >= falloffEnd) continue;
    const falloff = distance <= supportMargin ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (distance - supportMargin) / (falloffEnd - supportMargin));
    const current = options.heights[index]!;
    let target = options.refinement.targetHeight;
    if (options.refinement.mode === 'raise') target = Math.max(current, target);
    if (options.refinement.mode === 'lower') target = Math.min(current, target);
    if (options.refinement.mode === 'smooth') target = current + (target - current) * 0.5;
    output[index] = current + (target - current) * falloff;
  }
  return output;
}

export function maximumHeightfieldSeamError(a: Float32Array, b: Float32Array, samples: number, edge: 'x' | 'z'): number {
  if (a.length !== samples ** 2 || b.length !== samples ** 2) throw new Error('Seam inputs do not match sample dimensions');
  let maximum = 0;
  for (let index = 0; index < samples; index += 1) {
    const aIndex = edge === 'x' ? index * samples + samples - 1 : (samples - 1) * samples + index;
    const bIndex = edge === 'x' ? index * samples : index;
    maximum = Math.max(maximum, Math.abs(a[aIndex]! - b[bIndex]!));
  }
  return maximum;
}
