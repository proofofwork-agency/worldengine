import {
  ChunkIdSchema,
  EntityIdSchema,
  PrototypeIdSchema,
  RegionIdSchema,
  RuntimeChunkDocumentSchema,
  VisualWorldBundleSchema,
  WorldDesignSpecSchema,
  chunkId,
  type ChunkCoordinate,
  type RuntimeChunkDocument,
  type RuntimeInstance,
  type TerrainSource,
  type VisualWorldBundle,
  type WorldDesignSpec,
} from '@worldengine/schema';
import { encodeFloat32, encodeUint8 } from './encoding.js';
import { fbm2 } from './noise.js';
import { createRandom, hash32 } from './random.js';
import { sha256Hex } from './sha256.js';
import { sampleTerrainHeight } from './terrain.js';

const createdAt = '2026-01-01T00:00:00.000Z';
const prototypeKinds = [
  'oak', 'pine', 'birch', 'willow', 'boulder', 'standing-stone', 'ruin-column', 'ruin-wall',
  'cottage', 'watchtower', 'dock', 'boat', 'reed', 'wildflower', 'fern', 'mushroom',
  'market-stall', 'lantern', 'bridge', 'windmill',
] as const;

export const REFERENCE_SEED = 0x51f15eed;
export const REFERENCE_BOUNDS = { min: [-2048, -2048] as [number, number], max: [2048, 2048] as [number, number] };
export const REFERENCE_TERRAIN: TerrainSource = {
  kind: 'procedural',
  seed: REFERENCE_SEED,
  amplitude: 72,
  frequency: 1 / 900,
  edits: [],
};

export function createReferenceDesignSpec(seed = REFERENCE_SEED): WorldDesignSpec {
  return WorldDesignSpecSchema.parse({
    format: 'WorldDesignSpec',
    version: '1.1.0',
    id: `reference-design-${seed}`,
    seed,
    prompt: 'A temperate coastal valley with highlands, forest, wetlands, ruins, and a settled river plain.',
    title: 'The Aster Vale',
    units: 'meters',
    coordinateSystem: 'right-handed-y-up',
    bounds: REFERENCE_BOUNDS,
    chunkSize: 256,
    terrainSamples: 257,
    style: { description: 'Style-neutral natural PBR materials with readable silhouettes', rendering: 'pbr', palette: ['#9bb174', '#496b4b', '#7d8d92', '#c5a870'] },
    environment: { timeOfDay: 16.5, latitude: 52, weather: 'clear', waterLevel: -8, fogDensity: 0.00042, wind: [1.5, 0, 0.4] },
    regions: [
      { id: RegionIdSchema.parse('coast'), name: 'Western Coast', polygon: [[-2048,-2048],[-900,-2048],[-700,2048],[-2048,2048]], biome: 'coastal', elevation: { min: -15, max: 28 }, density: 0.32, adjacentTo: [RegionIdSchema.parse('wetlands'), RegionIdSchema.parse('forest')] },
      { id: RegionIdSchema.parse('wetlands'), name: 'River Wetlands', polygon: [[-900,-1200],[500,-900],[650,700],[-700,900]], biome: 'wetland', elevation: { min: -8, max: 18 }, density: 0.7, adjacentTo: [RegionIdSchema.parse('coast'), RegionIdSchema.parse('settled'), RegionIdSchema.parse('forest')] },
      { id: RegionIdSchema.parse('forest'), name: 'Old Forest', polygon: [[-700,700],[700,550],[1250,2048],[-700,2048]], biome: 'temperate-forest', elevation: { min: 8, max: 90 }, density: 0.88, adjacentTo: [RegionIdSchema.parse('coast'), RegionIdSchema.parse('wetlands'), RegionIdSchema.parse('highlands')] },
      { id: RegionIdSchema.parse('settled'), name: 'Settled Plain', polygon: [[400,-1000],[2048,-950],[2048,600],[650,700]], biome: 'grassland', elevation: { min: 0, max: 42 }, density: 0.48, adjacentTo: [RegionIdSchema.parse('wetlands'), RegionIdSchema.parse('highlands')] },
      { id: RegionIdSchema.parse('highlands'), name: 'Eastern Highlands', polygon: [[1250,500],[2048,550],[2048,2048],[700,2048]], biome: 'highland', elevation: { min: 35, max: 150 }, density: 0.25, adjacentTo: [RegionIdSchema.parse('forest'), RegionIdSchema.parse('settled')] },
    ],
    features: [
      { id: 'river-aster', kind: 'river', points: [[-620, 2048], [-420, 1120], [-180, 420], [120, -180], [420, -920], [720, -2048]], width: 44, depth: 7, tags: ['navigable-visual'] },
      { id: 'road-old-bridge', kind: 'road', points: [[-420, -1240], [80, -720], [580, -180], [1120, 180], [1680, 420]], width: 18, depth: 0, tags: ['settlement-route'] },
      { id: 'western-shore', kind: 'coastline', points: [[-760, -2048], [-820, -1024], [-720, 0], [-760, 1024], [-680, 2048]], width: 36, depth: 2, tags: ['ocean'] },
    ],
    landmarks: [
      { id: 'sunken-ruin', name: 'Sunken Ruin', position: [-180, 4, 240], description: 'Stone remnants at the wetland edge.' },
      { id: 'east-watch', name: 'East Watch', position: [1470, 84, 940], description: 'A watchtower overlooking the vale.' },
      { id: 'old-bridge', name: 'Old Bridge', position: [580, 8, -180], description: 'The main crossing into the settled plain.' },
    ],
    assetRequirements: prototypeKinds.map((kind) => ({ class: kind, count: 1, sourcePreference: ['library', 'cache', 'generate'], tags: [] })),
    constraints: ['Keep every placed object in terrain contact', 'Preserve clear regional silhouettes'],
    defaultsApplied: [],
  });
}

export function createReferenceBundle(seed = REFERENCE_SEED): VisualWorldBundle {
  const prototypes = prototypeKinds.map((kind, index) => ({
    id: PrototypeIdSchema.parse(`prototype-${String(index + 1).padStart(2, '0')}-${kind}`),
    assetUri: `primitive://${kind}`,
    contentHash: sha256Hex(`primitive:${kind}:v1`),
    textureFormat: 'none' as const,
    lods: [],
    materialVariants: ['default', 'seasonal'],
    animationClips: kind === 'windmill' ? ['turn'] : [],
    boundsRadius: ['cottage', 'watchtower', 'windmill'].includes(kind) ? 12 : 3,
    tags: [kind],
  }));
  const chunks = [];
  for (let z = -8; z < 8; z += 1) {
    for (let x = -8; x < 8; x += 1) {
      const id = chunkId(x, z);
      chunks.push({
        id,
        coordinate: { x, z },
        bounds: { min: [x * 256, z * 256], max: [(x + 1) * 256, (z + 1) * 256] },
        source: {
          kind: 'procedural' as const,
          seed: hash32(seed, x, z),
          generator: 'worldengine-terrain-v1' as const,
          contentHash: sha256Hex(JSON.stringify({ generator: 'worldengine-terrain-v1', seed, x, z, chunkSize: 256, terrainSamples: 257 })),
        },
        dependencies: [],
      });
    }
  }
  const design = createReferenceDesignSpec(seed);
  const base = VisualWorldBundleSchema.parse({
    format: 'VisualWorldBundle', version: '1.1.0', id: `aster-vale-v1-${seed}`, worldId: 'aster-vale', bundleVersion: 1,
    immutable: true, createdAt, seed, coordinateSystem: 'right-handed-y-up', units: 'meters', bounds: REFERENCE_BOUNDS,
    chunkSize: 256, terrainSamples: 257,
    terrain: { ...REFERENCE_TERRAIN, seed },
    regions: design.regions,
    features: design.features,
    style: design.style,
    environment: design.environment,
    prototypes,
    chunks,
    provenance: prototypes.map((prototype) => ({
      id: `provenance-${prototype.id}`, subjectId: prototype.id, kind: 'procedural',
      license: { name: 'Apache-2.0 project-authored placeholder', commercialUse: true },
      createdAt, contentHash: prototype.contentHash, parentIds: [], reviewedAt: createdAt,
    })),
    sourceRevision: 0,
    optimization: { meshLods: false, textureFormat: 'source', instanceGroups: true, occlusionMetadata: true, terrainLodSamples: [65, 33, 17], occlusionCellSize: 64 },
  });
  const landmarkKinds = ['ruin-wall', 'watchtower', 'bridge'] as const;
  const authoredInstances = design.landmarks.map((landmark, index) => {
    const prototype = base.prototypes.find((candidate) => candidate.tags.includes(landmarkKinds[index]!)) ?? base.prototypes[index]!;
    const chunkX = Math.floor(landmark.position[0] / base.chunkSize);
    const chunkZ = Math.floor(landmark.position[2] / base.chunkSize);
    const y = sampleWorldHeight(base, landmark.position[0], landmark.position[2]);
    return {
      id: EntityIdSchema.parse(`entity-${chunkX}-${chunkZ}-0`),
      prototypeId: prototype.id,
      matrix: composeMatrix(landmark.position[0], y, landmark.position[2], (hash32(seed, index, 0x51f15eed) / 0xffffffff) * Math.PI * 2, 1.08),
      visualState: { authored: true, landmark: true, landmarkId: landmark.id, label: landmark.name },
    };
  });
  return VisualWorldBundleSchema.parse({ ...base, authoredInstances });
}

function composeMatrix(x: number, y: number, z: number, yaw: number, scale: number): RuntimeInstance['matrix'] {
  const cosine = Math.cos(yaw) * scale;
  const sine = Math.sin(yaw) * scale;
  return [cosine, 0, -sine, 0, 0, scale, 0, 0, sine, 0, cosine, 0, x, y, z, 1];
}

function pointInPolygon(x: number, z: number, polygon: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function nearestPointOnSegment(x: number, z: number, start: readonly [number, number], end: readonly [number, number]): { x: number; z: number; distance: number } {
  const deltaX = end[0] - start[0];
  const deltaZ = end[1] - start[1];
  const lengthSquared = deltaX * deltaX + deltaZ * deltaZ;
  const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - start[0]) * deltaX + (z - start[1]) * deltaZ) / lengthSquared));
  const nearestX = start[0] + deltaX * amount;
  const nearestZ = start[1] + deltaZ * amount;
  return { x: nearestX, z: nearestZ, distance: Math.hypot(x - nearestX, z - nearestZ) };
}

function distanceToPolygon(x: number, z: number, polygon: ReadonlyArray<readonly [number, number]>): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    distance = Math.min(distance, nearestPointOnSegment(x, z, polygon[previous]!, polygon[current]!).distance);
  }
  return distance;
}

function regionalLandform(bundle: VisualWorldBundle, regionIndex: number, x: number, z: number): number {
  const region = bundle.regions[regionIndex]!;
  const minimum = region.elevation.min;
  const maximum = Math.max(minimum, region.elevation.max);
  const midpoint = (minimum + maximum) / 2;
  const relief = Math.max(1, (maximum - minimum) / 2);
  const seed = hash32(bundle.seed, regionIndex, 0x6d2b79f5);
  const broad = fbm2(seed, x / 820, z / 820, 5);
  const detail = fbm2(seed ^ 0x9e3779b9, x / 240, z / 240, 3);
  const biome = region.biome.toLowerCase();
  let shape = broad * 0.72 + detail * 0.28;
  if (/highland|mountain|canyon|cliff/.test(biome)) {
    const ridge = 1 - Math.abs(fbm2(seed ^ 0x85ebca77, x / 680, z / 680, 5));
    shape = (ridge ** 2 * 2 - 0.72) * 0.82 + detail * 0.18;
  } else if (/desert|dune|arid/.test(biome)) {
    const dunes = Math.sin((x + broad * 160) / 92) * 0.58 + Math.sin((z - x * 0.24) / 155) * 0.25;
    shape = dunes * 0.74 + detail * 0.26;
  } else if (/volcan|lava|ash/.test(biome)) {
    const cone = 1 - Math.min(1, Math.hypot(x, z) / 2_400);
    const ridge = 1 - Math.abs(broad);
    shape = cone * 0.7 + ridge ** 3 * 0.65 + detail * 0.2 - 0.55;
  } else if (/wetland|coast|plain|grass/.test(biome)) {
    shape = broad * 0.32 + detail * 0.13;
  } else if (/forest|wood|grove/.test(biome)) {
    shape = broad * 0.55 + detail * 0.22;
  }
  return Math.max(minimum, Math.min(maximum, midpoint + shape * relief));
}

function terrainSource(bundle: VisualWorldBundle, terrainEdits?: TerrainSource['edits']): TerrainSource {
  const settings = bundle.terrain ?? { kind: 'procedural' as const, seed: bundle.seed, amplitude: REFERENCE_TERRAIN.amplitude, frequency: REFERENCE_TERRAIN.frequency, edits: [] };
  return { ...settings, edits: terrainEdits ?? settings.edits };
}

export function sampleWorldHeight(bundle: VisualWorldBundle, x: number, z: number, terrainEdits?: TerrainSource['edits']): number {
  const source = terrainSource(bundle, terrainEdits);
  const sourceWithoutEdits = source.edits.length === 0 ? source : { ...source, edits: [] };
  const globalHeight = sampleTerrainHeight(sourceWithoutEdits, x, z);
  const blendWidth = Math.max(64, bundle.chunkSize * 0.7);
  const weightedRegions = bundle.regions.map((region, index) => {
    const distance = distanceToPolygon(x, z, region.polygon);
    const inside = pointInPolygon(x, z, region.polygon);
    const weight = inside ? 1 + Math.min(3, distance / blendWidth) : distance < blendWidth ? (1 - distance / blendWidth) ** 2 : 0;
    return { index, weight };
  }).filter((entry) => entry.weight > 0);
  const totalWeight = weightedRegions.reduce((sum, entry) => sum + entry.weight, 0);
  let height = totalWeight > 0
    ? weightedRegions.reduce((sum, entry) => sum + regionalLandform(bundle, entry.index, x, z) * entry.weight, 0) / totalWeight * 0.86 + globalHeight * 0.14
    : globalHeight;
  for (const feature of bundle.features) {
    let nearest: { x: number; z: number; distance: number } | undefined;
    for (let index = 1; index < feature.points.length; index += 1) {
      const candidate = nearestPointOnSegment(x, z, feature.points[index - 1]!, feature.points[index]!);
      if (!nearest || candidate.distance < nearest.distance) nearest = candidate;
    }
    if (!nearest || nearest.distance >= feature.width) continue;
    const normalized = 1 - nearest.distance / feature.width;
    const influence = normalized * normalized * (3 - 2 * normalized);
    if (feature.kind === 'river') height -= feature.depth * influence;
    if (feature.kind === 'road') {
      const centerHeight = sampleTerrainHeight(source, nearest.x, nearest.z);
      height += (centerHeight - height) * influence * 0.82;
    }
    if (feature.kind === 'coastline') {
      const target = bundle.environment.waterLevel ?? height - feature.depth;
      height += (target - height) * influence * 0.72;
    }
  }
  for (const edit of source.edits) {
    const distance = Math.hypot(x - edit.center[0], z - edit.center[1]);
    if (distance < edit.radius) {
      const falloff = 0.5 + 0.5 * Math.cos(Math.PI * distance / edit.radius);
      if (edit.mode === 'flatten') height += (edit.targetHeight! - height) * falloff;
      else if (edit.mode === 'smooth') height += (edit.targetHeight! - height) * falloff * 0.5;
      else height += edit.delta * falloff;
    }
  }
  return height;
}

function prototypeCandidates(bundle: VisualWorldBundle, biome: string | undefined): VisualWorldBundle['prototypes'] {
  if (!biome) return bundle.prototypes;
  const keywords: Record<string, string[]> = {
    wetland: ['willow', 'reed', 'boat', 'dock'],
    'temperate-forest': ['oak', 'pine', 'birch', 'fern', 'mushroom'],
    coastal: ['boulder', 'dock', 'boat', 'reed'],
    grassland: ['cottage', 'market-stall', 'lantern', 'bridge', 'windmill', 'wildflower'],
    highland: ['pine', 'boulder', 'standing-stone', 'ruin-column', 'watchtower'],
    dunes: ['cactus', 'dry-shrub', 'sandstone-boulder', 'date-palm'],
    'salt-flat': ['sandstone-boulder', 'standing-stone', 'ruin-column'],
    'arid-scrub': ['acacia', 'cactus', 'dry-shrub', 'date-palm'],
    'desert-settlement': ['tent', 'market-stall', 'well', 'caravan-cart', 'lantern', 'windmill'],
    mesa: ['sandstone-boulder', 'archway', 'watchtower', 'standing-stone'],
    'ice-coast': ['ice-boulder', 'frozen-reed', 'boat', 'dock'],
    'frozen-wetland': ['frozen-reed', 'snow-shrub', 'ice-boulder'],
    'boreal-forest': ['spruce', 'pine', 'fir', 'snow-shrub'],
    'snow-settlement': ['cabin', 'sled', 'lantern', 'bridge', 'market-stall'],
    alpine: ['spruce', 'ice-boulder', 'standing-stone', 'watchtower'],
    'volcanic-coast': ['obsidian-boulder', 'basalt-column', 'dock', 'boat'],
    caldera: ['basalt-column', 'sulfur-vent', 'obsidian-boulder'],
    'burnt-forest': ['dead-tree', 'charred-pine', 'ash-shrub'],
    ashland: ['ash-shrub', 'ruin-wall', 'ruin-column', 'lantern'],
    'volcanic-highland': ['basalt-column', 'obsidian-boulder', 'watchtower', 'standing-stone'],
  };
  const desired = new Set(keywords[biome] ?? []);
  const matching = bundle.prototypes.filter((prototype) => prototype.tags.some((tag) => desired.has(tag)));
  return matching.length > 0 ? matching : bundle.prototypes;
}

interface PlacementContext {
  biome: string;
  roadDistance: number;
  riverDistance: number;
  coastlineDistance: number;
  slope: number;
}

function featureDistance(bundle: VisualWorldBundle, kind: VisualWorldBundle['features'][number]['kind'], x: number, z: number): number {
  let distance = Number.POSITIVE_INFINITY;
  for (const feature of bundle.features) {
    if (feature.kind !== kind) continue;
    for (let index = 1; index < feature.points.length; index += 1) distance = Math.min(distance, nearestPointOnSegment(x, z, feature.points[index - 1]!, feature.points[index]!).distance);
  }
  return distance;
}

function placementContext(bundle: VisualWorldBundle, biome: string | undefined, x: number, z: number, terrainEdits?: TerrainSource['edits']): PlacementContext {
  const span = 6;
  const slopeX = sampleWorldHeight(bundle, x + span, z, terrainEdits) - sampleWorldHeight(bundle, x - span, z, terrainEdits);
  const slopeZ = sampleWorldHeight(bundle, x, z + span, terrainEdits) - sampleWorldHeight(bundle, x, z - span, terrainEdits);
  return {
    biome: biome?.toLowerCase() ?? '',
    roadDistance: featureDistance(bundle, 'road', x, z),
    riverDistance: featureDistance(bundle, 'river', x, z),
    coastlineDistance: featureDistance(bundle, 'coastline', x, z),
    slope: Math.hypot(slopeX, slopeZ) / (span * 2),
  };
}

function prototypePlacementWeight(prototype: VisualWorldBundle['prototypes'][number], context: PlacementContext): number {
  const kind = prototype.tags.join(' ').toLowerCase();
  const nearRoad = context.roadDistance < 115;
  const nearWater = context.riverDistance < 105 || context.coastlineDistance < 90;
  if (/\bboat\b/.test(kind)) return 0;
  if (/\bdock\b/.test(kind)) return nearWater ? 0.28 : 0;
  if (/\bbridge\b/.test(kind)) return context.riverDistance < 90 ? 0.24 : context.roadDistance < 65 ? 0.08 : 0;
  if (/\blantern\b/.test(kind)) return nearRoad ? 0.48 : 0.025;
  if (/cottage|cabin|market-stall|tent|well|caravan-cart|sled|windmill/.test(kind)) return nearRoad ? 0.22 : 0.015;
  if (/watchtower|archway|ruin-wall|ruin-column/.test(kind)) return /highland|mesa|ashland/.test(context.biome) ? 0.1 : nearRoad ? 0.07 : 0.02;
  if (/reed|willow/.test(kind)) return nearWater ? 1.7 : 0.22;
  if (/oak|pine|birch|spruce|fir|acacia|date-palm|dead-tree|charred-pine/.test(kind)) return /forest|scrub|grove/.test(context.biome) ? 1.8 : 0.48;
  if (/wildflower/.test(kind)) return /grass|plain|meadow/.test(context.biome) ? 2.4 : 0.55;
  if (/boulder|stone|basalt|obsidian/.test(kind)) return context.slope > 0.22 ? 1.55 : 0.78;
  return 1;
}

function selectPrototype(candidates: VisualWorldBundle['prototypes'], context: PlacementContext, random: () => number): VisualWorldBundle['prototypes'][number] {
  const weighted = candidates.map((prototype) => ({ prototype, weight: prototypePlacementWeight(prototype, context) })).filter((entry) => entry.weight > 0);
  if (weighted.length === 0) return candidates[Math.floor(random() * candidates.length)]!;
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let selection = random() * total;
  for (const entry of weighted) {
    selection -= entry.weight;
    if (selection <= 0) return entry.prototype;
  }
  return weighted.at(-1)!.prototype;
}

function semanticScale(prototype: VisualWorldBundle['prototypes'][number], random: () => number): number {
  const kind = prototype.tags.join(' ').toLowerCase();
  return /cottage|cabin|market-stall|tent|well|caravan-cart|sled|windmill|watchtower|archway|ruin|dock|bridge/.test(kind)
    ? 0.92 + random() * 0.18
    : 0.75 + random() * 0.65;
}

export interface ReferenceChunkOptions {
  samples?: number;
  instances?: number;
  placeholder?: boolean;
  terrainEdits?: TerrainSource['edits'];
  regionDensities?: Record<string, number>;
}

interface PreparedTerrain {
  samples: number;
  heights: Float32Array;
  minHeight: number;
  maxHeight: number;
  biomeWeights?: Uint8Array;
}

function buildReferenceChunk(bundle: VisualWorldBundle, coordinate: ChunkCoordinate, options: ReferenceChunkOptions, prepared: PreparedTerrain): RuntimeChunkDocument {
  const { samples, heights, minHeight, maxHeight, biomeWeights } = prepared;
  const centerX = (coordinate.x + 0.5) * bundle.chunkSize;
  const centerZ = (coordinate.z + 0.5) * bundle.chunkSize;
  const region = bundle.regions.find((candidate) => pointInPolygon(centerX, centerZ, candidate.polygon));
  const densityMultiplier = region ? Math.max(0, options.regionDensities?.[region.id] ?? region.density) / Math.max(0.01, region.density) : 1;
  const instanceCount = options.instances ?? Math.round(20 * densityMultiplier);
  const random = createRandom(hash32(bundle.seed, coordinate.x, coordinate.z));
  const instances: RuntimeInstance[] = Array.from({ length: instanceCount }, (_, index) => {
    const x = coordinate.x * bundle.chunkSize + random() * bundle.chunkSize;
    const z = coordinate.z * bundle.chunkSize + random() * bundle.chunkSize;
    const y = sampleWorldHeight(bundle, x, z, options.terrainEdits);
    const pointRegion = bundle.regions.find((candidate) => pointInPolygon(x, z, candidate.polygon));
    const candidates = prototypeCandidates(bundle, pointRegion?.biome);
    const prototype = selectPrototype(candidates, placementContext(bundle, pointRegion?.biome, x, z, options.terrainEdits), random);
    if (!prototype) throw new Error('Reference bundle requires prototypes');
    return {
      id: EntityIdSchema.parse(`entity-${coordinate.x}-${coordinate.z}-${index}`),
      prototypeId: PrototypeIdSchema.parse(prototype.id),
      matrix: composeMatrix(x, y, z, random() * Math.PI * 2, semanticScale(prototype, random)),
      visualState: pointRegion ? { regionId: pointRegion.id, semanticPlacement: true } : { semanticPlacement: true },
    };
  });
  const chunkMinX = coordinate.x * bundle.chunkSize;
  const chunkMinZ = coordinate.z * bundle.chunkSize;
  const authored = bundle.authoredInstances.filter((instance) => instance.matrix[12] >= chunkMinX && instance.matrix[12] < chunkMinX + bundle.chunkSize && instance.matrix[14] >= chunkMinZ && instance.matrix[14] < chunkMinZ + bundle.chunkSize);
  for (const instance of authored) {
    const existingIndex = instances.findIndex((candidate) => candidate.id === instance.id);
    if (existingIndex >= 0) instances[existingIndex] = instance;
    else instances.push(instance);
  }
  const removedEntityIds = new Set(bundle.removedEntityIds);
  for (let index = instances.length - 1; index >= 0; index -= 1) if (removedEntityIds.has(instances[index]!.id)) instances.splice(index, 1);
  const id = ChunkIdSchema.parse(`${coordinate.x}:${coordinate.z}`);
  const cellSize = bundle.optimization.occlusionCellSize;
  const cellsPerAxis = Math.max(1, Math.ceil(bundle.chunkSize / cellSize));
  const occlusionCells = Array.from({ length: cellsPerAxis * cellsPerAxis }, (_, cellIndex) => {
    const cellX = cellIndex % cellsPerAxis;
    const cellZ = Math.floor(cellIndex / cellsPerAxis);
    const minX = coordinate.x * bundle.chunkSize + cellX * cellSize;
    const minZ = coordinate.z * bundle.chunkSize + cellZ * cellSize;
    const maxX = Math.min((coordinate.x + 1) * bundle.chunkSize, minX + cellSize);
    const maxZ = Math.min((coordinate.z + 1) * bundle.chunkSize, minZ + cellSize);
    return {
      id: `${id}:cell:${cellX}:${cellZ}`,
      bounds: { min: [minX, minZ] as [number, number], max: [maxX, maxZ] as [number, number] },
      minHeight,
      maxHeight,
      instanceIds: instances.filter((instance) => instance.matrix[12] >= minX && instance.matrix[12] < maxX && instance.matrix[14] >= minZ && instance.matrix[14] < maxZ).map((instance) => instance.id),
    };
  });
  return RuntimeChunkDocumentSchema.parse({
    format: 'RuntimeChunk', version: '1.1.0', id, coordinate,
    bounds: { min: [coordinate.x * bundle.chunkSize, coordinate.z * bundle.chunkSize], max: [(coordinate.x + 1) * bundle.chunkSize, (coordinate.z + 1) * bundle.chunkSize] },
    terrain: { samples, encoding: 'float32-base64', heights: encodeFloat32(heights), minHeight, maxHeight, ...(biomeWeights ? { biomeWeights: encodeUint8(biomeWeights) } : {}) },
    instances,
    dependencies: [...new Set(instances.map((instance) => instance.prototypeId))].sort(),
    occlusionCells,
    placeholder: options.placeholder ?? false,
  });
}

function sampleBiomeRow(bundle: VisualWorldBundle, coordinate: ChunkCoordinate, samples: number, sampleZ: number, biomeWeights: Uint8Array): void {
  const spacing = bundle.chunkSize / (samples - 1);
  for (let sampleX = 0; sampleX < samples; sampleX += 1) {
    const worldX = coordinate.x * bundle.chunkSize + sampleX * spacing;
    const worldZ = coordinate.z * bundle.chunkSize + sampleZ * spacing;
    const regionIndex = bundle.regions.findIndex((candidate) => pointInPolygon(worldX, worldZ, candidate.polygon));
    biomeWeights[sampleZ * samples + sampleX] = regionIndex < 0 ? 255 : regionIndex;
  }
}

export function generateReferenceChunk(bundle: VisualWorldBundle, coordinate: ChunkCoordinate, options: ReferenceChunkOptions = {}): RuntimeChunkDocument {
  const samples = options.samples ?? bundle.terrainSamples;
  const heights = new Float32Array(samples * samples);
  const biomeWeights = bundle.regions.length > 0 ? new Uint8Array(samples * samples) : undefined;
  const spacing = bundle.chunkSize / (samples - 1);
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  for (let sampleZ = 0; sampleZ < samples; sampleZ += 1) {
    for (let sampleX = 0; sampleX < samples; sampleX += 1) {
      const worldX = coordinate.x * bundle.chunkSize + sampleX * spacing;
      const worldZ = coordinate.z * bundle.chunkSize + sampleZ * spacing;
      const height = sampleWorldHeight(bundle, worldX, worldZ, options.terrainEdits);
      heights[sampleZ * samples + sampleX] = height;
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
    }
    if (biomeWeights) sampleBiomeRow(bundle, coordinate, samples, sampleZ, biomeWeights);
  }
  return buildReferenceChunk(bundle, coordinate, options, { samples, heights, minHeight, maxHeight, ...(biomeWeights ? { biomeWeights } : {}) });
}

export async function generateReferenceChunkAsync(
  bundle: VisualWorldBundle,
  coordinate: ChunkCoordinate,
  options: ReferenceChunkOptions & { rowsPerTask?: number; yieldControl?: () => Promise<void> } = {},
): Promise<RuntimeChunkDocument> {
  const samples = options.samples ?? bundle.terrainSamples;
  const rowsPerTask = Math.max(1, Math.min(samples, Math.floor(options.rowsPerTask ?? 8)));
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const heights = new Float32Array(samples * samples);
  const biomeWeights = bundle.regions.length > 0 ? new Uint8Array(samples * samples) : undefined;
  const spacing = bundle.chunkSize / (samples - 1);
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  for (let sampleZ = 0; sampleZ < samples; sampleZ += 1) {
    for (let sampleX = 0; sampleX < samples; sampleX += 1) {
      const worldX = coordinate.x * bundle.chunkSize + sampleX * spacing;
      const worldZ = coordinate.z * bundle.chunkSize + sampleZ * spacing;
      const height = sampleWorldHeight(bundle, worldX, worldZ, options.terrainEdits);
      heights[sampleZ * samples + sampleX] = height;
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
    }
    if (biomeWeights) sampleBiomeRow(bundle, coordinate, samples, sampleZ, biomeWeights);
    if ((sampleZ + 1) % rowsPerTask === 0 && sampleZ + 1 < samples) await yieldControl();
  }
  return buildReferenceChunk(bundle, coordinate, options, { samples, heights, minHeight, maxHeight, ...(biomeWeights ? { biomeWeights } : {}) });
}
