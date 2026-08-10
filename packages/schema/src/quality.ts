import { z } from 'zod';

export const QualityProfileSchema = z.enum(['local', 'cheap', 'studio']);
export type QualityProfile = z.infer<typeof QualityProfileSchema>;

export const ProviderRoleSchema = z.enum([
  'planner',
  'reviewer',
  'composition-image',
  'object-detection',
  'segmentation',
  'multiview-image',
  'image-to-3d',
  'retexture',
]);
export type ProviderRole = z.infer<typeof ProviderRoleSchema>;

export const RefinementPolicySchema = z.object({
  maxAssetRepairRounds: z.number().int().min(0).max(2).default(0),
  maxSceneRepairRounds: z.number().int().min(0).max(1).default(0),
  terrainCoDeformation: z.boolean().default(false),
}).default({ maxAssetRepairRounds: 0, maxSceneRepairRounds: 0, terrainCoDeformation: false });
export type RefinementPolicy = z.infer<typeof RefinementPolicySchema>;

export const QualityDimensionSchema = z.enum([
  'composition-style',
  'asset-reconstruction',
  'terrain-coherence',
  'placement-contact',
  'editability-provenance',
  'runtime-quality-performance',
  'reliability-cost-reproducibility',
]);
export type QualityDimension = z.infer<typeof QualityDimensionSchema>;

export const QualityDimensionScoreSchema = z.object({
  dimension: QualityDimensionSchema,
  score: z.number().min(0).max(100),
  weight: z.number().positive().max(1),
  evidenceIds: z.array(z.string().min(1)).default([]),
  notes: z.array(z.string()).default([]),
});
export type QualityDimensionScore = z.infer<typeof QualityDimensionScoreSchema>;

export const QualityHardGateSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  message: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).default([]),
});

export const QualityAttemptSchema = z.object({
  id: z.string().min(1),
  phase: z.string().min(1),
  status: z.enum(['passed', 'failed', 'cancelled', 'skipped']),
  provider: z.string().optional(),
  modelId: z.string().optional(),
  revision: z.string().optional(),
  costUsd: z.number().nonnegative().default(0),
  durationMs: z.number().nonnegative().default(0),
  message: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).default([]),
});

export const QualityProviderRecordSchema = z.object({
  role: ProviderRoleSchema,
  provider: z.string().min(1),
  modelId: z.string().min(1),
  revision: z.string().min(1),
  termsFingerprint: z.string().min(1),
});

export const QualityScenarioResultSchema = z.object({
  id: z.string().min(1),
  score: z.number().min(0).max(100),
  passed: z.boolean(),
  evidenceIds: z.array(z.string().min(1)).default([]),
});

export const QualityCertificationSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  benchmarkId: z.string().min(1),
  rubricVersion: z.literal('visual-world-parity-v1'),
  referenceBaseline: z.literal('WorldClaw-paper-figures-4-8'),
  evaluatorProtocol: z.literal('blinded-side-by-side-v1'),
  qualityProfile: QualityProfileSchema,
  targetScore: z.number().min(0).max(100).default(90),
  weightedScore: z.number().min(0).max(100),
  dimensions: z.array(QualityDimensionScoreSchema).length(7),
  hardGates: z.array(QualityHardGateSchema).min(1),
  scenarios: z.array(QualityScenarioResultSchema).min(1),
  raterCount: z.number().int().min(3),
  raterAgreement: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().min(1)).default([]),
  providers: z.array(QualityProviderRecordSchema).default([]),
  attempts: z.array(QualityAttemptSchema).default([]),
  actualCostUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  certified: z.boolean(),
  createdAt: z.string().datetime(),
}).superRefine((certification, context) => {
  const dimensions = new Set(certification.dimensions.map((item) => item.dimension));
  if (dimensions.size !== certification.dimensions.length) context.addIssue({ code: 'custom', path: ['dimensions'], message: 'Quality dimensions must be unique' });
  const weight = certification.dimensions.reduce((sum, item) => sum + item.weight, 0);
  if (Math.abs(weight - 1) > 0.000_001) context.addIssue({ code: 'custom', path: ['dimensions'], message: 'Quality dimension weights must sum to 1' });
  const calculated = certification.dimensions.reduce((sum, item) => sum + item.score * item.weight, 0);
  if (Math.abs(calculated - certification.weightedScore) > 0.01) context.addIssue({ code: 'custom', path: ['weightedScore'], message: 'Weighted score must equal the weighted dimension total' });
  const qualifies = certification.weightedScore >= certification.targetScore
    && certification.dimensions.every((item) => item.score >= 80)
    && certification.hardGates.every((gate) => gate.passed)
    && certification.scenarios.every((scenario) => scenario.passed && scenario.score >= certification.targetScore)
    && (certification.raterAgreement >= 0.67 || certification.raterCount >= 5);
  if (certification.certified !== qualifies) context.addIssue({ code: 'custom', path: ['certified'], message: 'Certified must reflect score, dimension, and hard-gate thresholds' });
  if (certification.certified && certification.scenarios.some((scenario) => scenario.evidenceIds.length === 0)) context.addIssue({ code: 'custom', path: ['scenarios'], message: 'Certified scenario scores require immutable evidence' });
});
export type QualityCertification = z.infer<typeof QualityCertificationSchema>;

export const QUALITY_DIMENSION_WEIGHTS: Readonly<Record<QualityDimension, number>> = {
  'composition-style': 0.30,
  'asset-reconstruction': 0.20,
  'terrain-coherence': 0.15,
  'placement-contact': 0.10,
  'editability-provenance': 0.10,
  'runtime-quality-performance': 0.10,
  'reliability-cost-reproducibility': 0.05,
};
