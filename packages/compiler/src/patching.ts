import { createHash } from 'node:crypto';
import {
  AuthoringWorldSchema,
  EnvironmentIntentSchema,
  RegionIdSchema,
  VisualWorldBundleSchema,
  WorldDesignSpecSchema,
  WorldPatchSchema,
  type AuthoringEntity,
  type AuthoringWorld,
  type Mat4,
  type Prototype,
  type RuntimeInstance,
  type Transform,
  type VisualWorldBundle,
  type WorldDesignSpec,
  type WorldPatch,
} from '@worldengine/schema';
import { generateReferenceChunk } from '@worldengine/terrain';
import { assertValidBundle } from './validation.js';

export interface PatchedCanonicalWorld {
  designSpec: WorldDesignSpec;
  authoringWorld: AuthoringWorld;
  bundle: VisualWorldBundle;
  invalidatesDetailedChunks: boolean;
  invalidatedChunkIds: string[];
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

function runtimeInstance(entity: AuthoringEntity): RuntimeInstance {
  return { id: entity.id, prototypeId: entity.prototypeId, matrix: matrixFromTransform(entity.transform), visualState: { ...entity.visualState } };
}

function transformFromMatrix(matrix: Mat4): Transform {
  const scale = Math.max(0.0001, Math.hypot(matrix[0], matrix[1], matrix[2]));
  const yaw = Math.atan2(matrix[8] / scale, matrix[0] / scale);
  return { position: [matrix[12], matrix[13], matrix[14]], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], scale: [scale, scale, scale] };
}

function runtimePrototype(prototype: Prototype): VisualWorldBundle['prototypes'][number] {
  return {
    id: prototype.id,
    assetUri: prototype.assetUri,
    contentHash: prototype.assetHash,
    textureFormat: prototype.textureFormat,
    lods: prototype.lods,
    materialVariants: prototype.materialVariants,
    animationClips: prototype.animationClips,
    boundsRadius: Math.max(Math.abs(prototype.bounds.min[0]), Math.abs(prototype.bounds.max[0]), Math.abs(prototype.bounds.min[2]), Math.abs(prototype.bounds.max[2])),
    tags: prototype.tags,
  };
}

function requireEntity(entities: AuthoringEntity[], id: string): AuthoringEntity {
  const entity = entities.find((candidate) => candidate.id === id);
  if (!entity) throw new Error(`Patch targets unknown authoring entity ${id}`);
  return entity;
}

export function applyCanonicalPatch(designInput: WorldDesignSpec, authoringInput: AuthoringWorld, bundleInput: VisualWorldBundle, patchInput: WorldPatch, now = new Date()): PatchedCanonicalWorld {
  let design = WorldDesignSpecSchema.parse(designInput);
  let authoring = AuthoringWorldSchema.parse(structuredClone(authoringInput));
  const previous = VisualWorldBundleSchema.parse(bundleInput);
  const patch = WorldPatchSchema.parse(patchInput);
  if (patch.worldId !== previous.worldId) throw new Error('Patch targets a different world');
  if (patch.baseRevision !== previous.sourceRevision || patch.baseRevision !== authoring.revision) throw new Error(`Patch expected revision ${patch.baseRevision}, current revision is ${previous.sourceRevision}`);
  const overrides = new Map(previous.authoredInstances.map((instance) => [instance.id, instance]));
  const removed = new Set(previous.removedEntityIds);
  const invalidatedChunkIds = new Set<string>();
  const invalidateBounds = (minX: number, maxX: number, minZ: number, maxZ: number): void => {
    for (const chunk of previous.chunks) if (chunk.bounds.max[0] >= minX && chunk.bounds.min[0] <= maxX && chunk.bounds.max[1] >= minZ && chunk.bounds.min[1] <= maxZ) invalidatedChunkIds.add(chunk.id);
  };
  for (const operation of patch.operations) {
    if (operation.op === 'set-transform') {
      const entity = requireEntity(authoring.entities, operation.entityId);
      entity.transform = operation.transform;
      overrides.set(entity.id, runtimeInstance(entity));
    }
    if (operation.op === 'set-visual-state') {
      const entity = requireEntity(authoring.entities, operation.entityId);
      entity.visualState = { ...entity.visualState, ...operation.state };
      overrides.set(entity.id, runtimeInstance(entity));
    }
    if (operation.op === 'add-entity') {
      if (authoring.entities.some((entity) => entity.id === operation.entity.id)) throw new Error(`Entity ${operation.entity.id} already exists`);
      if (!authoring.prototypes.some((prototype) => prototype.id === operation.entity.prototypeId)) throw new Error(`Entity ${operation.entity.id} references an unknown prototype`);
      authoring.entities.push(operation.entity);
      overrides.set(operation.entity.id, runtimeInstance(operation.entity));
      removed.delete(operation.entity.id);
    }
    if (operation.op === 'remove-entity') {
      requireEntity(authoring.entities, operation.entityId);
      authoring.entities = authoring.entities.filter((entity) => entity.id !== operation.entityId);
      overrides.delete(operation.entityId);
      removed.add(operation.entityId);
    }
    if (operation.op === 'replace-prototype') {
      if (operation.provenance.id !== operation.prototype.provenanceId || operation.provenance.subjectId !== operation.prototype.id || operation.provenance.contentHash !== operation.prototype.assetHash || !operation.provenance.reviewedAt) throw new Error(`Replacement prototype ${operation.prototype.id} lacks matching reviewed provenance`);
      if (operation.sourceProvenance.some((record) => !record.reviewedAt || !record.license.commercialUse)) throw new Error(`Replacement prototype ${operation.prototype.id} has unreviewed or non-commercial source provenance`);
      const availableParentIds = new Set([...authoring.provenance, ...operation.sourceProvenance].map((record) => record.id));
      if (operation.provenance.parentIds.some((id) => !availableParentIds.has(id))) throw new Error(`Replacement prototype ${operation.prototype.id} has missing provenance parents`);
      for (const lod of operation.prototype.lods) {
        const provenance = operation.lodProvenance.find((record) => record.id === lod.provenanceId);
        if (!provenance || provenance.contentHash.toLowerCase() !== lod.contentHash.toLowerCase() || !provenance.reviewedAt) throw new Error(`Replacement prototype ${operation.prototype.id} LOD lacks matching reviewed provenance`);
      }
      if (authoring.provenance.some((record) => record.id === operation.provenance.id && record.contentHash !== operation.provenance.contentHash)) throw new Error(`Provenance ID ${operation.provenance.id} is already used for different content`);
      const replacementProvenance = [...operation.sourceProvenance, operation.provenance, ...operation.lodProvenance];
      const replacementIds = new Set(replacementProvenance.map((record) => record.id));
      authoring.provenance = [...authoring.provenance.filter((record) => !replacementIds.has(record.id)), ...replacementProvenance];
      const index = authoring.prototypes.findIndex((prototype) => prototype.id === operation.prototype.id);
      if (index < 0) authoring.prototypes.push(operation.prototype);
      else authoring.prototypes[index] = operation.prototype;
    }
    if (operation.op === 'set-environment') design = WorldDesignSpecSchema.parse({ ...design, environment: EnvironmentIntentSchema.parse({ ...design.environment, ...operation.values }) });
    if (operation.op === 'add-terrain-edit') {
      authoring.terrain.edits.push({ center: operation.center, radius: operation.radius, delta: operation.delta, mode: 'add' });
      invalidateBounds(operation.center[0] - operation.radius, operation.center[0] + operation.radius, operation.center[1] - operation.radius, operation.center[1] + operation.radius);
    }
    if (operation.op === 'set-region-density') {
      if (!design.regions.some((region) => region.id === operation.regionId)) throw new Error(`Unknown region ${operation.regionId}`);
      design = WorldDesignSpecSchema.parse({ ...design, regions: design.regions.map((region) => region.id === operation.regionId ? { ...region, density: operation.density } : region) });
      authoring.regions = authoring.regions.map((region) => region.id === operation.regionId ? { ...region, density: operation.density } : region);
      const region = design.regions.find((candidate) => candidate.id === operation.regionId)!;
      invalidateBounds(Math.min(...region.polygon.map((point) => point[0])), Math.max(...region.polygon.map((point) => point[0])), Math.min(...region.polygon.map((point) => point[1])), Math.max(...region.polygon.map((point) => point[1])));
    }
    if (operation.op === 'replace-region') {
      const index = design.regions.findIndex((region) => region.id === operation.region.id);
      if (index < 0) throw new Error(`Unknown region ${operation.region.id}`);
      const previousPolygon = design.regions[index]!.polygon;
      design = WorldDesignSpecSchema.parse({ ...design, regions: design.regions.map((region) => region.id === operation.region.id ? operation.region : region) });
      authoring.regions = authoring.regions.map((region) => region.id === operation.region.id ? { id: operation.region.id, polygon: operation.region.polygon, biome: operation.region.biome, density: operation.region.density } : region);
      authoring.visualZones = authoring.visualZones.map((zone) => zone.id === `zone-${operation.region.id}` ? { ...zone, polygon: operation.region.polygon, settings: { ...zone.settings, biome: operation.region.biome, density: operation.region.density } } : zone);
      const points = [...previousPolygon, ...operation.region.polygon];
      invalidateBounds(Math.min(...points.map((point) => point[0])), Math.max(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1])), Math.max(...points.map((point) => point[1])));
    }
    if (operation.op === 'invalidate-chunk') invalidatedChunkIds.add(operation.chunkId);
  }
  const timestamp = now.toISOString();
  authoring = AuthoringWorldSchema.parse({ ...authoring, revision: authoring.revision + 1, updatedAt: timestamp, appliedPatchIds: [...authoring.appliedPatchIds, patch.id] });
  const nextVersion = previous.bundleVersion + 1;
  const prototypes = authoring.prototypes.map(runtimePrototype);
  let bundle = assertValidBundle({
    ...previous,
    id: `${previous.worldId}-v${nextVersion}`,
    bundleVersion: nextVersion,
    createdAt: timestamp,
    sourceRevision: authoring.revision,
    environment: design.environment,
    terrain: previous.terrain ? { ...previous.terrain, edits: authoring.terrain.edits } : previous.terrain,
    regions: design.regions,
    features: design.features,
    style: design.style,
    prototypes,
    authoredInstances: [...overrides.values()],
    removedEntityIds: [...removed],
    provenance: authoring.provenance,
    chunks: previous.chunks.map((entry) => entry.source.kind === 'procedural' && invalidatedChunkIds.has(entry.id) ? {
      ...entry,
      source: { ...entry.source, contentHash: createHash('sha256').update(`${entry.source.contentHash}:${patch.id}`).digest('hex') },
    } : entry),
    optimization: {
      ...previous.optimization,
      meshLods: prototypes.every((prototype) => prototype.lods.length > 0),
      textureFormat: prototypes.some((prototype) => prototype.textureFormat !== 'none') && prototypes.filter((prototype) => prototype.textureFormat !== 'none').every((prototype) => prototype.textureFormat === 'ktx2') ? 'ktx2' : 'source',
    },
  });
  if (invalidatedChunkIds.size > 0) {
    const affected = bundle.chunks.filter((chunk) => invalidatedChunkIds.has(chunk.id));
    const regenerated = new Map<string, AuthoringEntity>();
    for (const entry of affected) {
      const chunk = generateReferenceChunk(bundle, entry.coordinate, { samples: 3 });
      for (const instance of chunk.instances) {
        if (!instance.id.startsWith('entity-')) continue;
        const parsedRegion = RegionIdSchema.safeParse(instance.visualState['regionId']);
        regenerated.set(instance.id, {
          id: instance.id,
          prototypeId: instance.prototypeId,
          name: instance.id,
          transform: transformFromMatrix(instance.matrix),
          ...(parsedRegion.success ? { regionId: parsedRegion.data } : {}),
          visualState: { ...instance.visualState, proceduralScatter: true },
          locked: false,
        });
      }
    }
    const isAffected = (entity: AuthoringEntity): boolean => entity.visualState['proceduralScatter'] === true && affected.some((chunk) => entity.transform.position[0] >= chunk.bounds.min[0] && entity.transform.position[0] < chunk.bounds.max[0] && entity.transform.position[2] >= chunk.bounds.min[1] && entity.transform.position[2] < chunk.bounds.max[1]);
    const entities: AuthoringEntity[] = [];
    for (const entity of authoring.entities) {
      if (!isAffected(entity)) { entities.push(entity); continue; }
      const replacement = regenerated.get(entity.id);
      if (replacement) { entities.push(replacement); regenerated.delete(entity.id); }
    }
    entities.push(...regenerated.values());
    authoring = AuthoringWorldSchema.parse({ ...authoring, entities });
    bundle = assertValidBundle(bundle);
  }
  return { designSpec: design, authoringWorld: authoring, bundle, invalidatesDetailedChunks: invalidatedChunkIds.size > 0, invalidatedChunkIds: [...invalidatedChunkIds].sort() };
}
