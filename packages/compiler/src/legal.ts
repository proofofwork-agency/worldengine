import { ProviderTermsProfileSchema, type CompileRequest, type ProviderTermsProfile } from '@worldengine/schema';

export class ProviderPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ProviderPolicyError';
  }
}

const euTerritories = new Set([
  'AT','BE','BG','HR','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK','EU',
]);

function territoryAllowed(profile: ProviderTermsProfile, territory: string): boolean {
  const permitted = new Set(profile.permittedTerritories.map((value) => value.toUpperCase()));
  return permitted.has('*') || permitted.has(territory.toUpperCase()) || (euTerritories.has(territory.toUpperCase()) && permitted.has('EU'));
}

export function providerProfileOperationalIssues(profile: ProviderTermsProfile): string[] {
  const issues: string[] = [];
  if (!profile.enabled) issues.push('PROFILE_DISABLED');
  if (profile.acceptedAt === null) issues.push('TERMS_NOT_ACCEPTED');
  if (!/^[a-f\d]{64}$/i.test(profile.termsFingerprint)) issues.push('TERMS_FINGERPRINT_INVALID');
  if (/operator-selects|replace|unreviewed|placeholder/i.test(profile.revision)) issues.push('REVISION_UNPINNED');
  if ([profile.outputConditions, profile.retention, profile.trainingUse].some((value) => /replace|unreviewed|placeholder/i.test(value))) issues.push('POLICY_METADATA_UNREVIEWED');
  if (profile.permittedTerritories.every((territory) => territory.toUpperCase() === 'NONE')) issues.push('NO_PERMITTED_TERRITORY');
  return issues;
}

export class ProviderPolicyRegistry {
  private readonly profiles = new Map<string, ProviderTermsProfile>();

  constructor(profiles: readonly ProviderTermsProfile[] = []) {
    profiles.forEach((profile) => this.register(profile));
  }

  register(profile: ProviderTermsProfile): void {
    const validated = ProviderTermsProfileSchema.parse(profile);
    this.profiles.set(this.key(validated.provider, validated.modelId, validated.revision), validated);
  }

  assertCompileAllowed(request: CompileRequest): void {
    for (const requested of request.providerModels) {
      const lowerModel = requested.modelId.toLowerCase();
      if (lowerModel.includes('hunyuan3d') && euTerritories.has(request.territory.toUpperCase())) {
        throw new ProviderPolicyError('TERRITORY_FORBIDDEN', `${requested.modelId} is not permitted for this EU territory`);
      }
      const profile = this.profiles.get(this.key(requested.provider, requested.modelId, requested.revision));
      if (!profile) throw new ProviderPolicyError('UNKNOWN_MODEL', `No reviewed policy exists for ${requested.provider}/${requested.modelId}@${requested.revision}`);
      if (profile.termsFingerprint !== requested.termsFingerprint) throw new ProviderPolicyError('TERMS_CHANGED', `Terms fingerprint changed for ${requested.modelId}`);
      if (!profile.enabled || profile.acceptedAt === null) throw new ProviderPolicyError('NOT_ACCEPTED', `${requested.modelId} has not been enabled and accepted`);
      const operationalIssue = providerProfileOperationalIssues(profile)[0];
      if (operationalIssue) throw new ProviderPolicyError(operationalIssue, `${requested.modelId} provider policy is not operational: ${operationalIssue}`);
      if (!territoryAllowed(profile, request.territory)) throw new ProviderPolicyError('TERRITORY_FORBIDDEN', `${requested.modelId} is not permitted in ${request.territory}`);
      if (request.commercialUse && !profile.commercialUse) throw new ProviderPolicyError('COMMERCIAL_USE_FORBIDDEN', `${requested.modelId} is not approved for commercial use`);
      if (lowerModel.includes('sam3') && !profile.enabled) throw new ProviderPolicyError('RESTRICTED_MODEL', 'SAM3-family models require explicit operator approval');
    }
  }

  estimateMaximumCost(request: CompileRequest): number {
    return request.providerModels.reduce((sum, requested) => {
      const profile = this.profiles.get(this.key(requested.provider, requested.modelId, requested.revision));
      const provider = requested.provider.toLowerCase();
      const maximumInvocations = requested.role === 'planner' ? 1
        : requested.role === 'reviewer' ? 1 + request.maxReferenceImages * request.refinementPolicy.maxTerrainRounds + request.maxReferenceImages * request.refinementPolicy.maxCompositionAttempts + request.refinementPolicy.maxSceneRounds
          : requested.role === 'composition-image' ? request.maxReferenceImages * request.refinementPolicy.maxCompositionAttempts + request.maxAssetGenerations
            : requested.role === 'object-detection' ? request.maxReferenceImages
              : requested.role === 'segmentation' ? request.maxAssetGenerations
              // The isolated object image is reused as the front view and is
              // already reserved under composition-image. Only left/back/right
              // are newly generated for each reconstruction attempt.
              : requested.role === 'multiview-image' ? request.maxAssetGenerations * 3 * request.refinementPolicy.maxAssetAttempts
                  : requested.role === 'image-to-3d' ? request.maxAssetGenerations * request.refinementPolicy.maxAssetAttempts
                    : requested.role === 'retexture' ? request.maxAssetGenerations * request.refinementPolicy.maxAssetRepairRounds
                      : provider === 'openrouter' ? 1 + (request.maxAssetGenerations > 0 || request.maxReferenceImages > 0 ? 1 : 0)
                        : provider === 'openrouter-image' ? request.maxAssetGenerations + request.maxReferenceImages
                        : provider === 'openai' ? request.maxAssetGenerations + request.maxReferenceImages
                          : provider === 'wavespeed' ? request.maxAssetGenerations
                            : request.maxAssetGenerations;
      return sum + (profile?.cost.usd ?? 0) * maximumInvocations;
    }, 0);
  }

  profileFor(requested: { provider: string; modelId: string; revision: string }): ProviderTermsProfile {
    const profile = this.profiles.get(this.key(requested.provider, requested.modelId, requested.revision));
    if (!profile) throw new ProviderPolicyError('UNKNOWN_MODEL', `No reviewed policy exists for ${requested.provider}/${requested.modelId}@${requested.revision}`);
    return profile;
  }

  private key(provider: string, modelId: string, revision: string): string {
    return `${provider.toLowerCase()}::${modelId.toLowerCase()}::${revision}`;
  }
}

export function assertCostBudget(request: CompileRequest, estimatedCostUsd: number): void {
  if (estimatedCostUsd > request.maxCostUsd) throw new ProviderPolicyError('COST_CAP_EXCEEDED', `Estimated cost $${estimatedCostUsd.toFixed(2)} exceeds cap $${request.maxCostUsd.toFixed(2)}`);
  if (request.maxAssetGenerations < 0) throw new ProviderPolicyError('GENERATION_CAP_INVALID', 'maxAssetGenerations must be non-negative');
}

export const referenceProviderProfiles: ProviderTermsProfile[] = [
  {
    provider: 'openrouter', modelId: 'openai/gpt-5.6-terra', revision: 'operator-selects',
    termsUrl: 'https://openrouter.ai/terms', termsFingerprint: 'UNREVIEWED', reviewedAt: '2026-01-01T00:00:00.000Z', acceptedAt: null,
    permittedTerritories: ['NONE'], commercialUse: false, notices: [], outputConditions: 'Requires operator review of underlying model terms',
    retention: 'Configure zero-data-retention routing before enabling', trainingUse: 'Unreviewed', contentRestrictions: [], cost: { unit: 'request', usd: 0 }, enabled: false,
  },
  {
    provider: 'openrouter-image', modelId: 'openai/gpt-image-2', revision: 'operator-selects',
    termsUrl: 'https://openrouter.ai/terms', termsFingerprint: 'UNREVIEWED', reviewedAt: '2026-01-01T00:00:00.000Z', acceptedAt: null,
    permittedTerritories: ['NONE'], commercialUse: false, notices: [], outputConditions: 'Requires review of OpenRouter and the exact underlying OpenAI image-model terms',
    retention: 'Review OpenRouter and upstream retention before enabling', trainingUse: 'Unreviewed', contentRestrictions: [], cost: { unit: 'image', usd: 0 }, enabled: false,
  },
  {
    provider: 'wavespeed', modelId: 'tripo3d/h3.1/image-to-3d', revision: 'operator-selects',
    termsUrl: 'https://wavespeed.ai/models/tripo3d/h3.1/image-to-3d', termsFingerprint: 'UNREVIEWED', reviewedAt: '2026-01-01T00:00:00.000Z', acceptedAt: null,
    permittedTerritories: ['NONE'], commercialUse: false, notices: [], outputConditions: 'Commercial rights depend on the upstream Tripo license',
    retention: 'Download outputs immediately after generation', trainingUse: 'Unreviewed', contentRestrictions: [], cost: { unit: 'asset', usd: 0 }, enabled: false,
  },
  {
    provider: 'wavespeed', modelId: 'tripo3d/h3.1/multiview-to-3d', revision: 'operator-selects',
    termsUrl: 'https://wavespeed.ai/models/tripo3d/h3.1/multiview-to-3d', termsFingerprint: 'UNREVIEWED', reviewedAt: '2026-01-01T00:00:00.000Z', acceptedAt: null,
    permittedTerritories: ['NONE'], commercialUse: false, notices: [], outputConditions: 'Requires review of exact WaveSpeed-hosted Tripo H3.1 multiview revision and output rights',
    retention: 'Download outputs immediately after generation', trainingUse: 'Unreviewed', contentRestrictions: [], cost: { unit: 'asset', usd: 0 }, enabled: false,
  },
  {
    provider: 'sam2-local', modelId: 'sam2.1-hiera-large', revision: 'operator-selects',
    termsUrl: 'https://github.com/facebookresearch/sam2/blob/main/LICENSE', termsFingerprint: 'UNREVIEWED', reviewedAt: '2026-01-01T00:00:00.000Z', acceptedAt: null,
    permittedTerritories: ['NONE'], commercialUse: false, notices: [], outputConditions: 'Install exact reviewed checkpoint separately and record its SHA-256',
    retention: 'Local processing only', trainingUse: 'No training by WorldEngine', contentRestrictions: [], cost: { unit: 'asset', usd: 0 }, enabled: false,
  },
];
