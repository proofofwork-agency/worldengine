import { describe, expect, it } from 'vitest';
import { CompileRequestSchema, type ProviderTermsProfile } from '@worldengine/schema';
import { ProviderPolicyRegistry, ProviderPolicyError, assertCostBudget } from './legal.js';
import { createReferenceBundle, generateReferenceChunk } from '@worldengine/terrain';
import { validateBundleIntegrity, validateRuntimeChunk } from './validation.js';

const accepted: ProviderTermsProfile = {
  provider: 'test', modelId: 'image-model', revision: 'r1', termsUrl: 'https://example.com/terms', termsFingerprint: 'a'.repeat(64),
  reviewedAt: '2026-01-01T00:00:00.000Z', acceptedAt: '2026-01-02T00:00:00.000Z', permittedTerritories: ['EU'], commercialUse: true,
  notices: [], outputConditions: 'owned by operator', retention: 'none', trainingUse: 'none', contentRestrictions: [], cost: { unit: 'image', usd: 0.25 }, enabled: true,
};

function request(model = accepted.modelId, fingerprint = accepted.termsFingerprint) {
  return CompileRequestSchema.parse({ prompt: 'world', seed: 1, maxCostUsd: 2, maxAssetGenerations: 4, territory: 'NL', commercialUse: true, dryRun: false,
    providerModels: [{ provider: 'test', modelId: model, revision: 'r1', termsFingerprint: fingerprint }] });
}

describe('provider policy gate', () => {
  it('allows a reviewed profile within cost and territory constraints', () => {
    const registry = new ProviderPolicyRegistry([accepted]);
    expect(() => registry.assertCompileAllowed(request())).not.toThrow();
    expect(registry.estimateMaximumCost(request())).toBe(1);
  });

  it.each([
    ['unknown model', () => new ProviderPolicyRegistry().assertCompileAllowed(request()), 'UNKNOWN_MODEL'],
    ['changed terms', () => new ProviderPolicyRegistry([accepted]).assertCompileAllowed(request(accepted.modelId, 'changed')), 'TERMS_CHANGED'],
    ['Hunyuan3D in EU', () => new ProviderPolicyRegistry().assertCompileAllowed(request('Hunyuan3D-2.1')), 'TERRITORY_FORBIDDEN'],
  ])('rejects %s', (_label, operation, code) => {
    expect(operation).toThrow(ProviderPolicyError);
    try { operation(); } catch (error) { expect((error as ProviderPolicyError).code).toBe(code); }
  });

  it('rejects estimates above the explicit cap', () => {
    expect(() => assertCostBudget(request(), 2.01)).toThrow('exceeds cap');
  });

  it('reserves only the three generated side views because the isolated image is reused as front', () => {
    const profile = (provider: string, modelId: string, usd: number): ProviderTermsProfile => ({ ...accepted, provider, modelId, cost: { unit: 'request', usd } });
    const terra = profile('openrouter', 'terra', 0.25);
    const image = profile('openrouter-image', 'image', 0.211);
    const sam = profile('sam2-local', 'sam2', 0);
    const wavespeed = profile('wavespeed', 'multiview', 0.5);
    const selection = (source: ProviderTermsProfile, role: 'planner' | 'reviewer' | 'composition-image' | 'object-detection' | 'segmentation' | 'multiview-image' | 'image-to-3d') => ({
      provider: source.provider, modelId: source.modelId, revision: source.revision, termsFingerprint: source.termsFingerprint, role,
    });
    const studio = CompileRequestSchema.parse({
      prompt: 'hero', seed: 2, qualityProfile: 'studio', heroRegionIds: ['region-1'], maxCostUsd: 25, maxAssetGenerations: 8, maxReferenceImages: 1,
      territory: 'NL', commercialUse: true, dryRun: false,
      refinementPolicy: { maxTerrainRounds: 3, maxCompositionAttempts: 3, maxAssetAttempts: 2, maxSceneRounds: 3, maxAssetRepairRounds: 2, maxSceneRepairRounds: 1, terrainCoDeformation: true },
      providerModels: [selection(terra, 'planner'), selection(terra, 'reviewer'), selection(image, 'composition-image'), selection(terra, 'object-detection'), selection(sam, 'segmentation'), selection(image, 'multiview-image'), selection(wavespeed, 'image-to-3d')],
    });
    expect(new ProviderPolicyRegistry([terra, image, sam, wavespeed]).estimateMaximumCost(studio)).toBeCloseTo(23.449, 6);
  });

  it('rejects an enabled profile whose terms fingerprint is still a placeholder', () => {
    const placeholder = { ...accepted, termsFingerprint: 'UNREVIEWED_REPLACE_WITH_SHA256' };
    const registry = new ProviderPolicyRegistry([placeholder]);
    const input = request(placeholder.modelId, placeholder.termsFingerprint);
    expect(() => registry.assertCompileAllowed(input)).toThrow('TERMS_FINGERPRINT_INVALID');
  });
});

describe('bundle validation', () => {
  it('accepts the reviewed reference manifest and detailed chunks', () => {
    const bundle = createReferenceBundle();
    expect(validateBundleIntegrity(bundle).issues).toEqual([]);
    expect(validateRuntimeChunk(bundle, generateReferenceChunk(bundle, { x: 0, z: 0 }, { samples: 17 })).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('rejects unreviewed assets', () => {
    const bundle = createReferenceBundle();
    const changed = { ...bundle, provenance: bundle.provenance.map((record, index) => index === 0 ? { ...record, reviewedAt: undefined } : record) };
    expect(validateBundleIntegrity(changed).issues.some((issue) => issue.code === 'SCHEMA_INVALID' || issue.code === 'UNREVIEWED_ASSET')).toBe(true);
  });

  it('rejects unsafe runtime asset and chunk references', () => {
    const bundle = createReferenceBundle();
    const changed = {
      ...bundle,
      prototypes: bundle.prototypes.map((prototype, index) => index === 0 ? { ...prototype, assetUri: 'javascript:alert(1)' } : prototype),
      chunks: bundle.chunks.map((chunk, index) => index === 0 ? { ...chunk, source: { kind: 'uri' as const, uri: '../../private.json', contentHash: '0'.repeat(64), byteLength: 1 } } : chunk),
    };
    const codes = validateBundleIntegrity(changed).issues.map((issue) => issue.code);
    expect(codes).toContain('UNSAFE_ASSET_URI');
    expect(codes).toContain('UNSAFE_CHUNK_URI');
  });

  it('checks local terrain contact, declared dependencies, and encoded terrain without throwing', () => {
    const bundle = createReferenceBundle();
    const chunk = generateReferenceChunk(bundle, { x: 0, z: 0 }, { samples: 17 });
    const below = structuredClone(chunk);
    below.instances[0]!.matrix[13] -= 20;
    below.dependencies = below.dependencies.filter((id) => id !== below.instances[0]!.prototypeId);
    const codes = validateRuntimeChunk(bundle, below).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(['BELOW_TERRAIN_OBJECT', 'MISSING_INSTANCE_DEPENDENCY']));
    expect(validateRuntimeChunk(bundle, { ...chunk, terrain: { ...chunk.terrain, heights: '***' } }).map((issue) => issue.code)).toContain('HEIGHT_ENCODING_INVALID');
  });
});
