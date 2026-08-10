import { z } from 'zod';
import { WorldPatchSchema } from './patch.js';
import { WorldDesignSpecSchema } from './design.js';
import { VisualWorldBundleSchema } from './bundle.js';
import { AssetLodSchema } from './authoring.js';
import { ProvenanceRecordSchema } from './provenance.js';
import { PrototypeIdSchema } from './primitives.js';
import { ProviderRoleSchema, QualityProfileSchema, RefinementPolicySchema } from './quality.js';

export const AssetLibraryEntrySchema = z.object({
  id: PrototypeIdSchema,
  class: z.string().min(1),
  assetUri: z.string().min(1),
  contentHash: z.string().regex(/^[a-f\d]{64}$/i),
  textureFormat: z.enum(['ktx2', 'source', 'none']).default('source'),
  boundsRadius: z.number().positive(),
  lods: z.array(AssetLodSchema).default([]),
  materialVariants: z.array(z.string()).default([]),
  animationClips: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  provenance: ProvenanceRecordSchema,
  sourceProvenance: z.array(ProvenanceRecordSchema).default([]),
  lodProvenance: z.array(ProvenanceRecordSchema).default([]),
  rightsAffirmed: z.literal(true),
});
export type AssetLibraryEntry = z.infer<typeof AssetLibraryEntrySchema>;

export const CompileRequestSchema = z.object({
  prompt: z.string().min(1),
  seed: z.number().int().nonnegative(),
  maxCostUsd: z.number().nonnegative(),
  maxAssetGenerations: z.number().int().nonnegative(),
  maxReferenceImages: z.number().int().nonnegative().default(0),
  territory: z.string().min(2),
  commercialUse: z.boolean(),
  dryRun: z.boolean().default(true),
  qualityProfile: QualityProfileSchema.default('local'),
  heroRegionIds: z.array(z.string().min(1)).max(5).default([]),
  refinementPolicy: RefinementPolicySchema,
  providerModels: z.array(z.object({ provider: z.string(), modelId: z.string(), revision: z.string(), termsFingerprint: z.string(), role: ProviderRoleSchema.optional() })).default([]),
  designSpec: WorldDesignSpecSchema.optional(),
  assetLibrary: z.array(AssetLibraryEntrySchema).default([]),
}).superRefine((request, context) => {
  if (request.designSpec && request.designSpec.seed !== request.seed) context.addIssue({ code: 'custom', path: ['designSpec', 'seed'], message: 'designSpec seed must match compile seed' });
  if (new Set(request.heroRegionIds).size !== request.heroRegionIds.length) context.addIssue({ code: 'custom', path: ['heroRegionIds'], message: 'Hero region IDs must be unique' });
  if (request.qualityProfile === 'local' && request.refinementPolicy.terrainCoDeformation) context.addIssue({ code: 'custom', path: ['refinementPolicy', 'terrainCoDeformation'], message: 'Local profile cannot run Blender terrain co-deformation' });
  if (request.qualityProfile === 'studio' && request.maxCostUsd > 100) context.addIssue({ code: 'custom', path: ['maxCostUsd'], message: 'Studio hard maximum is USD 100 per world' });
  if (request.qualityProfile === 'cheap' && request.maxCostUsd > 15) context.addIssue({ code: 'custom', path: ['maxCostUsd'], message: 'Cheap hard maximum is USD 15 per world' });
  request.assetLibrary.forEach((entry, index) => {
    const path = ['assetLibrary', index] as const;
    if (entry.provenance.subjectId !== entry.id) context.addIssue({ code: 'custom', path: [...path, 'provenance', 'subjectId'], message: 'asset provenance subject must match its prototype id' });
    if (entry.provenance.contentHash.toLowerCase() !== entry.contentHash.toLowerCase()) context.addIssue({ code: 'custom', path: [...path, 'provenance', 'contentHash'], message: 'asset provenance content hash must match its GLB content hash' });
    if (!entry.provenance.reviewedAt) context.addIssue({ code: 'custom', path: [...path, 'provenance', 'reviewedAt'], message: 'asset library entries supplied by callers must already be reviewed' });
    if (request.commercialUse && !entry.provenance.license.commercialUse) context.addIssue({ code: 'custom', path: [...path, 'provenance', 'license', 'commercialUse'], message: 'asset is not approved for commercial use' });
    entry.sourceProvenance.forEach((provenance, sourceIndex) => {
      if (!provenance.reviewedAt) context.addIssue({ code: 'custom', path: [...path, 'sourceProvenance', sourceIndex, 'reviewedAt'], message: 'source provenance supplied by callers must already be reviewed' });
      if (request.commercialUse && !provenance.license.commercialUse) context.addIssue({ code: 'custom', path: [...path, 'sourceProvenance', sourceIndex, 'license', 'commercialUse'], message: 'source artifact is not approved for commercial use' });
    });
    entry.lods.forEach((lod, lodIndex) => {
      const provenance = entry.lodProvenance.find((record) => record.id === lod.provenanceId);
      if (!provenance) context.addIssue({ code: 'custom', path: [...path, 'lods', lodIndex, 'provenanceId'], message: 'LOD must reference supplied provenance' });
      else {
        if (provenance.contentHash.toLowerCase() !== lod.contentHash.toLowerCase()) context.addIssue({ code: 'custom', path: [...path, 'lodProvenance'], message: 'LOD provenance content hash must match its GLB content hash' });
        if (!provenance.reviewedAt) context.addIssue({ code: 'custom', path: [...path, 'lodProvenance'], message: 'LOD provenance supplied by callers must already be reviewed' });
        if (request.commercialUse && !provenance.license.commercialUse) context.addIssue({ code: 'custom', path: [...path, 'lodProvenance'], message: 'LOD is not approved for commercial use' });
      }
    });
  });
});
export type CompileRequest = z.infer<typeof CompileRequestSchema>;

export const RegenerateRequestSchema = z.object({
  worldId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  prompt: z.string().min(1),
  regionIds: z.array(z.string()).default([]),
  maxCostUsd: z.number().nonnegative(),
  maxAssetGenerations: z.number().int().nonnegative(),
  designSpec: WorldDesignSpecSchema.optional(),
  bundle: VisualWorldBundleSchema.optional(),
}).superRefine((request, context) => {
  if ((request.designSpec === undefined) !== (request.bundle === undefined)) context.addIssue({ code: 'custom', message: 'designSpec and bundle must be supplied together for standalone regeneration' });
  if (request.bundle && request.bundle.worldId !== request.worldId) context.addIssue({ code: 'custom', path: ['bundle', 'worldId'], message: 'bundle worldId must match regeneration worldId' });
  if (request.bundle && request.bundle.sourceRevision !== request.baseRevision) context.addIssue({ code: 'custom', path: ['baseRevision'], message: 'baseRevision must match bundle sourceRevision' });
});
export type RegenerateRequest = z.infer<typeof RegenerateRequestSchema>;

export const ChunkCompileRequestSchema = z.object({
  worldId: z.string().min(1),
  x: z.number().int(),
  z: z.number().int(),
  maxCostUsd: z.number().nonnegative(),
  maxAssetGenerations: z.number().int().nonnegative(),
  explicit: z.literal(true),
  bundle: VisualWorldBundleSchema.optional(),
}).superRefine((request, context) => {
  if (request.bundle && request.bundle.worldId !== request.worldId) context.addIssue({ code: 'custom', path: ['bundle', 'worldId'], message: 'bundle worldId must match chunk worldId' });
});
export type ChunkCompileRequest = z.infer<typeof ChunkCompileRequestSchema>;

export const CompileEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  compileId: z.string().min(1),
  type: z.enum(['queued', 'phase-started', 'progress', 'artifact', 'cost', 'completed', 'failed', 'cancelled']),
  phase: z.string().optional(),
  progress: z.number().min(0).max(1),
  message: z.string(),
  timestamp: z.string().datetime(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type CompileEvent = z.infer<typeof CompileEventSchema>;

export type RegenerationPatch = z.infer<typeof WorldPatchSchema>;

export interface WorldCompiler {
  compile(request: CompileRequest): AsyncIterable<CompileEvent>;
  regenerate(request: RegenerateRequest): AsyncIterable<CompileEvent>;
  requestChunk(request: ChunkCompileRequest): AsyncIterable<CompileEvent>;
}
