import { type CompileRequest, type ProviderRole, type QualityProfile } from '@worldengine/schema';
import type { ProviderModelSelection } from './provider.js';

export interface QualityProfileLimits {
  maxCostUsd: number;
  maxAssetGenerations: number;
  maxReferenceImages: number;
  maxHeroRegions: number;
  requiresSegmentation: boolean;
  requiresBlender: boolean;
  requiresCoDeformation: boolean;
}

export const QUALITY_PROFILE_LIMITS: Readonly<Record<QualityProfile, QualityProfileLimits>> = {
  local: { maxCostUsd: 0, maxAssetGenerations: 0, maxReferenceImages: 0, maxHeroRegions: 0, requiresSegmentation: false, requiresBlender: false, requiresCoDeformation: false },
  cheap: { maxCostUsd: 15, maxAssetGenerations: 5, maxReferenceImages: 1, maxHeroRegions: 1, requiresSegmentation: false, requiresBlender: false, requiresCoDeformation: false },
  studio: { maxCostUsd: 100, maxAssetGenerations: 20, maxReferenceImages: 5, maxHeroRegions: 5, requiresSegmentation: true, requiresBlender: true, requiresCoDeformation: true },
};

export function effectiveQualityProfile(request: CompileRequest): QualityProfile {
  // Requests created before format 1.1 had no explicit profile. Their parsed
  // default is local, but a non-empty provider selection unambiguously denotes
  // the former bounded cloud path, which is equivalent to Cheap.
  return request.qualityProfile === 'local' && request.providerModels.length > 0 ? 'cheap' : request.qualityProfile;
}

const legacyProviderForRole: Readonly<Partial<Record<ProviderRole, string>>> = {
  planner: 'openrouter',
  reviewer: 'openrouter',
  'composition-image': 'openai',
  'multiview-image': 'openai',
  'image-to-3d': 'wavespeed',
};

export function providerForRole(request: CompileRequest, role: ProviderRole): ProviderModelSelection | undefined {
  const explicit = request.providerModels.filter((selection) => selection.role === role);
  if (explicit.length > 1) throw new Error(`Only one provider model may be selected for role ${role}`);
  if (explicit[0]) return explicit[0];
  const provider = legacyProviderForRole[role];
  if (!provider) return undefined;
  const legacy = request.providerModels.filter((selection) => selection.role === undefined && selection.provider.toLowerCase() === provider);
  if (legacy.length > 1) throw new Error(`Only one legacy ${provider} model may be selected for role ${role}`);
  return legacy[0];
}

export function assertQualityProfileRequest(request: CompileRequest): void {
  const profile = effectiveQualityProfile(request);
  const limits = QUALITY_PROFILE_LIMITS[profile];
  if (request.maxCostUsd > limits.maxCostUsd) throw new Error(`${profile} profile cost cap is USD ${limits.maxCostUsd}`);
  if (request.maxAssetGenerations > limits.maxAssetGenerations) throw new Error(`${profile} profile allows at most ${limits.maxAssetGenerations} generated assets`);
  if (request.maxReferenceImages > limits.maxReferenceImages) throw new Error(`${profile} profile allows at most ${limits.maxReferenceImages} regional images`);
  if (request.heroRegionIds.length > limits.maxHeroRegions) throw new Error(`${profile} profile allows at most ${limits.maxHeroRegions} hero regions`);
  if (profile === 'cheap') {
    if (request.refinementPolicy.terrainCoDeformation) throw new Error('Cheap profile does not run terrain co-deformation');
    const requiredRoles: ProviderRole[] = ['planner', 'reviewer'];
    if (request.maxAssetGenerations > 0 || request.maxReferenceImages > 0) requiredRoles.push('composition-image', 'image-to-3d');
    const missing = requiredRoles.filter((role) => providerForRole(request, role) === undefined);
    if (missing.length > 0) throw new Error(`Cheap profile is missing provider roles: ${missing.join(', ')}`);
  }
  if (profile === 'studio') {
    const requiredRoles: ProviderRole[] = ['planner', 'reviewer', 'composition-image', 'object-detection', 'segmentation', 'multiview-image', 'image-to-3d'];
    const missing = requiredRoles.filter((role) => providerForRole(request, role) === undefined);
    if (missing.length > 0) throw new Error(`Studio profile is missing provider/worker roles: ${missing.join(', ')}`);
    if (!request.refinementPolicy.terrainCoDeformation || request.refinementPolicy.maxAssetRepairRounds < 1 || request.refinementPolicy.maxSceneRepairRounds < 1) {
      throw new Error('Studio profile requires bounded asset repair and terrain co-deformation');
    }
  }
}
