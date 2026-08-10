import { z } from 'zod';
import { PrototypeIdSchema, RegionIdSchema } from './primitives.js';

export const GenerationArtifactKindSchema = z.enum([
  'terrain-heightfield', 'terrain-splat', 'terrain-base-color', 'terrain-normal', 'terrain-roughness',
  'terrain-rgb', 'terrain-depth', 'terrain-semantic', 'terrain-instance', 'regional-composition',
  'object-mask', 'object-crop', 'object-isolated', 'object-diagnostic', 'object-multiview-front', 'object-multiview-left',
  'object-multiview-back', 'object-multiview-right', 'raw-glb', 'refined-glb',
  'blender-rgb', 'blender-depth', 'blender-normal', 'blender-semantic', 'blender-instance', 'placement-atlas',
  'threejs-render', 'review-report', 'compile-report',
]);
export type GenerationArtifactKind = z.infer<typeof GenerationArtifactKindSchema>;

export const GenerationArtifactSchema = z.object({
  id: z.string().min(1),
  compileId: z.string().min(1),
  kind: GenerationArtifactKindSchema,
  phase: z.string().min(1),
  uri: z.string().min(1),
  contentHash: z.string().regex(/^[a-f\d]{64}$/i),
  contentType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  regionId: RegionIdSchema.optional(),
  prototypeId: PrototypeIdSchema.optional(),
  attemptId: z.string().min(1).optional(),
  parentIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type GenerationArtifact = z.infer<typeof GenerationArtifactSchema>;

export const RefinementActionTypeSchema = z.enum([
  'regenerate-composition', 'regenerate-multiview', 'reconstruct-mesh', 'adjust-transform',
  'adjust-material', 'adjust-environment', 'fit-support', 'adjust-terrain', 'rerender',
]);
export type RefinementActionType = z.infer<typeof RefinementActionTypeSchema>;

export const RefinementActionSchema = z.object({
  id: z.string().min(1),
  type: RefinementActionTypeSchema,
  targetId: z.string().min(1),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  reservedCostUsd: z.number().nonnegative().default(0),
  reason: z.string().min(1),
});
export type RefinementAction = z.infer<typeof RefinementActionSchema>;

export const RefinementDecisionSchema = z.object({
  id: z.string().min(1),
  compileId: z.string().min(1),
  attemptId: z.string().min(1),
  approved: z.boolean(),
  diagnosis: z.array(z.object({
    code: z.enum(['composition-drift', 'terrain-mask-mismatch', 'identity-drift', 'mesh-invalid', 'silhouette-mismatch', 'camera-drift', 'floating', 'penetration', 'material-mismatch', 'environment-mismatch']),
    severity: z.enum(['warning', 'error']),
    targetId: z.string().min(1),
    measured: z.number().optional(),
    threshold: z.number().optional(),
    message: z.string().min(1),
  })).default([]),
  actions: z.array(RefinementActionSchema).default([]),
  createdAt: z.string().datetime(),
});
export type RefinementDecision = z.infer<typeof RefinementDecisionSchema>;

export const GenerationAttemptSchema = z.object({
  id: z.string().min(1),
  compileId: z.string().min(1),
  phase: z.enum(['terrain', 'composition', 'segmentation', 'multiview', 'reconstruction', 'asset-validation', 'placement', 'scene-refinement', 'review', 'publication']),
  index: z.number().int().nonnegative(),
  status: z.enum(['in-progress', 'passed', 'rejected', 'failed', 'cancelled']),
  provider: z.string().optional(),
  modelId: z.string().optional(),
  revision: z.string().optional(),
  reservedCostUsd: z.number().nonnegative().default(0),
  actualCostUsd: z.number().nonnegative().default(0),
  artifactIds: z.array(z.string().min(1)).default([]),
  rejectionReason: z.string().optional(),
  plannedAction: RefinementActionSchema.optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type GenerationAttempt = z.infer<typeof GenerationAttemptSchema>;

export const CompileRunStatusSchema = z.enum(['queued', 'in-progress', 'needs-attention', 'rejected', 'published', 'failed', 'cancelled']);
export type CompileRunStatus = z.infer<typeof CompileRunStatusSchema>;

export const CompileReportSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  compileId: z.string().min(1),
  status: CompileRunStatusSchema,
  qualityProfile: z.enum(['local', 'cheap', 'studio']),
  cost: z.object({ reservedUsd: z.number().nonnegative(), actualUsd: z.number().nonnegative(), capUsd: z.number().nonnegative() }),
  providerRevisions: z.array(z.object({ provider: z.string(), modelId: z.string(), revision: z.string(), termsFingerprint: z.string() })).default([]),
  artifactIds: z.array(z.string()).default([]),
  attemptIds: z.array(z.string()).default([]),
  rejectionReason: z.string().optional(),
  plannedAction: RefinementActionSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CompileReport = z.infer<typeof CompileReportSchema>;
