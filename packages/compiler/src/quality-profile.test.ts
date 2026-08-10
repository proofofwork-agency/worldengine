import { describe, expect, it } from 'vitest';
import { CompileRequestSchema, QUALITY_DIMENSION_WEIGHTS, type ProviderRole, type QualityDimension } from '@worldengine/schema';
import { createQualityCertification, PAPER_DERIVED_BENCHMARK_SCENARIOS, renderQualityReportHtml } from './quality-benchmark.js';
import { assertQualityProfileRequest, effectiveQualityProfile, providerForRole } from './quality-profile.js';

const fingerprint = 'a'.repeat(64);
const model = (provider: string, role: ProviderRole) => ({ provider, modelId: `${provider}-model`, revision: 'r1', termsFingerprint: fingerprint, role });

describe('quality profiles and certification', () => {
  it('keeps legacy cloud requests compatible while enforcing bounded Cheap limits', () => {
    const request = CompileRequestSchema.parse({ prompt: 'world', seed: 1, maxCostUsd: 10, maxAssetGenerations: 2, maxReferenceImages: 1, territory: 'NL', commercialUse: true, providerModels: [
      { provider: 'openrouter', modelId: 'planner', revision: 'r1', termsFingerprint: fingerprint },
      { provider: 'openai', modelId: 'image', revision: 'r1', termsFingerprint: fingerprint },
      { provider: 'wavespeed', modelId: 'mesh', revision: 'r1', termsFingerprint: fingerprint },
    ] });
    expect(effectiveQualityProfile(request)).toBe('cheap');
    expect(() => assertQualityProfileRequest(request)).not.toThrow();
    expect(providerForRole(request, 'reviewer')?.provider).toBe('openrouter');
    const missing = CompileRequestSchema.parse({ ...request, qualityProfile: 'cheap', providerModels: [] });
    expect(() => assertQualityProfileRequest(missing)).toThrow('missing provider roles');
  });

  it('requires every explicit Studio role plus bounded repair and co-deformation', () => {
    const roles: Array<[string, ProviderRole]> = [
      ['openrouter', 'planner'], ['openrouter', 'reviewer'], ['openrouter', 'object-detection'], ['openrouter-image', 'composition-image'],
      ['openrouter-image', 'multiview-image'], ['sam2-local', 'segmentation'], ['wavespeed', 'image-to-3d'],
    ];
    const request = CompileRequestSchema.parse({ prompt: 'studio world', seed: 2, qualityProfile: 'studio', heroRegionIds: ['region-1'], maxCostUsd: 100, maxAssetGenerations: 6, maxReferenceImages: 1, territory: 'NL', commercialUse: true, providerModels: roles.map(([provider, role]) => role === 'image-to-3d' ? { ...model(provider, role), modelId: 'tripo3d/h3.1/multiview-to-3d' } : role === 'composition-image' || role === 'multiview-image' ? { ...model(provider, role), modelId: 'openai/gpt-image-2' } : model(provider, role)), refinementPolicy: { maxTerrainRounds: 3, maxCompositionAttempts: 3, maxAssetAttempts: 2, maxSceneRounds: 3, maxAssetRepairRounds: 2, maxSceneRepairRounds: 1, terrainCoDeformation: true } });
    expect(() => assertQualityProfileRequest(request)).not.toThrow();
    expect(providerForRole(request, 'image-to-3d')?.provider).toBe('wavespeed');
    expect(() => assertQualityProfileRequest({ ...request, refinementPolicy: { ...request.refinementPolicy, terrainCoDeformation: false } })).toThrow('co-deformation');
    const directImage = { ...request, providerModels: request.providerModels.map((selection) => selection.role === 'composition-image' ? { ...selection, provider: 'openai' } : selection) };
    expect(() => assertQualityProfileRequest(directImage)).toThrow('fail-closed OpenRouter');
    const wrongMesh = { ...request, providerModels: request.providerModels.map((selection) => selection.role === 'image-to-3d' ? { ...selection, modelId: 'tripo3d/v2.5/image-to-3d' } : selection) };
    expect(() => assertQualityProfileRequest(wrongMesh)).toThrow('Tripo H3.1 multiview');
  });

  it('certifies only complete 90-point evidence and preserves attempts in HTML', () => {
    const dimensionScores = Object.fromEntries((Object.keys(QUALITY_DIMENSION_WEIGHTS) as QualityDimension[]).map((dimension) => [dimension, { score: 92, evidenceIds: ['evidence-1'] }])) as Record<QualityDimension, { score: number; evidenceIds: string[] }>;
    const certification = createQualityCertification({ benchmarkId: 'benchmark-1', qualityProfile: 'studio', dimensionScores, hardGates: [{ id: 'legal', passed: true, message: 'Provider policies accepted', evidenceIds: ['evidence-1'] }], scenarios: PAPER_DERIVED_BENCHMARK_SCENARIOS.map((scenario) => ({ id: scenario.id, score: 91, evidenceIds: ['evidence-1'] })), raterCount: 3, raterAgreement: 0.8, evidenceIds: ['evidence-1'], attempts: [{ id: 'attempt-1', phase: 'mesh', status: 'failed', costUsd: 1, durationMs: 20, message: 'Preserved failed candidate', evidenceIds: ['evidence-1'] }], actualCostUsd: 80, durationMs: 1_000 });
    expect(certification).toMatchObject({ weightedScore: 92, certified: true });
    expect(renderQualityReportHtml(certification)).toContain('Preserved failed candidate');
    const failed = createQualityCertification({ ...certification, dimensionScores: { ...dimensionScores, 'asset-reconstruction': { score: 79, evidenceIds: ['evidence-1'] } }, scenarios: certification.scenarios, hardGates: certification.hardGates, actualCostUsd: certification.actualCostUsd, durationMs: certification.durationMs });
    expect(failed.certified).toBe(false);
  });
});
