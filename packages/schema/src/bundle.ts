import { z } from 'zod';
import { EnvironmentIntentSchema, TerrainMaterialSetSchema, TerrainPlanSchema, VisualStyleSchema } from './design.js';
import { ProvenanceRecordSchema } from './provenance.js';
import { Bounds2Schema, ChunkCoordinateSchema, ChunkIdSchema, EntityIdSchema, Mat4Schema, PrototypeIdSchema, WORLD_FORMAT_VERSION } from './primitives.js';
import { RegionSpecSchema, WorldFeatureSpecSchema } from './design.js';
import { AssetLodSchema, TerrainEditSchema } from './authoring.js';
import { QualityCertificationSchema, QualityProfileSchema } from './quality.js';

export const ChunkSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uri'), uri: z.string(), contentHash: z.string().regex(/^[a-f\d]{64}$/i), byteLength: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('procedural'), seed: z.number().int().nonnegative(), generator: z.literal('worldengine-terrain-v1'), contentHash: z.string().regex(/^[a-f\d]{64}$/i) }),
  z.object({ kind: z.literal('compiled-heightfield'), seed: z.number().int().nonnegative(), generator: z.literal('worldengine-terrain-v2'), contentHash: z.string().regex(/^[a-f\d]{64}$/i), heightfieldDependency: z.string().min(1), splatDependencies: z.array(z.string().min(1)).min(1), textureDependencies: z.array(z.string().min(1)).min(1) }),
]);

export const RuntimePrototypeSchema = z.object({
  id: PrototypeIdSchema,
  assetUri: z.string(),
  contentHash: z.string().regex(/^[a-f\d]{64}$/i),
  textureFormat: z.enum(['ktx2', 'source', 'none']).default('source'),
  lods: z.array(AssetLodSchema).default([]),
  materialVariants: z.array(z.string()).default([]),
  animationClips: z.array(z.string()).default([]),
  boundsRadius: z.number().positive(),
  tags: z.array(z.string()).default([]),
});

export const RuntimeInstanceSchema = z.object({
  id: EntityIdSchema,
  prototypeId: PrototypeIdSchema,
  matrix: Mat4Schema,
  visualState: z.record(z.string(), z.unknown()).default({}),
});
export type RuntimeInstance = z.infer<typeof RuntimeInstanceSchema>;

export const RuntimeChunkDocumentSchema = z.object({
  format: z.literal('RuntimeChunk'),
  version: z.literal(WORLD_FORMAT_VERSION),
  id: ChunkIdSchema,
  coordinate: ChunkCoordinateSchema,
  bounds: Bounds2Schema,
  terrain: z.object({
    samples: z.number().int().min(3),
    encoding: z.literal('float32-base64'),
    heights: z.string(),
    minHeight: z.number(),
    maxHeight: z.number(),
    biomeWeights: z.string().optional(),
    materialSplats: z.array(z.object({ materialSetId: z.string().min(1), encoding: z.literal('uint8-base64'), weights: z.string() })).default([]),
    textureDependencies: z.array(z.string().min(1)).default([]),
  }),
  instances: z.array(RuntimeInstanceSchema),
  dependencies: z.array(z.string()).default([]),
  occlusionCells: z.array(z.object({
    id: z.string().min(1),
    bounds: Bounds2Schema,
    minHeight: z.number(),
    maxHeight: z.number(),
    instanceIds: z.array(EntityIdSchema),
  })).default([]),
  placeholder: z.boolean().default(false),
});
export type RuntimeChunkDocument = z.infer<typeof RuntimeChunkDocumentSchema>;

export const VisualWorldBundleSchema = z.object({
  format: z.literal('VisualWorldBundle'),
  version: z.literal(WORLD_FORMAT_VERSION),
  id: z.string().min(1),
  worldId: z.string().min(1),
  bundleVersion: z.number().int().positive(),
  immutable: z.literal(true),
  createdAt: z.string().datetime(),
  seed: z.number().int().nonnegative(),
  qualityProfile: QualityProfileSchema.default('local'),
  coordinateSystem: z.literal('right-handed-y-up'),
  units: z.literal('meters'),
  bounds: Bounds2Schema,
  chunkSize: z.number().positive(),
  terrainSamples: z.number().int().min(3),
  terrain: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('procedural'), seed: z.number().int().nonnegative(), amplitude: z.number().nonnegative(), frequency: z.number().positive(), edits: z.array(TerrainEditSchema).default([]) }),
    z.object({
      kind: z.literal('compiled-heightfield'), seed: z.number().int().nonnegative(), heightfieldUri: z.string().min(1), contentHash: z.string().regex(/^[a-f\d]{64}$/i),
      samples: z.number().int().min(3), encoding: z.literal('float32'), terrainPlan: TerrainPlanSchema,
      materialSets: z.array(TerrainMaterialSetSchema).min(1), splatMapUris: z.array(z.string().min(1)).min(1), edits: z.array(TerrainEditSchema).default([]),
      footprintEdits: z.array(z.object({ footprint: z.array(z.tuple([z.number(), z.number()])).min(3), targetHeight: z.number(), mode: z.enum(['raise', 'lower', 'flatten', 'smooth']).default('flatten'), supportMarginMeters: z.literal(2), falloffEndMeters: z.literal(5) })).default([]),
    }),
  ]).optional(),
  regions: z.array(RegionSpecSchema).default([]),
  features: z.array(WorldFeatureSpecSchema).default([]),
  style: VisualStyleSchema,
  environment: EnvironmentIntentSchema,
  prototypes: z.array(RuntimePrototypeSchema),
  authoredInstances: z.array(RuntimeInstanceSchema).default([]),
  removedEntityIds: z.array(EntityIdSchema).default([]),
  chunks: z.array(z.object({
    id: ChunkIdSchema,
    coordinate: ChunkCoordinateSchema,
    bounds: Bounds2Schema,
    source: ChunkSourceSchema,
    dependencies: z.array(z.string()).default([]),
  })),
  provenance: z.array(ProvenanceRecordSchema),
  qualityCertification: QualityCertificationSchema.optional(),
  sourceRevision: z.number().int().nonnegative(),
  optimization: z.object({
    meshLods: z.boolean(),
    textureFormat: z.enum(['ktx2', 'source']),
    instanceGroups: z.boolean(),
    occlusionMetadata: z.boolean(),
    terrainLodSamples: z.array(z.number().int().min(3)).default([65, 33, 17]),
    occlusionCellSize: z.number().positive().default(64),
  }),
});
export type VisualWorldBundle = z.infer<typeof VisualWorldBundleSchema>;
