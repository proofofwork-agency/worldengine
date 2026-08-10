import { z } from 'zod';
import { ProvenanceRecordSchema } from './provenance.js';
import { CalibratedRegionalCameraSchema, TerrainMaterialSetSchema, TerrainPlanSchema, WorldFeatureSpecSchema } from './design.js';
import {
  Bounds2Schema,
  ChunkCoordinateSchema,
  EntityIdSchema,
  PrototypeIdSchema,
  RegionIdSchema,
  TransformSchema,
  Vec2Schema,
  WORLD_FORMAT_VERSION,
} from './primitives.js';
import { QualityCertificationSchema, QualityProfileSchema } from './quality.js';

export const AssetLodSchema = z.object({
  distance: z.number().nonnegative(),
  assetUri: z.string().min(1),
  contentHash: z.string().regex(/^[a-f\d]{64}$/i),
  provenanceId: z.string().min(1),
});

export const PrototypeSchema = z.object({
  id: PrototypeIdSchema,
  name: z.string().min(1),
  assetUri: z.string(),
  assetHash: z.string().regex(/^[a-f\d]{64}$/i),
  textureFormat: z.enum(['ktx2', 'source', 'none']).default('source'),
  bounds: z.object({ min: z.tuple([z.number(), z.number(), z.number()]), max: z.tuple([z.number(), z.number(), z.number()]) }),
  lods: z.array(AssetLodSchema).default([]),
  materialVariants: z.array(z.string()).default([]),
  animationClips: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  provenanceId: z.string().min(1),
});

export const AuthoringEntitySchema = z.object({
  id: EntityIdSchema,
  prototypeId: PrototypeIdSchema,
  name: z.string().min(1),
  transform: TransformSchema,
  regionId: RegionIdSchema.optional(),
  parentId: EntityIdSchema.optional(),
  visualState: z.record(z.string(), z.unknown()).default({}),
  locked: z.boolean().default(false),
});

export const TerrainEditSchema = z.object({
  center: Vec2Schema,
  radius: z.number().positive(),
  delta: z.number().default(0),
  mode: z.enum(['add', 'flatten', 'smooth']).default('add'),
  targetHeight: z.number().optional(),
}).superRefine((edit, context) => {
  if ((edit.mode === 'flatten' || edit.mode === 'smooth') && edit.targetHeight === undefined) context.addIssue({ code: 'custom', path: ['targetHeight'], message: `${edit.mode} terrain edits require a target height` });
});

export const ProceduralTerrainSourceSchema = z.object({
  kind: z.literal('procedural'),
  seed: z.number().int().nonnegative(),
  amplitude: z.number().nonnegative(),
  frequency: z.number().positive(),
  edits: z.array(TerrainEditSchema).default([]),
});

export const CompiledHeightfieldTerrainSourceSchema = z.object({
  kind: z.literal('compiled-heightfield'),
  seed: z.number().int().nonnegative(),
  heightfieldUri: z.string().min(1),
  contentHash: z.string().regex(/^[a-f\d]{64}$/i),
  samples: z.number().int().min(3),
  encoding: z.literal('float32'),
  terrainPlan: TerrainPlanSchema,
  materialSets: z.array(TerrainMaterialSetSchema).min(1),
  splatMapUris: z.array(z.string().min(1)).min(1),
  edits: z.array(TerrainEditSchema).default([]),
  footprintEdits: z.array(z.object({ footprint: z.array(Vec2Schema).min(3), targetHeight: z.number(), mode: z.enum(['raise', 'lower', 'flatten', 'smooth']).default('flatten'), supportMarginMeters: z.literal(2), falloffEndMeters: z.literal(5) })).default([]),
});

export const TerrainSourceSchema = z.discriminatedUnion('kind', [ProceduralTerrainSourceSchema, CompiledHeightfieldTerrainSourceSchema]);

export const ReferenceImageSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['terrain-reference', 'region-concept', 'object-isolated', 'object-crop', 'object-mask', 'object-multiview', 'object-diagnostic', 'placement-diagnostic', 'blender-rgb', 'blender-depth', 'blender-normal', 'blender-semantic', 'blender-instance', 'quality-evidence']),
  uri: z.string().min(1),
  contentHash: z.string().regex(/^[a-f\d]{64}$/i),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  regionId: RegionIdSchema.optional(),
  prototypeId: PrototypeIdSchema.optional(),
  benchmarkScenarioId: z.string().min(1).optional(),
  provenanceId: z.string().min(1),
}).superRefine((reference, context) => {
  if ((reference.kind === 'terrain-reference' || reference.kind === 'region-concept') && !reference.regionId) context.addIssue({ code: 'custom', path: ['regionId'], message: 'Terrain and region references require a region ID' });
  if (['object-isolated', 'object-crop', 'object-mask', 'object-multiview', 'object-diagnostic'].includes(reference.kind) && !reference.prototypeId) context.addIssue({ code: 'custom', path: ['prototypeId'], message: 'Object references require a prototype ID' });
  if (reference.kind === 'quality-evidence' && !reference.benchmarkScenarioId) context.addIssue({ code: 'custom', path: ['benchmarkScenarioId'], message: 'Quality evidence requires a benchmark scenario ID' });
  if (reference.kind !== 'quality-evidence' && reference.benchmarkScenarioId) context.addIssue({ code: 'custom', path: ['benchmarkScenarioId'], message: 'Only quality evidence may identify a benchmark scenario' });
});

export const RegionalCompositionSchema = z.object({
  id: z.string().min(1),
  regionId: RegionIdSchema,
  camera: z.object({
    id: z.string().min(1),
    position: z.tuple([z.number(), z.number(), z.number()]),
    target: z.tuple([z.number(), z.number(), z.number()]),
    up: z.tuple([z.number(), z.number(), z.number()]),
    verticalFovDegrees: z.number().positive().max(179),
    aspect: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  objects: z.array(z.object({
    id: z.string().min(1),
    assetClass: z.string().min(1),
    description: z.string().min(1),
    screenBox: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive() }),
    desiredHeightMeters: z.number().positive(),
    tags: z.array(z.string()).default([]),
    entityId: EntityIdSchema.optional(),
    cropTransform: z.object({
      compositionToCrop: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
      cropToComposition: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
      sourceBox: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
    }).optional(),
  })).min(1),
  calibratedCamera: CalibratedRegionalCameraSchema.optional(),
});

export const AuthoringWorldSchema = z.object({
  format: z.literal('AuthoringWorld'),
  version: z.literal(WORLD_FORMAT_VERSION),
  id: z.string().min(1),
  designSpecId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  seed: z.number().int().nonnegative(),
  qualityProfile: QualityProfileSchema.default('local'),
  bounds: Bounds2Schema,
  chunkSize: z.number().positive(),
  terrainSamples: z.number().int().min(3),
  terrain: TerrainSourceSchema,
  prototypes: z.array(PrototypeSchema),
  entities: z.array(AuthoringEntitySchema),
  regions: z.array(z.object({ id: RegionIdSchema, polygon: z.array(Vec2Schema).min(3), biome: z.string(), density: z.number().min(0).max(1).default(0.5) })),
  features: z.array(WorldFeatureSpecSchema).default([]),
  referenceImages: z.array(ReferenceImageSchema).default([]),
  regionalCompositions: z.array(RegionalCompositionSchema).default([]),
  visualZones: z.array(z.object({ id: z.string(), polygon: z.array(Vec2Schema).min(3), settings: z.record(z.string(), z.unknown()) })).default([]),
  chunkOverrides: z.array(z.object({ coordinate: ChunkCoordinateSchema, dataUri: z.string() })).default([]),
  diagnostics: z.array(z.object({ severity: z.enum(['info', 'warning', 'error']), code: z.string(), message: z.string(), subjectId: z.string().optional() })).default([]),
  provenance: z.array(ProvenanceRecordSchema),
  qualityCertification: QualityCertificationSchema.optional(),
  appliedPatchIds: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Prototype = z.infer<typeof PrototypeSchema>;
export type AssetLod = z.infer<typeof AssetLodSchema>;
export type AuthoringEntity = z.infer<typeof AuthoringEntitySchema>;
export type TerrainSource = z.infer<typeof TerrainSourceSchema>;
export type TerrainEdit = z.infer<typeof TerrainEditSchema>;
export type ReferenceImage = z.infer<typeof ReferenceImageSchema>;
export type RegionalComposition = z.infer<typeof RegionalCompositionSchema>;
export type AuthoringWorld = z.infer<typeof AuthoringWorldSchema>;
