import { z } from 'zod';

export const ProvenanceRecordSchema = z.object({
  id: z.string().min(1),
  subjectId: z.string().min(1),
  kind: z.enum(['imported', 'generated', 'procedural', 'edited']),
  sourceUri: z.string().optional(),
  provider: z.string().optional(),
  modelId: z.string().optional(),
  modelRevision: z.string().optional(),
  promptHash: z.string().optional(),
  license: z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    commercialUse: z.boolean(),
    attribution: z.string().optional(),
  }),
  createdAt: z.string().datetime(),
  contentHash: z.string().min(1),
  parentIds: z.array(z.string()).default([]),
  reviewedAt: z.string().datetime().optional(),
});
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

export const ProviderTermsProfileSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  revision: z.string().min(1),
  termsUrl: z.string().url(),
  termsFingerprint: z.string().min(1),
  reviewedAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  permittedTerritories: z.array(z.string()).min(1),
  commercialUse: z.boolean(),
  notices: z.array(z.string()).default([]),
  outputConditions: z.string(),
  retention: z.string(),
  trainingUse: z.string(),
  contentRestrictions: z.array(z.string()).default([]),
  cost: z.object({ unit: z.string(), usd: z.number().nonnegative() }),
  enabled: z.boolean().default(false),
});
export type ProviderTermsProfile = z.infer<typeof ProviderTermsProfileSchema>;
