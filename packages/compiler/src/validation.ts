import {
  RuntimeChunkDocumentSchema,
  VisualWorldBundleSchema,
  chunkId,
  type AuthoringWorld,
  type RuntimeChunkDocument,
  type VisualWorldBundle,
  type WorldDesignSpec,
} from '@worldengine/schema';
import { decodeFloat32, decodeUint8, sampleWorldHeight } from '@worldengine/terrain';
import { isSafeAssetUri } from './asset-validation.js';

export interface ValidationIssue {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  subjectId?: string;
}

export interface AcceptanceRequirements {
  minimumRegions: number;
  minimumPrototypes: number;
  minimumPlacedInstances: number;
  expectedWidthMeters: number;
  expectedDepthMeters: number;
  terrainContactToleranceMeters: number;
}

export const referenceAcceptanceRequirements: AcceptanceRequirements = {
  minimumRegions: 5,
  minimumPrototypes: 20,
  minimumPlacedInstances: 5_000,
  expectedWidthMeters: 4_096,
  expectedDepthMeters: 4_096,
  terrainContactToleranceMeters: 0.01,
};

export function validateBundleIntegrity(input: unknown): { bundle?: VisualWorldBundle; issues: ValidationIssue[] } {
  const parsed = VisualWorldBundleSchema.safeParse(input);
  if (!parsed.success) return { issues: [{ severity: 'error', code: 'SCHEMA_INVALID', message: parsed.error.message }] };
  const bundle = parsed.data;
  const issues: ValidationIssue[] = [];
  const prototypeIds = new Set<string>();
  const chunkIds = new Set<string>();
  const provenanceBySubject = new Map(bundle.provenance.map((record) => [record.subjectId, record]));
  const provenanceById = new Map(bundle.provenance.map((record) => [record.id, record]));
  if (provenanceById.size !== bundle.provenance.length) issues.push({ severity: 'error', code: 'DUPLICATE_PROVENANCE', message: 'Bundle contains duplicate provenance IDs' });
  for (const record of bundle.provenance) for (const parentId of record.parentIds) if (!provenanceById.has(parentId)) {
    issues.push({ severity: 'error', code: 'MISSING_PROVENANCE_PARENT', message: `Provenance ${record.id} references missing parent ${parentId}`, subjectId: record.subjectId });
  }
  for (const prototype of bundle.prototypes) {
    if (prototypeIds.has(prototype.id)) issues.push({ severity: 'error', code: 'DUPLICATE_PROTOTYPE', message: `Duplicate prototype ${prototype.id}`, subjectId: prototype.id });
    prototypeIds.add(prototype.id);
    if (!isSafeAssetUri(prototype.assetUri)) issues.push({ severity: 'error', code: 'UNSAFE_ASSET_URI', message: `Prototype ${prototype.id} has an unsafe asset URI`, subjectId: prototype.id });
    let previousDistance = -1;
    for (const lod of prototype.lods) {
      if (!isSafeAssetUri(lod.assetUri)) issues.push({ severity: 'error', code: 'UNSAFE_LOD_URI', message: `Prototype ${prototype.id} has an unsafe LOD URI`, subjectId: prototype.id });
      if (lod.distance <= previousDistance) issues.push({ severity: 'error', code: 'INVALID_LOD_ORDER', message: `Prototype ${prototype.id} LOD distances must be strictly increasing`, subjectId: prototype.id });
      const lodProvenance = provenanceById.get(lod.provenanceId);
      if (!lodProvenance || lodProvenance.contentHash.toLowerCase() !== lod.contentHash.toLowerCase()) issues.push({ severity: 'error', code: 'MISSING_LOD_PROVENANCE', message: `Prototype ${prototype.id} LOD has no matching provenance`, subjectId: prototype.id });
      else if (!lodProvenance.reviewedAt) issues.push({ severity: 'error', code: 'UNREVIEWED_LOD', message: `Prototype ${prototype.id} LOD is not reviewed`, subjectId: prototype.id });
      else if (!lodProvenance.license.commercialUse) issues.push({ severity: 'warning', code: 'NONCOMMERCIAL_LOD', message: `Prototype ${prototype.id} LOD is not approved for commercial use`, subjectId: prototype.id });
      previousDistance = lod.distance;
    }
    const provenance = provenanceBySubject.get(prototype.id);
    if (!provenance) issues.push({ severity: 'error', code: 'MISSING_PROVENANCE', message: `Prototype ${prototype.id} has no provenance`, subjectId: prototype.id });
    else if (provenance.contentHash.toLowerCase() !== prototype.contentHash.toLowerCase()) issues.push({ severity: 'error', code: 'PROVENANCE_HASH_MISMATCH', message: `Prototype ${prototype.id} content hash does not match its provenance`, subjectId: prototype.id });
    else if (!provenance.reviewedAt) issues.push({ severity: 'error', code: 'UNREVIEWED_ASSET', message: `Prototype ${prototype.id} is not reviewed`, subjectId: prototype.id });
    else if (!provenance.license.commercialUse) issues.push({ severity: 'warning', code: 'NONCOMMERCIAL_ASSET', message: `Prototype ${prototype.id} is not approved for commercial use`, subjectId: prototype.id });
  }
  if (bundle.optimization.meshLods && bundle.prototypes.some((prototype) => prototype.lods.length === 0)) issues.push({ severity: 'error', code: 'MESH_LOD_FLAG_MISMATCH', message: 'Bundle declares mesh LOD optimization but a prototype has no LODs' });
  if (bundle.optimization.textureFormat === 'ktx2' && bundle.prototypes.some((prototype) => prototype.textureFormat !== 'ktx2' && prototype.textureFormat !== 'none')) issues.push({ severity: 'error', code: 'TEXTURE_FORMAT_FLAG_MISMATCH', message: 'Bundle declares KTX2 textures but a prototype still uses source textures' });
  for (const chunk of bundle.chunks) {
    if (chunkIds.has(chunk.id)) issues.push({ severity: 'error', code: 'DUPLICATE_CHUNK', message: `Duplicate chunk ${chunk.id}`, subjectId: chunk.id });
    chunkIds.add(chunk.id);
    if (chunk.source.kind === 'uri' && !isSafeAssetUri(chunk.source.uri)) issues.push({ severity: 'error', code: 'UNSAFE_CHUNK_URI', message: `Chunk ${chunk.id} has an unsafe source URI`, subjectId: chunk.id });
    for (const dependency of chunk.dependencies) if (!prototypeIds.has(dependency)) issues.push({ severity: 'error', code: 'MISSING_CHUNK_DEPENDENCY', message: `Chunk ${chunk.id} references missing prototype ${dependency}`, subjectId: chunk.id });
    const expectedMinX = chunk.coordinate.x * bundle.chunkSize;
    const expectedMinZ = chunk.coordinate.z * bundle.chunkSize;
    if (chunk.bounds.min[0] !== expectedMinX || chunk.bounds.min[1] !== expectedMinZ) {
      issues.push({ severity: 'error', code: 'CHUNK_BOUNDS_MISMATCH', message: `Chunk ${chunk.id} bounds do not match its signed coordinate`, subjectId: chunk.id });
    }
  }
  return { bundle, issues };
}

export function validateRuntimeChunk(bundle: VisualWorldBundle, input: unknown): ValidationIssue[] {
  const parsed = RuntimeChunkDocumentSchema.safeParse(input);
  if (!parsed.success) return [{ severity: 'error', code: 'CHUNK_SCHEMA_INVALID', message: parsed.error.message }];
  const chunk: RuntimeChunkDocument = parsed.data;
  const issues: ValidationIssue[] = [];
  let heights: Float32Array;
  try { heights = decodeFloat32(chunk.terrain.heights); }
  catch { return [{ severity: 'error', code: 'HEIGHT_ENCODING_INVALID', message: `Chunk ${chunk.id} contains invalid base64 float32 terrain data`, subjectId: chunk.id }]; }
  if (heights.length !== chunk.terrain.samples ** 2) issues.push({ severity: 'error', code: 'HEIGHT_COUNT_MISMATCH', message: `Chunk ${chunk.id} height count does not match samples`, subjectId: chunk.id });
  if (chunk.terrain.biomeWeights) {
    try { decodeUint8(chunk.terrain.biomeWeights, chunk.terrain.samples ** 2); }
    catch { issues.push({ severity: 'error', code: 'BIOME_WEIGHT_COUNT_MISMATCH', message: `Chunk ${chunk.id} biome-weight count does not match samples`, subjectId: chunk.id }); }
  }
  let actualMin = Number.POSITIVE_INFINITY;
  let actualMax = Number.NEGATIVE_INFINITY;
  let finite = true;
  for (const height of heights) {
    if (!Number.isFinite(height)) finite = false;
    actualMin = Math.min(actualMin, height);
    actualMax = Math.max(actualMax, height);
  }
  if (!finite) issues.push({ severity: 'error', code: 'NONFINITE_HEIGHT', message: `Chunk ${chunk.id} contains a non-finite terrain height`, subjectId: chunk.id });
  if (heights.length > 0 && finite) {
    if (Math.abs(actualMin - chunk.terrain.minHeight) > 0.001 || Math.abs(actualMax - chunk.terrain.maxHeight) > 0.001) issues.push({ severity: 'error', code: 'HEIGHT_RANGE_MISMATCH', message: `Chunk ${chunk.id} declared terrain range does not match its samples`, subjectId: chunk.id });
  }
  const prototypes = new Set(bundle.prototypes.map((prototype) => prototype.id));
  const dependencies = new Set(chunk.dependencies);
  const entities = new Set<string>();
  for (const instance of chunk.instances) {
    if (entities.has(instance.id)) issues.push({ severity: 'error', code: 'DUPLICATE_ENTITY', message: `Duplicate entity ${instance.id}`, subjectId: instance.id });
    entities.add(instance.id);
    if (!prototypes.has(instance.prototypeId)) issues.push({ severity: 'error', code: 'MISSING_PROTOTYPE', message: `Entity ${instance.id} references missing prototype ${instance.prototypeId}`, subjectId: instance.id });
    if (!dependencies.has(instance.prototypeId)) issues.push({ severity: 'error', code: 'MISSING_INSTANCE_DEPENDENCY', message: `Entity ${instance.id} uses prototype ${instance.prototypeId} absent from chunk dependencies`, subjectId: instance.id });
    const spanX = chunk.bounds.max[0] - chunk.bounds.min[0];
    const spanZ = chunk.bounds.max[1] - chunk.bounds.min[1];
    const x = instance.matrix[12]; const z = instance.matrix[14];
    if (x < chunk.bounds.min[0] || x > chunk.bounds.max[0] || z < chunk.bounds.min[1] || z > chunk.bounds.max[1]) {
      issues.push({ severity: 'error', code: 'ENTITY_OUTSIDE_CHUNK', message: `Entity ${instance.id} lies outside chunk ${chunk.id}`, subjectId: instance.id });
    } else if (heights.length === chunk.terrain.samples ** 2 && spanX > 0 && spanZ > 0) {
      const gridX = Math.max(0, Math.min(chunk.terrain.samples - 1, (x - chunk.bounds.min[0]) / spanX * (chunk.terrain.samples - 1)));
      const gridZ = Math.max(0, Math.min(chunk.terrain.samples - 1, (z - chunk.bounds.min[1]) / spanZ * (chunk.terrain.samples - 1)));
      const x0 = Math.floor(gridX); const z0 = Math.floor(gridZ);
      const x1 = Math.min(chunk.terrain.samples - 1, x0 + 1); const z1 = Math.min(chunk.terrain.samples - 1, z0 + 1);
      // Chunk payloads may be intentionally downsampled. The minimum of the
      // containing cell is a conservative floor that detects definite burial
      // without rejecting objects correctly placed on the canonical source.
      const terrainFloor = Math.min(
        heights[z0 * chunk.terrain.samples + x0]!, heights[z0 * chunk.terrain.samples + x1]!,
        heights[z1 * chunk.terrain.samples + x0]!, heights[z1 * chunk.terrain.samples + x1]!,
      );
      if (instance.matrix[13] < terrainFloor - 0.01) issues.push({ severity: 'error', code: 'BELOW_TERRAIN_OBJECT', message: `Entity ${instance.id} is below its local terrain surface`, subjectId: instance.id });
    }
  }
  const occlusionMembership = new Set<string>();
  for (const cell of chunk.occlusionCells) for (const entityId of cell.instanceIds) {
    if (!entities.has(entityId)) issues.push({ severity: 'error', code: 'UNKNOWN_OCCLUSION_ENTITY', message: `Occlusion cell ${cell.id} references unknown entity ${entityId}`, subjectId: entityId });
    if (occlusionMembership.has(entityId)) issues.push({ severity: 'error', code: 'DUPLICATE_OCCLUSION_ENTITY', message: `Entity ${entityId} occurs in multiple occlusion cells`, subjectId: entityId });
    occlusionMembership.add(entityId);
  }
  return issues;
}

export function assertValidBundle(input: unknown): VisualWorldBundle {
  const result = validateBundleIntegrity(input);
  const errors = result.issues.filter((issue) => issue.severity === 'error');
  if (!result.bundle || errors.length > 0) throw new Error(`Bundle validation failed: ${errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ')}`);
  return result.bundle;
}

export function validateWorldAcceptance(
  design: WorldDesignSpec,
  authoring: AuthoringWorld,
  bundle: VisualWorldBundle,
  requirements: AcceptanceRequirements = referenceAcceptanceRequirements,
): ValidationIssue[] {
  const issues = [...validateBundleIntegrity(bundle).issues];
  const width = design.bounds.max[0] - design.bounds.min[0];
  const depth = design.bounds.max[1] - design.bounds.min[1];
  if (width !== requirements.expectedWidthMeters || depth !== requirements.expectedDepthMeters) {
    issues.push({ severity: 'error', code: 'ACCEPTANCE_WORLD_SIZE', message: `Expected ${requirements.expectedWidthMeters}×${requirements.expectedDepthMeters} meters, received ${width}×${depth}` });
  }
  if (design.regions.length < requirements.minimumRegions) issues.push({ severity: 'error', code: 'ACCEPTANCE_REGION_COUNT', message: `Expected at least ${requirements.minimumRegions} regions, received ${design.regions.length}` });
  if (bundle.prototypes.length < requirements.minimumPrototypes) issues.push({ severity: 'error', code: 'ACCEPTANCE_PROTOTYPE_COUNT', message: `Expected at least ${requirements.minimumPrototypes} prototypes, received ${bundle.prototypes.length}` });
  if (authoring.entities.length < requirements.minimumPlacedInstances) issues.push({ severity: 'error', code: 'ACCEPTANCE_INSTANCE_COUNT', message: `Expected at least ${requirements.minimumPlacedInstances} instances, received ${authoring.entities.length}` });

  const presentChunks = new Set(bundle.chunks.map((entry) => entry.id));
  const minX = Math.floor(bundle.bounds.min[0] / bundle.chunkSize);
  const maxX = Math.ceil(bundle.bounds.max[0] / bundle.chunkSize) - 1;
  const minZ = Math.floor(bundle.bounds.min[1] / bundle.chunkSize);
  const maxZ = Math.ceil(bundle.bounds.max[1] / bundle.chunkSize) - 1;
  for (let z = minZ; z <= maxZ; z += 1) for (let x = minX; x <= maxX; x += 1) {
    const id = chunkId(x, z);
    if (!presentChunks.has(id)) issues.push({ severity: 'error', code: 'ACCEPTANCE_MISSING_CHUNK', message: `Missing bounded-world chunk ${id}`, subjectId: id });
  }

  for (const entity of authoring.entities) {
    const [x, y, z] = entity.transform.position;
    const expected = sampleWorldHeight(bundle, x, z);
    if (y < expected - requirements.terrainContactToleranceMeters) {
      issues.push({ severity: 'error', code: 'ACCEPTANCE_BELOW_TERRAIN', message: `Entity ${entity.id} is ${(expected - y).toFixed(3)} meters below terrain`, subjectId: entity.id });
    } else if ((entity.visualState['proceduralScatter'] === true || entity.visualState['compositionPlaced'] === true) && Math.abs(y - expected) > requirements.terrainContactToleranceMeters) {
      issues.push({ severity: 'error', code: 'ACCEPTANCE_TERRAIN_CONTACT', message: `Entity ${entity.id} is ${Math.abs(y - expected).toFixed(3)} meters away from terrain contact`, subjectId: entity.id });
    }
  }
  return issues;
}

export function assertWorldAcceptance(design: WorldDesignSpec, authoring: AuthoringWorld, bundle: VisualWorldBundle): void {
  const errors = validateWorldAcceptance(design, authoring, bundle).filter((issue) => issue.severity === 'error');
  if (errors.length > 0) throw new Error(`World acceptance failed: ${errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ')}`);
}
