import { createHash } from 'node:crypto';
import {
  AuthoringWorldSchema,
  EntityIdSchema,
  PrototypeIdSchema,
  RegionIdSchema,
  VisualWorldBundleSchema,
  chunkId,
  type AssetLibraryEntry,
  type AuthoringEntity,
  type AuthoringWorld,
  type CompileRequest,
  type Mat4,
  type Prototype,
  type ProvenanceRecord,
  type RegionalComposition,
  type RuntimeInstance,
  type Transform,
  type VisualWorldBundle,
  type WorldDesignSpec,
} from '@worldengine/schema';
import { generateReferenceChunk, hash32, sampleWorldHeight } from '@worldengine/terrain';
import { isSafeAssetUri } from './asset-validation.js';
import { placeObjectFromComposition, referenceCamerasForRegion, type ObjectDescriptor } from './composition.js';
import { effectiveQualityProfile } from './quality-profile.js';

export interface CompiledWorldArtifacts {
  designSpec: WorldDesignSpec;
  authoringWorld: AuthoringWorld;
  bundle: VisualWorldBundle;
}

export interface CompositionPlacementOverride extends ObjectDescriptor {
  regionId: string;
}

export interface AuthoringCompileOptions {
  compositionOverrides?: readonly CompositionPlacementOverride[];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z\d]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80) || 'world';
}

export function boundsRadiusForAssetClass(assetClass: string): number {
  if (/watchtower|windmill|mesa|archway/i.test(assetClass)) return 12;
  if (/cottage|cabin|tent|bridge|dock|market/i.test(assetClass)) return 7;
  if (/tree|oak|pine|birch|willow|spruce|acacia|palm/i.test(assetClass)) return 4;
  return 3;
}

function proceduralProvenance(id: string, assetClass: string, createdAt: string, contentHash: string): ProvenanceRecord {
  return {
    id: `provenance-${id}`,
    subjectId: id,
    kind: 'procedural',
    license: { name: 'Apache-2.0 project-authored primitive', commercialUse: true },
    createdAt,
    contentHash,
    parentIds: [],
    reviewedAt: createdAt,
    sourceUri: `primitive://${assetClass}`,
  };
}

function assertLibraryEntry(entry: AssetLibraryEntry, commercialUse: boolean, pendingGeneratedReviewIds: ReadonlySet<string>): void {
  if (entry.provenance.subjectId !== entry.id) throw new Error(`Asset library provenance subject does not match ${entry.id}`);
  if (entry.provenance.contentHash.toLowerCase() !== entry.contentHash.toLowerCase()) throw new Error(`Asset library provenance content hash does not match ${entry.id}`);
  const pendingInternalReview = (entry.provenance.kind === 'generated' || entry.provenance.kind === 'edited') && pendingGeneratedReviewIds.has(entry.id);
  if (!entry.provenance.reviewedAt && !pendingInternalReview) throw new Error(`Asset library entry ${entry.id} has not been reviewed`);
  if (commercialUse && !entry.provenance.license.commercialUse) throw new Error(`Asset library entry ${entry.id} is not approved for commercial use`);
  for (const source of entry.sourceProvenance) {
    if (!source.reviewedAt && !pendingInternalReview) throw new Error(`Asset library source ${source.id} has not been reviewed`);
    if (commercialUse && !source.license.commercialUse) throw new Error(`Asset library source ${source.id} is not approved for commercial use`);
  }
  if (!isSafeAssetUri(entry.assetUri) || entry.lods.some((lod) => !isSafeAssetUri(lod.assetUri))) throw new Error(`Asset library entry ${entry.id} contains an unsafe URI`);
  for (const lod of entry.lods) {
    const provenance = entry.lodProvenance.find((record) => record.id === lod.provenanceId);
    if (!provenance || provenance.contentHash.toLowerCase() !== lod.contentHash.toLowerCase()) throw new Error(`Asset library LOD ${lod.assetUri} lacks matching provenance`);
    if (!provenance.reviewedAt && !(pendingInternalReview && provenance.parentIds.includes(entry.provenance.id))) throw new Error(`Asset library LOD ${lod.assetUri} has not been reviewed`);
    if (commercialUse && !provenance.license.commercialUse) throw new Error(`Asset library LOD ${lod.assetUri} is not approved for commercial use`);
  }
}

function resolvePrototypes(spec: WorldDesignSpec, request: CompileRequest, createdAt: string, pendingGeneratedReviewIds: ReadonlySet<string>): { prototypes: Prototype[]; provenance: ProvenanceRecord[] } {
  const prototypes: Prototype[] = [];
  const provenance: ProvenanceRecord[] = [];
  const requirements = spec.assetRequirements.length > 0 ? spec.assetRequirements : [{ class: 'terrain-marker', count: 1, sourcePreference: ['library' as const, 'cache' as const, 'generate' as const], tags: [] }];
  for (const requirement of requirements) {
    for (let index = 0; index < Math.max(1, requirement.count); index += 1) {
      const library = request.assetLibrary.find((entry) => entry.class.toLowerCase() === requirement.class.toLowerCase() && !prototypes.some((prototype) => prototype.id === entry.id));
      if (library) {
        assertLibraryEntry(library, request.commercialUse, pendingGeneratedReviewIds);
        prototypes.push({
          id: library.id,
          name: requirement.class,
          assetUri: library.assetUri,
          assetHash: library.contentHash,
          textureFormat: library.textureFormat,
          bounds: { min: [-library.boundsRadius, 0, -library.boundsRadius], max: [library.boundsRadius, library.boundsRadius * 2, library.boundsRadius] },
          lods: library.lods,
          materialVariants: library.materialVariants,
          animationClips: library.animationClips,
          tags: [...new Set([requirement.class, ...requirement.tags, ...library.tags])],
          provenanceId: library.provenance.id,
        });
        provenance.push(...library.sourceProvenance, library.provenance, ...library.lodProvenance);
        continue;
      }
      const id = PrototypeIdSchema.parse(`prototype-${slug(requirement.class)}-${String(index + 1).padStart(2, '0')}`);
      const contentHash = createHash('sha256').update(`primitive:${requirement.class}:v1`).digest('hex');
      const boundsRadius = boundsRadiusForAssetClass(requirement.class);
      prototypes.push({
        id,
        name: requirement.class,
        assetUri: `primitive://${slug(requirement.class)}`,
        assetHash: contentHash,
        textureFormat: 'none',
        bounds: { min: [-boundsRadius, 0, -boundsRadius], max: [boundsRadius, boundsRadius * 2, boundsRadius] },
        lods: [],
        materialVariants: ['default', 'seasonal'],
        animationClips: /windmill|mill|turbine/i.test(requirement.class) ? ['turn'] : [],
        tags: [...new Set([requirement.class, ...requirement.tags])],
        provenanceId: `provenance-${id}`,
      });
      provenance.push(proceduralProvenance(id, slug(requirement.class), createdAt, contentHash));
    }
  }
  const uniqueProvenance = new Map<string, ProvenanceRecord>();
  for (const record of provenance) {
    const existing = uniqueProvenance.get(record.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`Conflicting provenance records share ID ${record.id}`);
    }
    uniqueProvenance.set(record.id, record);
  }
  return { prototypes, provenance: [...uniqueProvenance.values()] };
}

function matrixFromTransform(transform: Transform): Mat4 {
  const [x, y, z, w] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    transform.position[0], transform.position[1], transform.position[2], 1,
  ];
}

function transformFromMatrix(matrix: Mat4): Transform {
  const scale = Math.max(0.0001, Math.hypot(matrix[0], matrix[1], matrix[2]));
  const yaw = Math.atan2(matrix[8] / scale, matrix[0] / scale);
  return { position: [matrix[12], matrix[13], matrix[14]], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], scale: [scale, scale, scale] };
}

function authoredInstances(authoring: AuthoringWorld): RuntimeInstance[] {
  return authoring.entities.filter((entity) => entity.visualState['authored'] === true).map((entity) => ({
    id: entity.id,
    prototypeId: entity.prototypeId,
    matrix: matrixFromTransform(entity.transform),
    visualState: { ...entity.visualState },
  }));
}

function prototypeForLandmark(prototypes: Prototype[], landmark: WorldDesignSpec['landmarks'][number], index: number): Prototype {
  const text = `${landmark.id} ${landmark.name} ${landmark.description}`.toLowerCase();
  const aliases: Array<[RegExp, RegExp]> = [
    [/sunken|remnant/, /ruin-wall/], [/ruin/, /ruin/], [/watch|tower|lookout/, /watchtower/], [/bridge|crossing/, /bridge/], [/dock|harbou?r|pier/, /dock/],
    [/mill|turbine/, /windmill/], [/cottage|house|home/, /cottage|cabin/], [/stone|monolith/, /standing-stone/],
  ];
  for (const [landmarkPattern, prototypePattern] of aliases) {
    if (!landmarkPattern.test(text)) continue;
    const match = prototypes.find((prototype) => prototypePattern.test(`${prototype.name} ${prototype.tags.join(' ')}`.toLowerCase()));
    if (match) return match;
  }
  const tokens = new Set(text.split(/[^a-z\d]+/).filter((token) => token.length > 2));
  const scored = prototypes.map((prototype) => ({
    prototype,
    score: `${prototype.name} ${prototype.tags.join(' ')}`.toLowerCase().split(/[^a-z\d]+/).filter((token) => tokens.has(token)).length,
  })).sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].prototype : prototypes[index % prototypes.length]!;
}

function compileBundle(spec: WorldDesignSpec, authoring: AuthoringWorld, createdAt: string): VisualWorldBundle {
  const worldId = `world-${slug(spec.title)}-${spec.seed}`;
  const runtimePrototypes = authoring.prototypes.map((prototype) => ({
    id: prototype.id,
    assetUri: prototype.assetUri,
    contentHash: prototype.assetHash,
    textureFormat: prototype.textureFormat,
    lods: prototype.lods,
    materialVariants: prototype.materialVariants,
    animationClips: prototype.animationClips,
    boundsRadius: Math.max(Math.abs(prototype.bounds.min[0]), Math.abs(prototype.bounds.max[0]), Math.abs(prototype.bounds.min[2]), Math.abs(prototype.bounds.max[2])),
    tags: prototype.tags,
  }));
  const minChunkX = Math.floor(spec.bounds.min[0] / spec.chunkSize);
  const maxChunkX = Math.ceil(spec.bounds.max[0] / spec.chunkSize) - 1;
  const minChunkZ = Math.floor(spec.bounds.min[1] / spec.chunkSize);
  const maxChunkZ = Math.ceil(spec.bounds.max[1] / spec.chunkSize) - 1;
  const terrainRange = spec.regions.reduce((range, region) => ({ min: Math.min(range.min, region.elevation.min), max: Math.max(range.max, region.elevation.max) }), { min: 0, max: 0 });
  const contentBasis = JSON.stringify({ seed: spec.seed, regions: spec.regions, features: spec.features, prototypes: runtimePrototypes.map((prototype) => [prototype.id, prototype.contentHash]) });
  const chunks = [];
  for (let z = minChunkZ; z <= maxChunkZ; z += 1) for (let x = minChunkX; x <= maxChunkX; x += 1) chunks.push({
    id: chunkId(x, z),
    coordinate: { x, z },
    bounds: { min: [x * spec.chunkSize, z * spec.chunkSize] as [number, number], max: [(x + 1) * spec.chunkSize, (z + 1) * spec.chunkSize] as [number, number] },
    source: { kind: 'procedural' as const, seed: hash32(spec.seed, x, z), generator: 'worldengine-terrain-v1' as const, contentHash: createHash('sha256').update(`${contentBasis}:${x}:${z}`).digest('hex') },
    dependencies: [] as string[],
  });
  let bundle = VisualWorldBundleSchema.parse({
    format: 'VisualWorldBundle', version: '1.1.0', id: `${worldId}-v1`, worldId, bundleVersion: 1, immutable: true, createdAt,
    seed: spec.seed, coordinateSystem: 'right-handed-y-up', units: 'meters', bounds: spec.bounds, chunkSize: spec.chunkSize, terrainSamples: spec.terrainSamples,
    qualityProfile: authoring.qualityProfile,
    terrain: { kind: 'procedural', seed: authoring.terrain.seed, amplitude: Math.max(24, (terrainRange.max - terrainRange.min) * 0.42), frequency: authoring.terrain.frequency, edits: authoring.terrain.edits },
    regions: spec.regions, features: spec.features, style: spec.style, environment: spec.environment, prototypes: runtimePrototypes, authoredInstances: authoredInstances(authoring), chunks,
    provenance: authoring.provenance, sourceRevision: authoring.revision,
    optimization: {
      meshLods: runtimePrototypes.every((prototype) => prototype.lods.length > 0),
      textureFormat: runtimePrototypes.some((prototype) => prototype.textureFormat !== 'none') && runtimePrototypes.filter((prototype) => prototype.textureFormat !== 'none').every((prototype) => prototype.textureFormat === 'ktx2') ? 'ktx2' : 'source',
      instanceGroups: true, occlusionMetadata: true, terrainLodSamples: [65, 33, 17], occlusionCellSize: 64,
    },
  });
  bundle = VisualWorldBundleSchema.parse({
    ...bundle,
    chunks: bundle.chunks.map((entry) => ({ ...entry, dependencies: generateReferenceChunk(bundle, entry.coordinate, { samples: 3 }).dependencies })),
  });
  return bundle;
}

export function compileLocalWorldArtifacts(
  request: CompileRequest,
  spec: WorldDesignSpec,
  now = new Date(),
  pendingGeneratedReviewIds: ReadonlySet<string> = new Set(),
  options: AuthoringCompileOptions = {},
): CompiledWorldArtifacts {
  const createdAt = now.toISOString();
  const { prototypes, provenance } = resolvePrototypes(spec, request, createdAt, pendingGeneratedReviewIds);
  const worldId = `world-${slug(spec.title)}-${spec.seed}`;
  const landmarkEntities: AuthoringEntity[] = spec.landmarks.map((landmark, index) => ({
    id: EntityIdSchema.parse(`landmark:${slug(landmark.id)}`),
    prototypeId: prototypeForLandmark(prototypes, landmark, index).id,
    name: landmark.name,
    transform: { position: landmark.position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    visualState: { authored: true, landmark: true },
    locked: true,
  }));
  const initial = AuthoringWorldSchema.parse({
    format: 'AuthoringWorld', version: '1.1.0', id: `${worldId}-authoring`, designSpecId: spec.id, revision: 0, seed: spec.seed,
    qualityProfile: effectiveQualityProfile(request),
    bounds: spec.bounds, chunkSize: spec.chunkSize, terrainSamples: spec.terrainSamples,
    terrain: { kind: 'procedural', seed: spec.seed, amplitude: 72, frequency: 1 / 900, edits: [] },
    prototypes, entities: landmarkEntities,
    regions: spec.regions.map((region) => ({ id: region.id, polygon: region.polygon, biome: region.biome, density: region.density })),
    features: spec.features,
    referenceImages: [],
    regionalCompositions: [],
    visualZones: spec.regions.map((region) => ({ id: `zone-${region.id}`, polygon: region.polygon, settings: { biome: region.biome, density: region.density } })),
    chunkOverrides: [],
    diagnostics: spec.defaultsApplied.map((message) => ({ severity: 'info' as const, code: 'DEFAULT_APPLIED', message })),
    provenance, appliedPatchIds: [], createdAt, updatedAt: createdAt,
  });
  const provisional = compileBundle(spec, initial, createdAt);
  for (const landmark of landmarkEntities) landmark.transform = {
    ...landmark.transform,
    position: [landmark.transform.position[0], sampleWorldHeight(provisional, landmark.transform.position[0], landmark.transform.position[2]), landmark.transform.position[2]],
  };
  const seen = new Set(landmarkEntities.map((entity) => entity.id));
  const scatter: AuthoringEntity[] = [];
  for (const entry of provisional.chunks) {
    const chunk = generateReferenceChunk(provisional, entry.coordinate, { samples: 3 });
    for (const instance of chunk.instances) {
      if (seen.has(instance.id)) continue;
      seen.add(instance.id);
      const regionResult = RegionIdSchema.safeParse(instance.visualState['regionId']);
      scatter.push({
        id: instance.id,
        prototypeId: instance.prototypeId,
        name: instance.id,
        transform: transformFromMatrix(instance.matrix),
        ...(regionResult.success ? { regionId: regionResult.data } : {}),
        visualState: { ...instance.visualState, proceduralScatter: true },
        locked: false,
      });
    }
  }
  const compositionEntities: AuthoringEntity[] = [];
  const regionalCompositions = new Map<string, RegionalComposition>();
  const usedOverrides = new Set<number>();
  for (let index = 0; index < prototypes.length; index += 1) {
    const prototype = prototypes[index]!;
    const overrideIndex = options.compositionOverrides?.findIndex((candidate, candidateIndex) => !usedOverrides.has(candidateIndex) && candidate.assetClass.toLowerCase() === prototype.name.toLowerCase()) ?? -1;
    const override = overrideIndex >= 0 ? options.compositionOverrides?.[overrideIndex] : undefined;
    if (overrideIndex >= 0) usedOverrides.add(overrideIndex);
    const region = override ? spec.regions.find((candidate) => candidate.id === override.regionId) : spec.regions[index % spec.regions.length];
    if (!region) throw new Error(`Composition override for ${prototype.name} targets unknown region ${override?.regionId}`);
    // Regional concepts are rendered from this exact canonical camera. Keeping
    // every descriptor for the region on that camera makes the screen box,
    // inverse projection, terrain contact, and final review atlas one auditable chain.
    const camera = referenceCamerasForRegion(region, 1)[0]!;
    const column = index % 4;
    const row = Math.floor(index / 4) % 3;
    const descriptor: ObjectDescriptor = override ?? {
      id: `composition-${prototype.id}`,
      assetClass: prototype.name,
      description: `Canonical ${prototype.name} composition placement`,
      screenBox: { x: 520 + column * 128, y: 330 + row * 48, width: 96, height: 150 },
      desiredHeightMeters: Math.max(1, prototype.bounds.max[1] - prototype.bounds.min[1]),
      tags: prototype.tags,
    };
    const composition = regionalCompositions.get(camera.id) ?? { id: `composition-${camera.id}`, regionId: region.id, camera, objects: [] };
    regionalCompositions.set(camera.id, composition);
    try {
      const transform = placeObjectFromComposition(descriptor, camera, (x, z) => sampleWorldHeight(provisional, x, z));
      const entityId = EntityIdSchema.parse(`composition:${prototype.id}`);
      compositionEntities.push({
        id: entityId,
        prototypeId: prototype.id,
        name: `${prototype.name} composition anchor`,
        transform,
        regionId: region.id,
        visualState: { authored: true, compositionPlaced: true, compositionDetected: override !== undefined, coDeformed: request.qualityProfile === 'studio' && request.refinementPolicy.terrainCoDeformation, referenceCameraId: camera.id, screenBox: descriptor.screenBox },
        locked: false,
      });
      composition.objects.push({ ...descriptor, entityId });
      if (request.qualityProfile === 'studio' && request.refinementPolicy.terrainCoDeformation) {
        const radius = Math.max(2, Math.max(Math.abs(prototype.bounds.min[0]), Math.abs(prototype.bounds.max[0]), Math.abs(prototype.bounds.min[2]), Math.abs(prototype.bounds.max[2])) * transform.scale[0] * 1.15);
        initial.terrain.edits.push({ center: [transform.position[0], transform.position[2]], radius, delta: 0, mode: 'flatten', targetHeight: transform.position[1] });
        initial.diagnostics.push({ severity: 'info', code: 'TERRAIN_OBJECT_CO_DEFORMATION', message: `Flattened terrain footprint for ${prototype.id} with ${radius.toFixed(2)}m falloff`, subjectId: prototype.id });
      }
    } catch {
      composition.objects.push(descriptor);
      initial.diagnostics.push({ severity: 'warning', code: 'COMPOSITION_RAY_MISS', message: `Composition ray for ${prototype.id} did not intersect canonical terrain`, subjectId: prototype.id });
    }
  }
  const authoringWorld = AuthoringWorldSchema.parse({ ...initial, entities: [...landmarkEntities, ...scatter, ...compositionEntities], regionalCompositions: [...regionalCompositions.values()] });
  const bundle = compileBundle(spec, authoringWorld, createdAt);
  return { designSpec: spec, authoringWorld, bundle };
}
