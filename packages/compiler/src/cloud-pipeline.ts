import { createHash } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import {
  AssetLibraryEntrySchema,
  AuthoringWorldSchema,
  PrototypeIdSchema,
  VisualWorldBundleSchema,
  WorldDesignSpecSchema,
  WorldPatchSchema,
  RefinementActionSchema,
  jsonSchemas,
  type AssetLibraryEntry,
  type CompileRequest,
  type GenerationArtifactKind,
  type ProvenanceRecord,
  type ReferenceImage,
  type ProviderRole,
  type Mat4,
  type Transform,
  type WorldDesignSpec,
} from '@worldengine/schema';
import { compileTerrainPlanChunk, sampleWorldHeight } from '@worldengine/terrain';
import type { BinaryArtifactReference, BinaryArtifactStore } from './binary-artifact.js';
import { assertSafeRemoteHttpsUrl, type GeneratedImageOutput, type JsonPlanningInput, type MultiImageTo3DInput, type PredictionOutput, type TripoImageTo3DInput } from './http-adapters.js';
import { assertValidGlb } from './asset-validation.js';
import { renderGlbDiagnostic } from './asset-diagnostic.js';
import { generateMeshLods } from './asset-optimizer.js';
import { applyCanonicalPatch } from './patching.js';
import { boundsRadiusForAssetClass, compileLocalWorldArtifacts, type CompiledWorldArtifacts } from './authoring-compiler.js';
import type { ProviderPolicyRegistry } from './legal.js';
import { ProviderExecutionRegistry, type ProviderModelSelection } from './provider.js';
import { ObjectDescriptorSchema, referenceCamerasForRegion, validateVisualReviewPatch } from './composition.js';
import { renderPlacementDiagnosticAtlas, renderTerrainReference } from './terrain-reference.js';
import { transcodeGlbTexturesToKtx2, transcodeTextureToKtx2 } from './texture-optimizer.js';
import { effectiveQualityProfile, providerForRole } from './quality-profile.js';
import { SegmentationInputSchema, type BlenderRefinementResult, type BlenderWorkerClient, type StudioWorkerRegistry } from './studio-workers.js';
import type { CompositionPlacementOverride } from './authoring-compiler.js';
import { buildExecutableTerrainPlan } from './local-planner.js';
import { createLosslessAlphaCrop } from './composition-artifacts.js';

export interface StagedBinaryArtifact extends BinaryArtifactReference { uri: string; artifactKind?: GenerationArtifactKind; phase?: string }

export interface CloudPreparation {
  request: CompileRequest;
  designSpec: WorldDesignSpec;
  references: ReferenceImage[];
  referenceProvenance: ProvenanceRecord[];
  stagedArtifacts: StagedBinaryArtifact[];
  generatedPrototypeIds: string[];
  optimizationWarnings: string[];
  compositionOverrides: CompositionPlacementOverride[];
  failure?: string;
}

function matrixFromTransform(transform: Transform): Mat4 {
  const [x, y, z, w] = transform.rotation; const [sx, sy, sz] = transform.scale;
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2; const yy = y * y2; const yz = y * z2; const zz = z * z2; const wx = w * x2; const wy = w * y2; const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    transform.position[0], transform.position[1], transform.position[2], 1,
  ];
}

export async function refineStudioRegions(
  artifactInput: CompiledWorldArtifacts,
  preparation: CloudPreparation,
  request: CompileRequest,
  store: BinaryArtifactStore,
  workers: StudioWorkerRegistry,
  signal: AbortSignal,
): Promise<CompiledWorldArtifacts> {
  if (effectiveQualityProfile(request) !== 'studio') return artifactInput;
  if (!workers.blender) throw new Error('Studio region refinement requires Blender 5.1');
  if (artifactInput.authoringWorld.terrain.kind !== 'compiled-heightfield' || artifactInput.bundle.terrain?.kind !== 'compiled-heightfield') throw new Error('Studio region refinement requires compiled-heightfield terrain');
  let entities = artifactInput.authoringWorld.entities;
  let authoredInstances = artifactInput.bundle.authoredInstances;
  const footprintEdits = [...artifactInput.authoringWorld.terrain.footprintEdits];
  const diagnostics = [...artifactInput.authoringWorld.diagnostics];
  const prototypes = new Map(artifactInput.authoringWorld.prototypes.map((prototype) => [prototype.id, prototype]));
  for (const regionId of request.heroRegionIds) {
    signal.throwIfAborted();
    const region = artifactInput.designSpec.regions.find((candidate) => candidate.id === regionId);
    if (!region) throw new Error(`Unknown Studio hero region ${regionId}`);
    const regionEntities = entities.filter((entity) => entity.regionId === regionId && entity.visualState['compositionPlaced'] === true && preparation.generatedPrototypeIds.includes(entity.prototypeId));
    if (regionEntities.length === 0) continue;
    const minX = Math.min(...region.polygon.map((point) => point[0])); const maxX = Math.max(...region.polygon.map((point) => point[0]));
    const minZ = Math.min(...region.polygon.map((point) => point[1])); const maxZ = Math.max(...region.polygon.map((point) => point[1]));
    const sizeMeters = Math.max(maxX - minX, maxZ - minZ); const samples = 129; const spacing = sizeMeters / (samples - 1);
    const heights = new Float32Array(samples ** 2);
    for (let zIndex = 0; zIndex < samples; zIndex += 1) for (let xIndex = 0; xIndex < samples; xIndex += 1) heights[zIndex * samples + xIndex] = sampleWorldHeight(artifactInput.bundle, minX + xIndex * spacing, minZ + zIndex * spacing);
    const assets = await Promise.all(regionEntities.map(async (entity) => {
      const prototype = prototypes.get(entity.prototypeId); if (!prototype) throw new Error(`Region refinement lost prototype ${entity.prototypeId}`);
      const composition = artifactInput.authoringWorld.regionalCompositions.find((candidate) => candidate.regionId === regionId && candidate.objects.some((object) => object.entityId === entity.id));
      const descriptor = composition?.objects.find((object) => object.entityId === entity.id);
      const mask = preparation.references.find((reference) => reference.kind === 'object-mask' && reference.prototypeId === entity.prototypeId);
      if (!composition || !descriptor || !mask) throw new Error(`Studio placement evidence is incomplete for ${entity.id}`);
      return {
        id: entity.id, glb: new Uint8Array(await store.get(prototype.assetHash)), transform: entity.transform, organic: /tree|plant|rock|boulder|shrub|reed/i.test(prototype.tags.join(' ')),
        placementTarget: { cameraId: composition.camera.id, screenBox: descriptor.screenBox, sourceWidth: composition.camera.width, sourceHeight: composition.camera.height, mask: new Uint8Array(await store.get(mask.contentHash)) },
      };
    }));
    const cameras = artifactInput.designSpec.terrainPlan.referenceCameras.filter((camera) => camera.regionId === regionId).slice(0, 3);
    if (cameras.length !== 3) throw new Error(`Studio region ${regionId} requires exactly three calibrated cameras`);
    const result = await workers.blender.refineRegion({ regionId, terrain: { samples, origin: [minX, minZ], sizeMeters, heights }, materials: await blenderTerrainMaterials(artifactInput.designSpec, regionId), assets, cameras, environment: { timeOfDay: artifactInput.designSpec.environment.timeOfDay, fogDensity: artifactInput.designSpec.environment.fogDensity }, renderResolution: 768 }, signal);
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) throw new Error(`Blender region refinement rejected ${regionId}: ${errors.map((error) => error.message).join('; ')}`);
    const byId = new Map(result.transforms.map((entry) => [entry.id, entry]));
    if (result.transforms.some((entry) => entry.contactErrorMeters > (assets.find((asset) => asset.id === entry.id)?.organic ? 0.05 : 0.02))) throw new Error(`Blender region refinement failed contact thresholds in ${regionId}`);
    if (result.transforms.some((entry) => entry.silhouetteIou < 0.85 || entry.centerErrorPixels > 4)) throw new Error(`Blender region refinement failed silhouette thresholds in ${regionId}`);
    entities = entities.map((entity) => byId.has(entity.id) ? { ...entity, transform: byId.get(entity.id)!.transform, visualState: { ...entity.visualState, coDeformed: true, silhouetteIou: byId.get(entity.id)!.silhouetteIou, silhouetteCenterErrorPixels: byId.get(entity.id)!.centerErrorPixels } } : entity);
    authoredInstances = authoredInstances.map((instance) => byId.has(instance.id) ? { ...instance, matrix: matrixFromTransform(byId.get(instance.id)!.transform), visualState: { ...instance.visualState, coDeformed: true, silhouetteIou: byId.get(instance.id)!.silhouetteIou, silhouetteCenterErrorPixels: byId.get(instance.id)!.centerErrorPixels } } : instance);
    footprintEdits.push(...result.terrainEdits.map((edit) => ({ ...edit, mode: 'flatten' as const })));
    diagnostics.push({ severity: 'info', code: 'BLENDER_REGION_REFINEMENT', message: `Validated ${result.transforms.length} silhouette/contact fits and ${result.terrainEdits.length} bounded mesh-footprint terrain edits`, subjectId: regionId });
    const parentIds = regionEntities.map((entity) => prototypes.get(entity.prototypeId)!.provenanceId);
    for (const render of result.renders) {
      const stored = await store.put(render.bytes, 'image/png'); const referenceId = `${render.kind}-${slug(regionId)}-${slug(render.cameraId)}-${stored.contentHash.slice(0, 10)}`; const provenanceId = `provenance-${referenceId}`; const uri = `references/${stored.contentHash}.png`;
      preparation.references.push({ id: referenceId, kind: render.kind, uri, contentHash: stored.contentHash, contentType: 'image/png', regionId: region.id, provenanceId });
      preparation.referenceProvenance.push({ id: provenanceId, subjectId: referenceId, kind: 'edited', sourceUri: uri, provider: 'worldengine-blender-worker', modelId: 'refine-region', modelRevision: result.workerVersion, license: { name: 'Region render inherits generated asset terms', commercialUse: parentIds.every((id) => artifactInput.authoringWorld.provenance.find((record) => record.id === id)?.license.commercialUse === true) }, createdAt: new Date().toISOString(), contentHash: stored.contentHash, parentIds });
      preparation.stagedArtifacts.push({ ...stored, uri, artifactKind: render.kind, phase: 'scene-refinement' });
    }
  }
  return {
    designSpec: artifactInput.designSpec,
    authoringWorld: AuthoringWorldSchema.parse({ ...artifactInput.authoringWorld, terrain: { ...artifactInput.authoringWorld.terrain, footprintEdits }, entities, diagnostics }),
    bundle: VisualWorldBundleSchema.parse({ ...artifactInput.bundle, terrain: { ...artifactInput.bundle.terrain, footprintEdits }, authoredInstances }),
  };
}

const ReviewIssueSchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().min(1),
  subjectId: z.string().nullable().default(null),
});

const CloudReviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(ReviewIssueSchema).default([]),
  patch: WorldPatchSchema.nullable().default(null),
  actions: z.array(RefinementActionSchema).default([]),
});

const TerminalCloudReviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(ReviewIssueSchema).default([]),
  patch: z.null(),
  actions: z.array(RefinementActionSchema).max(0).default([]),
});

const CompositionDetectionSchema = z.object({
  regionId: z.string().min(1),
  objects: z.array(ObjectDescriptorSchema).min(1).max(40),
});

const CompositionPreservationReviewSchema = z.object({
  structuralSimilarityOutsideObjects: z.number().min(0).max(1),
  terrainMaskOverlap: z.number().min(0).max(1),
  cameraLandmarkDriftPixels: z.number().nonnegative(),
  diagnosis: z.string().min(1),
});

const TerrainReviewAdjustmentSchema = z.object({
  type: z.enum(['landform-strength', 'boundary-blend', 'material-tiling', 'scatter-density', 'light-time', 'fog-density']),
  targetId: z.string().min(1),
  value: z.number().finite(),
});

const TerrainFoundationReviewSchema = z.object({
  approved: z.boolean(),
  diagnosis: z.string().min(1),
  adjustments: z.array(TerrainReviewAdjustmentSchema).max(16).default([]),
});

export function applyTerrainReviewAdjustments(spec: WorldDesignSpec, adjustmentsInput: readonly z.infer<typeof TerrainReviewAdjustmentSchema>[]): WorldDesignSpec {
  const adjustments = adjustmentsInput.map((adjustment) => TerrainReviewAdjustmentSchema.parse(adjustment));
  let terrainPlan = structuredClone(spec.terrainPlan); let environment = { ...spec.environment };
  for (const adjustment of adjustments) {
    if (adjustment.type === 'boundary-blend') terrainPlan.maskBlendMeters = Math.max(1, Math.min(2_000, adjustment.value));
    if (adjustment.type === 'material-tiling') terrainPlan.materialSets = terrainPlan.materialSets.map((material) => material.id === adjustment.targetId ? { ...material, metersPerTile: Math.max(0.1, Math.min(200, adjustment.value)) } : material);
    if (adjustment.type === 'scatter-density') terrainPlan.scatterRecipes = terrainPlan.scatterRecipes.map((recipe) => recipe.id === adjustment.targetId ? { ...recipe, densityPerSquareKm: Math.max(0, Math.min(50_000, adjustment.value)) } : recipe);
    if (adjustment.type === 'light-time') environment.timeOfDay = ((adjustment.value % 24) + 24) % 24;
    if (adjustment.type === 'fog-density') environment.fogDensity = Math.max(0, Math.min(0.1, adjustment.value));
    if (adjustment.type === 'landform-strength') {
      const separator = adjustment.targetId.lastIndexOf(':'); const regionId = adjustment.targetId.slice(0, separator); const operatorIndex = Number(adjustment.targetId.slice(separator + 1));
      if (separator < 1 || !Number.isInteger(operatorIndex)) throw new Error(`Invalid landform adjustment target ${adjustment.targetId}`);
      terrainPlan.regions = terrainPlan.regions.map((region) => region.regionId === regionId ? { ...region, operators: region.operators.map((operator, index) => index === operatorIndex ? { ...operator, strength: Math.max(-2, Math.min(2, adjustment.value)) } : operator) } : region);
    }
  }
  return WorldDesignSpecSchema.parse({ ...spec, terrainPlan, environment });
}

function selection(request: CompileRequest, role: ProviderRole): ProviderModelSelection | undefined {
  return providerForRole(request, role);
}

function idempotencyKey(request: CompileRequest, phase: string, input: unknown): string {
  return createHash('sha256').update(JSON.stringify({
    seed: request.seed,
    prompt: request.prompt,
    phase,
    providerModels: request.providerModels,
    input,
  })).digest('hex');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z\d]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'asset';
}

export function planAssetGenerationAssignments(
  spec: WorldDesignSpec,
  library: readonly Pick<AssetLibraryEntry, 'class'>[],
  maximum: number,
): Array<{ requirement: WorldDesignSpec['assetRequirements'][number]; index: number; prototypeIndex: number; regionId: string; screenBox: { x: number; y: number; width: number; height: number } }> {
  const assignments: Array<{ requirement: WorldDesignSpec['assetRequirements'][number]; index: number; prototypeIndex: number; regionId: string; screenBox: { x: number; y: number; width: number; height: number } }> = [];
  let prototypeIndex = 0;
  for (const requirement of spec.assetRequirements) for (let index = 0; index < requirement.count; index += 1) {
    const currentPrototypeIndex = prototypeIndex;
    prototypeIndex += 1;
    const available = library.filter((entry) => entry.class.toLowerCase() === requirement.class.toLowerCase()).length;
    if (available <= index) {
      const column = currentPrototypeIndex % 4;
      const row = Math.floor(currentPrototypeIndex / 4) % 3;
      assignments.push({ requirement, index, prototypeIndex: currentPrototypeIndex, regionId: spec.regions[currentPrototypeIndex % spec.regions.length]!.id, screenBox: { x: 520 + column * 128, y: 330 + row * 48, width: 96, height: 150 } });
    }
  }
  return assignments.slice(0, maximum);
}

export function planStudioHeroAssetGenerationAssignments(
  spec: WorldDesignSpec,
  library: readonly Pick<AssetLibraryEntry, 'class'>[],
  maximum: number,
  heroRegionIds: readonly string[],
): ReturnType<typeof planAssetGenerationAssignments> {
  if (heroRegionIds.length === 0) throw new Error('Studio asset generation requires at least one hero region');
  const assignments: ReturnType<typeof planAssetGenerationAssignments> = [];
  let prototypeIndex = 0;
  for (const requirement of spec.assetRequirements) for (let index = 0; index < requirement.count; index += 1) {
    const currentPrototypeIndex = prototypeIndex; prototypeIndex += 1;
    const available = library.filter((entry) => entry.class.toLowerCase() === requirement.class.toLowerCase()).length;
    if (available > index || assignments.length >= maximum) continue;
    const regionSlot = assignments.length % heroRegionIds.length; const withinRegion = Math.floor(assignments.length / heroRegionIds.length);
    const column = withinRegion % 4; const row = Math.floor(withinRegion / 4);
    assignments.push({ requirement, index, prototypeIndex: currentPrototypeIndex, regionId: heroRegionIds[regionSlot]!, screenBox: { x: 260 + column * 300, y: 250 + row * 330, width: 210, height: 260 } });
  }
  return assignments;
}

function decodeBase64(value: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) throw new Error('Generated image is empty or exceeds the 50 MB ingestion limit');
  return bytes;
}

function detectImageType(bytes: Uint8Array, declared?: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  throw new Error(`Generated image payload is not PNG, JPEG, or WebP${declared ? ` (${declared})` : ''}`);
}

function imageExtension(contentType: ReferenceImage['contentType']): string {
  return contentType === 'image/jpeg' ? 'jpg' : contentType.split('/')[1]!;
}

async function ingestImage(output: GeneratedImageOutput['images'][number], store: BinaryArtifactStore, fetcher: typeof fetch, signal: AbortSignal): Promise<{ reference: BinaryArtifactReference; providerUri: string; contentType: ReferenceImage['contentType'] }> {
  let bytes: Uint8Array;
  let declared: string | undefined;
  let providerUri: string | undefined;
  let base64Payload: string | undefined;
  if (output.base64) {
    bytes = decodeBase64(output.base64);
    base64Payload = output.base64;
  } else if (output.url) {
    const url = assertSafeRemoteHttpsUrl(output.url, 'Generated image output URL');
    const response = await fetcher(url, { signal });
    if (!response.ok) throw new Error(`Unable to ingest generated image: ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > 50 * 1024 * 1024) throw new Error('Generated image exceeds the 50 MB ingestion limit');
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('Generated image exceeds the 50 MB ingestion limit');
    declared = response.headers.get('content-type') ?? undefined;
    providerUri = url.href;
  } else {
    throw new Error('Image provider returned neither base64 bytes nor an output URL');
  }
  const contentType = detectImageType(bytes, declared);
  if (base64Payload) providerUri = `data:${contentType};base64,${base64Payload}`;
  if (!providerUri) throw new Error('Generated image output URI could not be resolved');
  return { reference: await store.put(bytes, contentType), providerUri, contentType };
}

function licenseFor(policies: ProviderPolicyRegistry, model: ProviderModelSelection): ProvenanceRecord['license'] {
  const profile = policies.profileFor(model);
  return {
    name: `${model.provider}/${model.modelId} reviewed output terms`,
    url: profile.termsUrl,
    commercialUse: profile.commercialUse,
    ...(profile.notices.length > 0 ? { attribution: profile.notices.join('; ') } : {}),
  };
}

async function generatedTerrainTexture(materialId: string, channel: 'base-color' | 'normal' | 'roughness' | 'macrovariation'): Promise<Uint8Array> {
  const size = 128; const seed = createHash('sha256').update(materialId).digest();
  const red = 52 + seed[0]! % 110; const green = 58 + seed[1]! % 100; const blue = 46 + seed[2]! % 90;
  const heightAt = (x: number, y: number) => Math.sin((x / size) * Math.PI * 2 * 4 + seed[3]!) * 0.55 + Math.cos((y / size) * Math.PI * 2 * 3 + seed[4]!) * 0.35 + Math.sin(((x + y) / size) * Math.PI * 2 * 7) * 0.1;
  if (channel === 'roughness' || channel === 'macrovariation') {
    const pixels = new Uint8Array(size * size);
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
      const height = heightAt(x, y); pixels[y * size + x] = channel === 'roughness' ? Math.round(190 + height * 28) : Math.round(128 + height * 62);
    }
    return Uint8Array.from(await sharp(pixels, { raw: { width: size, height: size, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer());
  }
  const pixels = new Uint8Array(size * size * (channel === 'normal' ? 3 : 4));
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * (channel === 'normal' ? 3 : 4);
    if (channel === 'normal') {
      const dx = heightAt((x + 1) % size, y) - heightAt((x + size - 1) % size, y); const dy = heightAt(x, (y + 1) % size) - heightAt(x, (y + size - 1) % size);
      const length = Math.hypot(dx, dy, 2); pixels[offset] = Math.round((-dx / length * 0.5 + 0.5) * 255); pixels[offset + 1] = Math.round((-dy / length * 0.5 + 0.5) * 255); pixels[offset + 2] = Math.round((2 / length * 0.5 + 0.5) * 255);
    } else {
      const variation = heightAt(x, y) * 18; pixels[offset] = Math.max(0, Math.min(255, Math.round(red + variation))); pixels[offset + 1] = Math.max(0, Math.min(255, Math.round(green + variation))); pixels[offset + 2] = Math.max(0, Math.min(255, Math.round(blue + variation))); pixels[offset + 3] = 255;
    }
  }
  return Uint8Array.from(await sharp(pixels, { raw: { width: size, height: size, channels: channel === 'normal' ? 3 : 4 } }).png({ compressionLevel: 9 }).toBuffer());
}

async function blenderTerrainMaterials(spec: WorldDesignSpec, regionId: string) {
  const regionPlan = spec.terrainPlan.regions.find((region) => region.regionId === regionId);
  const selectedIds = new Set(regionPlan?.materialSetIds ?? []);
  const selected = spec.terrainPlan.materialSets.filter((material) => selectedIds.size === 0 || selectedIds.has(material.id));
  if (selected.length === 0) throw new Error(`Studio region ${regionId} has no terrain material set`);
  return Promise.all(selected.slice(0, 16).map(async (material) => ({
    id: material.id,
    metersPerTile: material.metersPerTile,
    baseColor: await generatedTerrainTexture(material.id, 'base-color'),
    normal: await generatedTerrainTexture(material.id, 'normal'),
    roughness: await generatedTerrainTexture(material.id, 'roughness'),
    macroVariation: await generatedTerrainTexture(material.id, 'macrovariation'),
  })));
}

async function stageStudioTerrainFoundation(spec: WorldDesignSpec, store: BinaryArtifactStore, stagedArtifacts: StagedBinaryArtifact[]): Promise<WorldDesignSpec> {
  const materialSets = [] as WorldDesignSpec['terrainPlan']['materialSets'];
  for (const material of spec.terrainPlan.materialSets) {
    const uris: Record<'base-color' | 'normal' | 'roughness' | 'macrovariation', string> = { 'base-color': '', normal: '', roughness: '', macrovariation: '' };
    for (const channel of ['base-color', 'normal', 'roughness', 'macrovariation'] as const) {
      const source = await generatedTerrainTexture(material.id, channel);
      const bytes = await transcodeTextureToKtx2(source, { maxDimension: 2_048, normalMap: channel === 'normal', perceptual: channel === 'base-color' });
      const stored = await store.put(bytes, 'image/ktx2'); const uri = `terrain/${stored.contentHash}.ktx2`;
      uris[channel] = uri;
      const artifactKind: GenerationArtifactKind = channel === 'base-color' || channel === 'macrovariation' ? 'terrain-base-color' : channel === 'normal' ? 'terrain-normal' : 'terrain-roughness';
      stagedArtifacts.push({ ...stored, uri, artifactKind, phase: 'terrain' });
    }
    materialSets.push({ ...material, baseColorUri: uris['base-color'], normalUri: uris.normal, roughnessUri: uris.roughness, macroVariationUri: uris.macrovariation });
  }
  const terrainPlan = { ...spec.terrainPlan, materialSets };
  const plannedSpec = WorldDesignSpecSchema.parse({ ...spec, terrainPlan });
  const sizeMeters = Math.max(spec.bounds.max[0] - spec.bounds.min[0], spec.bounds.max[1] - spec.bounds.min[1]);
  const foundation = compileTerrainPlanChunk({ plan: terrainPlan, regions: spec.regions, seed: spec.seed, coordinate: { x: spec.bounds.min[0] / sizeMeters, z: spec.bounds.min[1] / sizeMeters }, chunkSize: sizeMeters, samples: spec.terrainSamples, fallbackHeight: () => 0 });
  const heightBytes = new Uint8Array(foundation.heights.buffer.slice(foundation.heights.byteOffset, foundation.heights.byteOffset + foundation.heights.byteLength));
  const storedHeightfield = await store.put(heightBytes, 'application/octet-stream');
  stagedArtifacts.push({ ...storedHeightfield, uri: `terrain/${storedHeightfield.contentHash}.f32`, artifactKind: 'terrain-heightfield', phase: 'terrain' });
  for (const splat of foundation.splats) {
    const stored = await store.put(splat.weights, 'application/octet-stream');
    stagedArtifacts.push({ ...stored, uri: `terrain/${stored.contentHash}.bin`, artifactKind: 'terrain-splat', phase: 'terrain' });
  }
  return plannedSpec;
}

const studioTerrainPassKinds = ['blender-rgb', 'blender-depth', 'blender-normal', 'blender-semantic', 'blender-instance'] as const;

async function stageStudioTerrainRenders(
  spec: WorldDesignSpec,
  bundle: CompiledWorldArtifacts['bundle'],
  region: WorldDesignSpec['regions'][number],
  worker: BlenderWorkerClient,
  store: BinaryArtifactStore,
  references: ReferenceImage[],
  provenance: ProvenanceRecord[],
  stagedArtifacts: StagedBinaryArtifact[],
  signal: AbortSignal,
  attempt: number,
): Promise<{ bytes: Uint8Array; source: string; provenanceId: string; evidence: string[] }> {
  const minX = Math.min(...region.polygon.map((point) => point[0])); const maxX = Math.max(...region.polygon.map((point) => point[0]));
  const minZ = Math.min(...region.polygon.map((point) => point[1])); const maxZ = Math.max(...region.polygon.map((point) => point[1]));
  const sizeMeters = Math.max(maxX - minX, maxZ - minZ); const samples = 129; const spacing = sizeMeters / (samples - 1);
  const heights = new Float32Array(samples ** 2);
  for (let zIndex = 0; zIndex < samples; zIndex += 1) for (let xIndex = 0; xIndex < samples; xIndex += 1) heights[zIndex * samples + xIndex] = sampleWorldHeight(bundle, minX + xIndex * spacing, minZ + zIndex * spacing);
  const cameras = spec.terrainPlan.referenceCameras.filter((camera) => camera.regionId === region.id).slice(0, 3);
  if (cameras.length !== 3) throw new Error(`Studio terrain render for ${region.id} requires exactly three calibrated cameras`);
  const rendered = await worker.refineRegion({ regionId: region.id, terrain: { samples, origin: [minX, minZ], sizeMeters, heights }, materials: await blenderTerrainMaterials(spec, region.id), assets: [], cameras, environment: { timeOfDay: spec.environment.timeOfDay, fogDensity: spec.environment.fogDensity }, renderResolution: 1024 }, signal);
  const errors = rendered.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) throw new Error(`Blender terrain render rejected ${region.id}: ${errors.map((error) => error.message).join('; ')}`);
  for (const camera of cameras) for (const kind of studioTerrainPassKinds) if (!rendered.renders.some((render) => render.cameraId === camera.id && render.kind === kind)) throw new Error(`Blender terrain render omitted ${kind} for ${camera.id}`);
  let primary: { bytes: Uint8Array; source: string; provenanceId: string; evidence: string[] } | undefined; const evidence: string[] = [];
  for (const camera of cameras) for (const kind of studioTerrainPassKinds) {
    const render = rendered.renders.find((candidate) => candidate.cameraId === camera.id && candidate.kind === kind)!;
    const stored = await store.put(render.bytes, 'image/png'); const uri = `references/${stored.contentHash}.png`;
    const canonical = camera.id === cameras[0]!.id && kind === 'blender-rgb';
    const referenceId = canonical ? `reference-terrain-${slug(region.id)}-attempt-${attempt}-${stored.contentHash.slice(0, 10)}` : `terrain-${slug(region.id)}-attempt-${attempt}-${slug(camera.id)}-${kind}-${stored.contentHash.slice(0, 10)}`;
    const provenanceId = `provenance-${referenceId}`;
    references.push({ id: referenceId, kind: canonical ? 'terrain-reference' : kind, uri, contentHash: stored.contentHash, contentType: 'image/png', regionId: region.id, provenanceId });
    provenance.push({ id: provenanceId, subjectId: referenceId, kind: 'procedural', sourceUri: uri, provider: 'worldengine-blender-worker', modelId: 'canonical-terrain-passes', modelRevision: rendered.workerVersion, license: { name: 'Apache-2.0 project-authored terrain render', commercialUse: true }, createdAt: new Date().toISOString(), contentHash: stored.contentHash, parentIds: [] });
    const artifactKind: GenerationArtifactKind = kind === 'blender-rgb' ? 'terrain-rgb' : kind === 'blender-depth' ? 'terrain-depth' : kind === 'blender-normal' ? 'terrain-normal' : kind === 'blender-semantic' ? 'terrain-semantic' : 'terrain-instance';
    stagedArtifacts.push({ ...stored, uri, artifactKind, phase: 'terrain' });
    const source = `data:image/png;base64,${Buffer.from(render.bytes).toString('base64')}`; evidence.push(source);
    if (canonical) primary = { bytes: render.bytes, source, provenanceId, evidence };
  }
  if (!primary) throw new Error(`Blender terrain render produced no canonical RGB pass for ${region.id}`);
  primary.evidence = evidence;
  return primary;
}

export async function prepareCloudCompile(
  request: CompileRequest,
  localSpec: WorldDesignSpec,
  providers: ProviderExecutionRegistry,
  policies: ProviderPolicyRegistry,
  store: BinaryArtifactStore,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  studioWorkers?: StudioWorkerRegistry,
): Promise<CloudPreparation> {
  const profile = effectiveQualityProfile(request);
  const planning = selection(request, 'planner');
  const reviewer = selection(request, 'reviewer');
  const image = selection(request, 'composition-image');
  const detector = selection(request, 'object-detection');
  const segmentation = selection(request, 'segmentation');
  const multiview = selection(request, 'multiview-image');
  const mesh = selection(request, 'image-to-3d');
  const selectedByRole = new Set([planning, reviewer, image, detector, segmentation, multiview, mesh].filter(Boolean).map((model) => `${model!.provider.toLowerCase()}::${model!.modelId.toLowerCase()}::${model!.revision}`));
  for (const model of request.providerModels) if (!selectedByRole.has(`${model.provider.toLowerCase()}::${model.modelId.toLowerCase()}::${model.revision}`)) throw new Error(`Provider ${model.provider}/${model.modelId} has no selected compiler role; no automatic fallback is allowed`);
  if ((image || mesh) && (!planning || !image || !mesh)) throw new Error('Cloud asset generation requires explicit planning/review, image generation, and image-to-3D selections');
  if (profile === 'studio' && (!reviewer || !detector || !segmentation || !multiview || !studioWorkers?.blender)) throw new Error('Studio requires reviewer, detector, segmentation, multiview, and Blender worker capabilities');
  let designSpec = localSpec;
  if (planning) {
    await providers.requireCapabilities(planning, { structuredOutput: true, imageInput: true });
    const input: JsonPlanningInput = {
      schemaName: 'WorldDesignSpec',
      jsonSchema: jsonSchemas.worldDesignSpec as Record<string, unknown>,
      messages: [
        { role: 'system', content: 'Convert only explicit user requirements into the provided renderer-neutral WorldDesignSpec schema. Preserve the exact seed and prompt. Use the documented 4 km square, 256 m chunks, 257 terrain samples, right-handed Y-up meters defaults only when absent, and list each default in defaultsApplied. Do not add gameplay, physics, navigation, networking, combat, or arbitrary code.' },
        { role: 'user', content: request.prompt },
      ],
    };
    const output = await providers.invoke<JsonPlanningInput, unknown>(planning, input, {}, idempotencyKey(request, 'planning', input), signal, 'terrain');
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('Planning provider returned a non-object WorldDesignSpec');
    designSpec = WorldDesignSpecSchema.parse({
      ...output,
      format: localSpec.format,
      version: localSpec.version,
      id: localSpec.id,
      seed: localSpec.seed,
      prompt: localSpec.prompt,
      units: localSpec.units,
      coordinateSystem: localSpec.coordinateSystem,
      bounds: localSpec.bounds,
      chunkSize: localSpec.chunkSize,
      terrainSamples: localSpec.terrainSamples,
    });
  }
  if (profile === 'studio' && (designSpec.terrainPlan.regions.length === 0 || designSpec.terrainPlan.materialSets.length === 0 || designSpec.terrainPlan.referenceCameras.length < designSpec.regions.length * 3)) {
    designSpec = WorldDesignSpecSchema.parse({
      ...designSpec,
      terrainPlan: buildExecutableTerrainPlan(designSpec.regions, designSpec.features, designSpec.assetRequirements.map((requirement) => requirement.class)),
      defaultsApplied: [...new Set([...designSpec.defaultsApplied, 'executable Studio terrain plan and three calibrated cameras per region'])],
    });
  }
  const references: ReferenceImage[] = [];
  const referenceProvenance: ProvenanceRecord[] = [];
  const stagedArtifacts: StagedBinaryArtifact[] = [];
  const regionalCompositionSources = new Map<string, { source: string; workerSource: string; bytes: Uint8Array; provenanceId: string }>();
  const generatedPrototypeIds: string[] = [];
  const optimizationWarnings: string[] = [];
  const generatedLibrary: AssetLibraryEntry[] = [];
  const compositionOverrides: CompositionPlacementOverride[] = [];
  try {
    if (profile === 'studio') designSpec = await stageStudioTerrainFoundation(designSpec, store, stagedArtifacts);
  if (image && mesh && (request.maxAssetGenerations > 0 || request.maxReferenceImages > 0)) {
    await providers.requireCapabilities(image, { imageInput: true });
    await providers.requireCapabilities(mesh, { imageInput: true });
    if (detector) await providers.requireCapabilities(detector, { structuredOutput: true, imageInput: true });
    if (segmentation) await providers.requireCapabilities(segmentation, { imageInput: true, segmentation: true });
    if (profile === 'studio') await providers.requireCapabilities(mesh, { multiImageInput: true, pbr3d: true });
    let terrainBundle = compileLocalWorldArtifacts({ ...request, providerModels: [], dryRun: true, maxAssetGenerations: 0, maxReferenceImages: 0 }, designSpec).bundle;
    const requestedHeroRegions = request.heroRegionIds.length > 0 ? request.heroRegionIds.map((id) => designSpec.regions.find((region) => region.id === id) ?? (() => { throw new Error(`Unknown hero region ${id}`); })()) : designSpec.regions;
    const plannedAssignments = profile === 'studio'
      ? planStudioHeroAssetGenerationAssignments(designSpec, request.assetLibrary, request.maxAssetGenerations, requestedHeroRegions.map((region) => region.id))
      : planAssetGenerationAssignments(designSpec, request.assetLibrary, request.maxAssetGenerations);
    for (const region of requestedHeroRegions.slice(0, request.maxReferenceImages)) {
      signal.throwIfAborted();
      const camera = referenceCamerasForRegion(region, 1)[0]!;
      let terrainDataUrl: string; let terrainProvenanceId: string; let terrainHash: string;
      if (profile === 'studio') {
        let acceptedTerrain: Awaited<ReturnType<typeof stageStudioTerrainRenders>> | undefined; let terrainDiagnosis = '';
        for (let terrainAttempt = 0; terrainAttempt < request.refinementPolicy.maxTerrainRounds; terrainAttempt += 1) {
          const rendered = await stageStudioTerrainRenders(designSpec, terrainBundle, region, studioWorkers!.blender!, store, references, referenceProvenance, stagedArtifacts, signal, terrainAttempt);
          const reviewInput: JsonPlanningInput = {
            schemaName: 'TerrainFoundationReview', jsonSchema: z.toJSONSchema(TerrainFoundationReviewSchema, { target: 'draft-7' }) as Record<string, unknown>,
            messages: [
              { role: 'system', content: 'Review only the supplied registered terrain passes. Return approval or bounded numeric adjustments from the schema. Never request code, new assets, topology replacement, an unregistered camera, or any free-form operation.' },
              { role: 'user', content: [{ type: 'text', text: JSON.stringify({ regionId: region.id, terrainAttempt, allowedTargets: { landform: designSpec.terrainPlan.regions.find((entry) => entry.regionId === region.id)?.operators.map((_operator, index) => `${region.id}:${index}`) ?? [], materials: designSpec.terrainPlan.materialSets.map((material) => material.id), scatter: designSpec.terrainPlan.scatterRecipes.filter((recipe) => recipe.regionId === region.id).map((recipe) => recipe.id) }, previousDiagnosis: terrainDiagnosis }) }, ...rendered.evidence.map((url) => ({ type: 'image_url', image_url: { url } }))] },
            ],
          };
          const review = TerrainFoundationReviewSchema.parse(await providers.invoke<JsonPlanningInput, unknown>(reviewer!, reviewInput, {}, idempotencyKey(request, `terrain-foundation-review:${region.id}:${terrainAttempt}`, { terrainPlan: designSpec.terrainPlan, environment: designSpec.environment, evidence: rendered.evidence.map((source) => createHash('sha256').update(source).digest('hex')) }), signal, 'terrain'));
          if (review.approved && review.adjustments.length === 0) { acceptedTerrain = rendered; break; }
          terrainDiagnosis = review.diagnosis;
          if (review.adjustments.length === 0 || terrainAttempt + 1 === request.refinementPolicy.maxTerrainRounds) break;
          designSpec = applyTerrainReviewAdjustments(designSpec, review.adjustments);
          designSpec = await stageStudioTerrainFoundation(designSpec, store, stagedArtifacts);
          terrainBundle = compileLocalWorldArtifacts({ ...request, providerModels: [], dryRun: true, maxAssetGenerations: 0, maxReferenceImages: 0 }, designSpec).bundle;
        }
        if (!acceptedTerrain) throw new Error(`Terrain refinement rounds exhausted for ${region.name}: ${terrainDiagnosis || 'terrain review rejected the registered passes'}`);
        terrainDataUrl = acceptedTerrain.source; terrainProvenanceId = acceptedTerrain.provenanceId; terrainHash = createHash('sha256').update(acceptedTerrain.bytes).digest('hex');
      } else {
        const terrainReference = renderTerrainReference(terrainBundle, region, camera, 768, 512);
        terrainDataUrl = `data:image/png;base64,${Buffer.from(terrainReference).toString('base64')}`;
        const storedTerrain = await store.put(terrainReference, 'image/png'); terrainHash = storedTerrain.contentHash;
        const terrainReferenceId = `reference-terrain-${slug(region.id)}-${storedTerrain.contentHash.slice(0, 10)}`; terrainProvenanceId = `provenance-${terrainReferenceId}`; const terrainUri = `references/${storedTerrain.contentHash}.png`;
        references.push({ id: terrainReferenceId, kind: 'terrain-reference', uri: terrainUri, contentHash: storedTerrain.contentHash, contentType: 'image/png', regionId: region.id, provenanceId: terrainProvenanceId });
        stagedArtifacts.push({ ...storedTerrain, uri: terrainUri, artifactKind: 'terrain-rgb', phase: 'terrain' });
        referenceProvenance.push({ id: terrainProvenanceId, subjectId: terrainReferenceId, kind: 'procedural', sourceUri: terrainUri, license: { name: 'Apache-2.0 project-authored terrain reference', commercialUse: true }, createdAt: new Date().toISOString(), contentHash: storedTerrain.contentHash, parentIds: [], reviewedAt: new Date().toISOString() });
      }
      const layout = plannedAssignments.filter((assignment) => assignment.regionId === region.id).map((assignment) => ({ assetClass: assignment.requirement.class, screenBox: assignment.screenBox }));
      const layoutInstruction = layout.length > 0 ? ` Use this structured 1536x1024 layout prior: ${layout.map((item) => `${item.assetClass} at pixel box [${item.screenBox.x},${item.screenBox.y},${item.screenBox.width},${item.screenBox.height}]`).join('; ')}. Keep each object's ground contact at the bottom center of its box.` : '';
      const baseConceptPrompt = `Edit the supplied render of the canonical terrain for ${region.name} in ${designSpec.title}. Preserve its topography, horizon, 3:2 camera, and major surface boundaries exactly. Add region-appropriate visual objects and materials for biome ${region.biome}, elevation ${region.elevation.min} to ${region.elevation.max} meters. ${region.description}. ${designSpec.style.description}.${layoutInstruction} This is a terrain-conditioned regional composition and structured 2D layout prior, not final geometry. PBR lighting, coherent scale and contact, no text, no gameplay UI.`;
      let diagnosis = ''; let ingested: Awaited<ReturnType<typeof ingestImage>> | undefined; let conceptPrompt = baseConceptPrompt;
      const maximumAttempts = profile === 'studio' ? request.refinementPolicy.maxCompositionAttempts : 1;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        conceptPrompt = diagnosis ? `${baseConceptPrompt} Repair the previous rejected attempt: ${diagnosis}` : baseConceptPrompt;
        const conceptInput = { prompt: conceptPrompt, size: '1536x1024' as const, quality: 'high' as const, background: 'opaque' as const, n: 1, inputImages: [{ source: terrainDataUrl, contentType: 'image/png' as const }] };
        const generated = await providers.invoke<typeof conceptInput, GeneratedImageOutput>(image, conceptInput, {}, idempotencyKey(request, `region-concept:${region.id}:attempt:${attempt}`, conceptInput), signal, 'composition');
        const selectedImage = generated.images[0];
        if (!selectedImage) throw new Error(`Image provider returned no regional concept for ${region.name}`);
        const candidate = await ingestImage(selectedImage, store, fetcher, signal);
        const candidateUri = `references/${candidate.reference.contentHash}.${imageExtension(candidate.contentType)}`;
        stagedArtifacts.push({ ...candidate.reference, uri: candidateUri, artifactKind: 'regional-composition', phase: 'composition' });
        if (profile !== 'studio' || !reviewer) { ingested = candidate; break; }
        const qualityInput: JsonPlanningInput = {
          schemaName: 'CompositionPreservationReview',
          jsonSchema: z.toJSONSchema(CompositionPreservationReviewSchema, { target: 'draft-7' }) as Record<string, unknown>,
          messages: [
            { role: 'system', content: 'Measure registered composition preservation. Ignore only the explicitly listed new-object boxes. Report structure outside those boxes, terrain-mask overlap, and maximum camera-landmark drift in pixels. Never approve by prose.' },
            { role: 'user', content: [
              { type: 'text', text: JSON.stringify({ thresholds: { structuralSimilarityOutsideObjects: 0.9, terrainMaskOverlap: 0.95, cameraLandmarkDriftPixels: 8 }, ignoredObjectBoxes: layout.map((item) => item.screenBox), attempt }) },
              { type: 'image_url', image_url: { url: terrainDataUrl } }, { type: 'image_url', image_url: { url: candidate.providerUri } },
            ] },
          ],
        };
        const quality = CompositionPreservationReviewSchema.parse(await providers.invoke<JsonPlanningInput, unknown>(reviewer, qualityInput, {}, idempotencyKey(request, `composition-preservation:${region.id}:${attempt}`, { terrainHash, candidateHash: candidate.reference.contentHash }), signal, 'composition'));
        if (quality.structuralSimilarityOutsideObjects >= 0.9 && quality.terrainMaskOverlap >= 0.95 && quality.cameraLandmarkDriftPixels <= 8) { ingested = candidate; break; }
        diagnosis = `${quality.diagnosis}; structure=${quality.structuralSimilarityOutsideObjects.toFixed(3)}, terrain IoU=${quality.terrainMaskOverlap.toFixed(3)}, camera drift=${quality.cameraLandmarkDriftPixels.toFixed(2)}px`;
      }
      if (!ingested) throw new Error(`Regional composition attempts exhausted for ${region.name}: ${diagnosis || 'preservation gates failed'}`);
      const referenceId = `reference-region-${slug(region.id)}-${ingested.reference.contentHash.slice(0, 10)}`;
      const provenanceId = `provenance-${referenceId}`;
      const uri = `references/${ingested.reference.contentHash}.${imageExtension(ingested.contentType)}`;
      references.push({ id: referenceId, kind: 'region-concept', uri, contentHash: ingested.reference.contentHash, contentType: ingested.contentType, regionId: region.id, provenanceId });
      const compositionBytes = await store.get(ingested.reference.contentHash);
      regionalCompositionSources.set(region.id, { source: ingested.providerUri, workerSource: `data:${ingested.contentType};base64,${Buffer.from(compositionBytes).toString('base64')}`, bytes: compositionBytes, provenanceId });
      if (!stagedArtifacts.some((artifact) => artifact.contentHash === ingested!.reference.contentHash && artifact.uri === uri)) stagedArtifacts.push({ ...ingested.reference, uri, artifactKind: 'regional-composition', phase: 'composition' });
      referenceProvenance.push({
        id: provenanceId, subjectId: referenceId, kind: 'generated', sourceUri: uri, provider: image.provider, modelId: image.modelId, modelRevision: image.revision,
        promptHash: createHash('sha256').update(conceptPrompt).digest('hex'), license: licenseFor(policies, image), createdAt: new Date().toISOString(), contentHash: ingested.reference.contentHash, parentIds: [terrainProvenanceId],
      });
      if (detector) {
        const requiredClasses = layout.map((item) => item.assetClass);
        const detectionInput: JsonPlanningInput = {
          schemaName: 'RegionalCompositionDetection',
          jsonSchema: z.toJSONSchema(CompositionDetectionSchema, { target: 'draft-7' }) as Record<string, unknown>,
          messages: [
            { role: 'system', content: 'Detect only clearly visible, reconstructable objects in the supplied 1536x1024 regional composition. Return exact pixel boxes from the actual image, use bottom-center as ground contact, preserve requested class names where visually supported, and never invent boxes or code.' },
            { role: 'user', content: [
              { type: 'text', text: JSON.stringify({ regionId: region.id, requiredClasses, style: designSpec.style.description, instruction: 'Return one descriptor per reconstructable hero object. Width/height must be positive and every box must remain within 1536x1024.' }) },
              { type: 'image_url', image_url: { url: ingested.providerUri } },
            ] },
          ],
        };
        const detectedRaw = await providers.invoke<JsonPlanningInput, unknown>(detector, detectionInput, {}, idempotencyKey(request, `composition-detection:${region.id}`, { conceptHash: ingested.reference.contentHash, requiredClasses }), signal, 'composition');
        const detected = CompositionDetectionSchema.parse(detectedRaw);
        if (detected.regionId !== region.id) throw new Error(`Composition detector targeted ${detected.regionId} instead of ${region.id}`);
        for (const descriptor of detected.objects) {
          if (descriptor.screenBox.x + descriptor.screenBox.width > 1536 || descriptor.screenBox.y + descriptor.screenBox.height > 1024) throw new Error(`Detected object ${descriptor.id} lies outside the regional composition`);
          compositionOverrides.push({ ...descriptor, regionId: region.id });
        }
      }
    }
    const missing = plannedAssignments.map((assignment) => {
      const detected = compositionOverrides.find((descriptor) => descriptor.regionId === assignment.regionId && descriptor.assetClass.toLowerCase() === assignment.requirement.class.toLowerCase());
      if (profile === 'studio' && !detected) throw new Error(`Studio composition did not visibly detect required ${assignment.requirement.class} in ${assignment.regionId}`);
      return detected ? { ...assignment, screenBox: detected.screenBox } : assignment;
    });
    for (const { requirement, index, regionId, screenBox } of missing) {
      signal.throwIfAborted();
      const assignedRegion = designSpec.regions.find((region) => region.id === regionId)!;
      const composition = regionalCompositionSources.get(assignedRegion.id);
      const prototypeId = PrototypeIdSchema.parse(`generated-${slug(requirement.class)}-${index + 1}-${createHash('sha256').update(`${request.seed}:${regionId}:${requirement.class}:${index}`).digest('hex').slice(0, 10)}`);
      let maskSource: string | undefined;
      let cropSource: string | undefined;
      let cropProvenanceId: string | undefined;
      if (segmentation && composition) {
        const segmentationInput = SegmentationInputSchema.parse({ image: composition.workerSource, box: screenBox, width: 1536, height: 1024 });
        const segmented = await providers.invoke<typeof segmentationInput, GeneratedImageOutput>(segmentation, segmentationInput, {}, idempotencyKey(request, `segment:${regionId}:${requirement.class}:${index}`, { composition: composition.provenanceId, screenBox }), signal, 'segmentation');
        const maskImage = segmented.images[0];
        if (!maskImage) throw new Error(`Segmentation worker returned no mask for ${requirement.class}`);
        const ingestedMask = await ingestImage(maskImage, store, fetcher, signal);
        maskSource = ingestedMask.providerUri;
        const maskId = `mask-${prototypeId}-${ingestedMask.reference.contentHash.slice(0, 10)}`;
        const maskProvenanceId = `provenance-${maskId}`;
        const maskUri = `references/${ingestedMask.reference.contentHash}.${imageExtension(ingestedMask.contentType)}`;
        references.push({ id: maskId, kind: 'object-mask', uri: maskUri, contentHash: ingestedMask.reference.contentHash, contentType: ingestedMask.contentType, prototypeId, provenanceId: maskProvenanceId });
        stagedArtifacts.push({ ...ingestedMask.reference, uri: maskUri, artifactKind: 'object-mask', phase: 'segmentation' });
        referenceProvenance.push({ id: maskProvenanceId, subjectId: maskId, kind: 'edited', sourceUri: maskUri, provider: segmentation.provider, modelId: segmentation.modelId, modelRevision: segmentation.revision, license: licenseFor(policies, segmentation), createdAt: new Date().toISOString(), contentHash: ingestedMask.reference.contentHash, parentIds: [composition.provenanceId] });
        const crop = await createLosslessAlphaCrop(composition.bytes, await store.get(ingestedMask.reference.contentHash), screenBox, 1536, 1024);
        const storedCrop = await store.put(crop.bytes, 'image/png');
        const cropId = `crop-${prototypeId}-${storedCrop.contentHash.slice(0, 10)}`;
        cropProvenanceId = `provenance-${cropId}`;
        const cropUri = `references/${storedCrop.contentHash}.png`;
        cropSource = `data:image/png;base64,${Buffer.from(crop.bytes).toString('base64')}`;
        references.push({ id: cropId, kind: 'object-crop', uri: cropUri, contentHash: storedCrop.contentHash, contentType: 'image/png', prototypeId, provenanceId: cropProvenanceId });
        stagedArtifacts.push({ ...storedCrop, uri: cropUri, artifactKind: 'object-crop', phase: 'segmentation' });
        referenceProvenance.push({ id: cropProvenanceId, subjectId: cropId, kind: 'edited', sourceUri: cropUri, provider: 'worldengine', modelId: 'lossless-alpha-crop', modelRevision: '1.0.0', license: licenseFor(policies, segmentation), createdAt: new Date().toISOString(), contentHash: storedCrop.contentHash, parentIds: [composition.provenanceId, maskProvenanceId] });
        const detected = compositionOverrides.find((descriptor) => descriptor.regionId === regionId && descriptor.assetClass.toLowerCase() === requirement.class.toLowerCase() && descriptor.screenBox.x === screenBox.x && descriptor.screenBox.y === screenBox.y);
        if (detected) detected.cropTransform = crop.transform;
      }
      const imagePrompt = composition
        ? `From the supplied regional composition for ${assignedRegion.name}, re-render the ${requirement.class} whose structured pixel box is [${screenBox.x},${screenBox.y},${screenBox.width},${screenBox.height}] as an isolated asset reference. Preserve that object's style, materials, proportions, and identity. Show the full object centered at physically plausible scale with PBR-friendly detail, no text, no people, transparent background. Do not include terrain or neighboring objects.`
        : `Isolated ${requirement.class} visual asset for ${designSpec.title}. ${designSpec.style.description}. Full object, centered, physically plausible scale, PBR-friendly materials, no text, no people, transparent background.`;
      const imageInput = { prompt: imagePrompt, size: '1024x1024' as const, quality: 'high' as const, background: 'transparent' as const, n: 1, inputImages: cropSource ? [{ source: cropSource }] : composition ? [{ source: composition.source }, ...(maskSource ? [{ source: maskSource }] : [])] : [] };
      const generated = await providers.invoke<typeof imageInput, GeneratedImageOutput>(image, imageInput, {}, idempotencyKey(request, `isolated-image:${requirement.class}:${index}`, imageInput), signal, 'multiview');
      const selectedImage = generated.images[0];
      if (!selectedImage) throw new Error(`Image provider returned no image for ${requirement.class}`);
      const ingestedImage = await ingestImage(selectedImage, store, fetcher, signal);
      const referenceId = `reference-${slug(requirement.class)}-${index + 1}-${ingestedImage.reference.contentHash.slice(0, 10)}`;
      const referenceProvenanceId = `provenance-${referenceId}`;
      const referenceUri = `references/${ingestedImage.reference.contentHash}.${imageExtension(ingestedImage.contentType)}`;
      const reference: ReferenceImage = {
        id: referenceId,
        kind: 'object-isolated',
        uri: referenceUri,
        contentHash: ingestedImage.reference.contentHash,
        contentType: ingestedImage.contentType,
        prototypeId,
        provenanceId: referenceProvenanceId,
      };
      references.push(reference);
      stagedArtifacts.push({ ...ingestedImage.reference, uri: referenceUri, artifactKind: 'object-isolated', phase: 'multiview' });
      referenceProvenance.push({
        id: referenceProvenanceId,
        subjectId: referenceId,
        kind: 'generated',
        sourceUri: referenceUri,
        provider: image.provider,
        modelId: image.modelId,
        modelRevision: image.revision,
        promptHash: createHash('sha256').update(imagePrompt).digest('hex'),
        license: licenseFor(policies, image),
        createdAt: new Date().toISOString(),
        contentHash: ingestedImage.reference.contentHash,
        parentIds: cropProvenanceId ? [cropProvenanceId] : composition ? [composition.provenanceId] : [],
      });
      let viewSources: MultiImageTo3DInput['images'] = [{ source: ingestedImage.providerUri, orientation: 'front' }];
      let imageHashes = [ingestedImage.reference.contentHash];
      let regenerateStudioViews: ((attempt: number, diagnosis: string) => Promise<void>) | undefined;
      if (profile === 'studio' && multiview) {
        const multiviewSelection = multiview;
        await providers.requireCapabilities(multiviewSelection, { imageInput: true });
        const frontViewId = `multiview-${prototypeId}-front-${ingestedImage.reference.contentHash.slice(0, 10)}`;
        const frontViewProvenanceId = `provenance-${frontViewId}`;
        references.push({ id: frontViewId, kind: 'object-multiview', uri: referenceUri, contentHash: ingestedImage.reference.contentHash, contentType: ingestedImage.contentType, prototypeId, provenanceId: frontViewProvenanceId });
        stagedArtifacts.push({ ...ingestedImage.reference, uri: referenceUri, artifactKind: 'object-multiview-front', phase: 'multiview' });
        referenceProvenance.push({ id: frontViewProvenanceId, subjectId: frontViewId, kind: 'edited', sourceUri: referenceUri, provider: 'worldengine', modelId: 'identity-front-view', modelRevision: '1.0.0', promptHash: createHash('sha256').update(imagePrompt).digest('hex'), license: licenseFor(policies, image), createdAt: new Date().toISOString(), contentHash: ingestedImage.reference.contentHash, parentIds: [referenceProvenanceId] });
        regenerateStudioViews = async (attempt, diagnosis) => {
          const nextSources: MultiImageTo3DInput['images'] = [{ source: ingestedImage.providerUri, orientation: 'front' }]; const nextHashes = [ingestedImage.reference.contentHash];
          for (const orientation of ['left', 'back', 'right'] as const) {
            const viewPrompt = `Re-render this exact isolated ${requirement.class} from the ${orientation} view. Preserve identity, geometry, proportions, materials, colors, scale, neutral PBR lighting, transparent background, and full-object framing. Do not add or remove parts.${diagnosis ? ` Repair the previous reconstruction evidence: ${diagnosis}` : ''}`;
            const viewInput = { prompt: viewPrompt, size: '1024x1024' as const, quality: 'high' as const, background: 'transparent' as const, n: 1, inputImages: [{ source: ingestedImage.providerUri }] };
            const viewOutput = await providers.invoke<typeof viewInput, GeneratedImageOutput>(multiviewSelection, viewInput, {}, idempotencyKey(request, `multiview:${requirement.class}:${index}:attempt:${attempt}:${orientation}`, { sourceHash: ingestedImage.reference.contentHash, viewInput }), signal, 'multiview');
            const generatedView = viewOutput.images[0];
            if (!generatedView) throw new Error(`Multiview generator returned no ${orientation} view for ${requirement.class}`);
            const ingestedView = await ingestImage(generatedView, store, fetcher, signal);
            const viewId = `multiview-${prototypeId}-attempt-${attempt}-${orientation}-${ingestedView.reference.contentHash.slice(0, 10)}`;
            const viewProvenanceId = `provenance-${viewId}`; const viewUri = `references/${ingestedView.reference.contentHash}.${imageExtension(ingestedView.contentType)}`;
            references.push({ id: viewId, kind: 'object-multiview', uri: viewUri, contentHash: ingestedView.reference.contentHash, contentType: ingestedView.contentType, prototypeId, provenanceId: viewProvenanceId });
            stagedArtifacts.push({ ...ingestedView.reference, uri: viewUri, artifactKind: `object-multiview-${orientation}`, phase: 'multiview' });
            referenceProvenance.push({ id: viewProvenanceId, subjectId: viewId, kind: 'generated', sourceUri: viewUri, provider: multiviewSelection.provider, modelId: multiviewSelection.modelId, modelRevision: multiviewSelection.revision, promptHash: createHash('sha256').update(viewPrompt).digest('hex'), license: licenseFor(policies, multiviewSelection), createdAt: new Date().toISOString(), contentHash: ingestedView.reference.contentHash, parentIds: [referenceProvenanceId] });
            nextSources.push({ source: ingestedView.providerUri, orientation }); nextHashes.push(ingestedView.reference.contentHash);
          }
          viewSources = nextSources; imageHashes = nextHashes;
        };
        await regenerateStudioViews(0, '');
      }
      let meshInput: TripoImageTo3DInput | MultiImageTo3DInput = profile === 'studio'
        ? { images: viewSources, pbr: true, geometryQuality: 'detailed', textureResolution: '4k', faceLimit: 250_000, seed: request.seed + index }
        : { image: ingestedImage.providerUri, texture: true, pbr: true, texture_quality: 'detailed', geometry_quality: 'detailed', texture_alignment: 'original_image', orientation: 'align_image', auto_size: false, quad: false, model_seed: request.seed + index, texture_seed: request.seed + index };
      let glb: PredictionOutput['outputs'][number] | undefined;
      let blenderResult: BlenderRefinementResult | undefined;
      const reconstructionAttempts = profile === 'studio' ? request.refinementPolicy.maxAssetAttempts : 1;
      for (let reconstructionAttempt = 0; reconstructionAttempt < reconstructionAttempts; reconstructionAttempt += 1) {
        const attemptInput = profile === 'studio'
          ? { ...(meshInput as MultiImageTo3DInput), seed: (meshInput as MultiImageTo3DInput).seed + reconstructionAttempt }
          : meshInput;
        const prediction = await providers.invoke<typeof attemptInput, PredictionOutput>(mesh, attemptInput, {}, idempotencyKey(request, `image-to-3d:${requirement.class}:${index}:attempt:${reconstructionAttempt}`, { imageHashes, settings: attemptInput }), signal, 'reconstruction');
        const candidate = prediction.outputs.find((output) => output.contentType === 'model/gltf-binary' || output.sourceUrl.toLowerCase().endsWith('.glb'));
        if (!candidate) throw new Error(`3D provider returned no GLB for ${requirement.class}`);
        assertValidGlb(candidate.bytes);
        const candidateStored = await store.put(candidate.bytes, 'model/gltf-binary');
        stagedArtifacts.push({ ...candidateStored, uri: `assets/${candidateStored.contentHash}.glb`, artifactKind: 'raw-glb', phase: 'reconstruction' });
        if (profile !== 'studio') { glb = candidate; break; }
        blenderResult = await studioWorkers!.blender!.refine(candidate.bytes, {
          operations: ['validate-mesh', 'fix-normals', 'normalize-origin', 'normalize-materials', 'fix-ground-contact', 'export-glb', 'render-turntable', 'render-passes'],
          targetHeightMeters: Math.max(1, boundsRadiusForAssetClass(requirement.class) * 2), renderResolution: 512,
        }, signal);
        const errors = blenderResult.diagnostics.filter((item) => item.severity === 'error');
        if (errors.length === 0) { glb = candidate; break; }
        optimizationWarnings.push(`Rejected reconstruction attempt ${reconstructionAttempt + 1} for ${prototypeId}: ${errors.map((item) => `${item.code}: ${item.message}`).join('; ')}`);
        if (reconstructionAttempt + 1 === reconstructionAttempts) throw new Error(`Asset reconstruction attempts exhausted for ${prototypeId}: ${errors.map((item) => item.message).join('; ')}`);
        if (!regenerateStudioViews) throw new Error(`Studio reconstruction ${prototypeId} cannot regenerate its multiview evidence`);
        await regenerateStudioViews(reconstructionAttempt + 1, errors.map((item) => `${item.code}: ${item.message}`).join('; '));
        meshInput = { ...(meshInput as MultiImageTo3DInput), images: viewSources };
      }
      if (!glb) throw new Error(`3D reconstruction produced no accepted GLB for ${requirement.class}`);
      const rawStoredGlb = await store.put(glb.bytes, 'model/gltf-binary');
      const refinedBytes = blenderResult?.glb ?? glb.bytes;
      const refinedStoredGlb = await store.put(refinedBytes, 'model/gltf-binary');
      let optimizedGlb: Awaited<ReturnType<typeof transcodeGlbTexturesToKtx2>> = { bytes: refinedBytes, textureFormat: 'source', textureCount: 0, convertedTextures: 0, sourceTextureBytes: 0, optimizedTextureBytes: 0 };
      try {
        optimizedGlb = await transcodeGlbTexturesToKtx2(refinedBytes);
      } catch (error) {
        optimizationWarnings.push(`Could not generate KTX2 textures for ${prototypeId}: ${(error as Error).message}`);
      }
      const storedGlb = await store.put(optimizedGlb.bytes, 'model/gltf-binary');
      const assetUri = `assets/${storedGlb.contentHash}.glb`;
      const rawAssetUri = `assets/${rawStoredGlb.contentHash}.glb`;
      const refinedAssetUri = `assets/${refinedStoredGlb.contentHash}.glb`;
      if (rawStoredGlb.contentHash !== storedGlb.contentHash) stagedArtifacts.push({ ...rawStoredGlb, uri: rawAssetUri, artifactKind: 'raw-glb', phase: 'reconstruction' });
      if (refinedStoredGlb.contentHash !== rawStoredGlb.contentHash && refinedStoredGlb.contentHash !== storedGlb.contentHash) stagedArtifacts.push({ ...refinedStoredGlb, uri: refinedAssetUri, artifactKind: 'refined-glb', phase: 'asset-validation' });
      stagedArtifacts.push({ ...storedGlb, uri: assetUri, artifactKind: 'refined-glb', phase: 'asset-validation' });
      generatedPrototypeIds.push(prototypeId);
      const provenanceId = `provenance-${prototypeId}`;
      const createdAt = new Date().toISOString();
      const promptHash = createHash('sha256').update(imagePrompt).digest('hex');
      const sourceProvenanceId = `${provenanceId}-provider-source`;
      const rawProvenance: ProvenanceRecord = {
        id: sourceProvenanceId, subjectId: `${prototypeId}:provider-source`, kind: 'generated', sourceUri: rawAssetUri,
        provider: mesh.provider, modelId: mesh.modelId, modelRevision: mesh.revision, promptHash, license: licenseFor(policies, mesh),
        createdAt, contentHash: rawStoredGlb.contentHash, parentIds: [referenceProvenanceId],
      };
      const blenderProvenanceId = `${provenanceId}-blender-refined`;
      const blenderProvenance: ProvenanceRecord | undefined = refinedStoredGlb.contentHash !== rawStoredGlb.contentHash ? {
        id: blenderProvenanceId, subjectId: `${prototypeId}:blender-refined`, kind: 'edited', sourceUri: refinedAssetUri, provider: 'worldengine-blender-worker', modelId: 'allowlisted-refinement', modelRevision: blenderResult?.workerVersion ?? '1.0.0', promptHash, license: licenseFor(policies, mesh), createdAt, contentHash: refinedStoredGlb.contentHash, parentIds: [sourceProvenanceId],
      } : undefined;
      const finalParentId = blenderProvenance?.id ?? sourceProvenanceId;
      const sourceProvenance: ProvenanceRecord[] = rawStoredGlb.contentHash !== storedGlb.contentHash || blenderProvenance ? [rawProvenance, ...(blenderProvenance ? [blenderProvenance] : [])] : [];
      const provenance: ProvenanceRecord = sourceProvenance.length > 0 ? {
        id: provenanceId, subjectId: prototypeId, kind: 'edited', sourceUri: assetUri, provider: 'worldengine', modelId: 'ktx2-encoder', modelRevision: '0.6.0/basis-1b33fd5',
        promptHash, license: licenseFor(policies, mesh), createdAt, contentHash: storedGlb.contentHash, parentIds: [finalParentId],
      } : {
        id: provenanceId, subjectId: prototypeId, kind: 'generated', sourceUri: assetUri, provider: mesh.provider, modelId: mesh.modelId, modelRevision: mesh.revision,
        promptHash, license: licenseFor(policies, mesh), createdAt, contentHash: storedGlb.contentHash, parentIds: [referenceProvenanceId],
      };
      if (blenderResult) {
        optimizationWarnings.push(...blenderResult.diagnostics.filter((item) => item.severity !== 'info').map((item) => `Blender ${item.code}: ${item.message}`));
        for (const [renderIndex, render] of blenderResult.renders.entries()) {
          const storedRender = await store.put(render.bytes, 'image/png');
          const renderId = `${render.kind}-${prototypeId}-${renderIndex}-${storedRender.contentHash.slice(0, 10)}`;
          const renderProvenanceId = `provenance-${renderId}`;
          const renderUri = `references/${storedRender.contentHash}.png`;
          references.push({ id: renderId, kind: render.kind, uri: renderUri, contentHash: storedRender.contentHash, contentType: 'image/png', prototypeId, provenanceId: renderProvenanceId });
          stagedArtifacts.push({ ...storedRender, uri: renderUri, artifactKind: render.kind, phase: 'asset-validation' });
          referenceProvenance.push({ id: renderProvenanceId, subjectId: renderId, kind: 'edited', sourceUri: renderUri, provider: 'worldengine-blender-worker', modelId: 'allowlisted-refinement-render', modelRevision: blenderResult.workerVersion, license: licenseFor(policies, mesh), createdAt, contentHash: storedRender.contentHash, parentIds: [provenanceId] });
        }
      }
      const diagnostic = await renderGlbDiagnostic(optimizedGlb.bytes);
      const storedDiagnostic = await store.put(diagnostic.bytes, 'image/png');
      const diagnosticId = `diagnostic-${prototypeId}-${storedDiagnostic.contentHash.slice(0, 10)}`;
      const diagnosticProvenanceId = `provenance-${diagnosticId}`;
      const diagnosticUri = `references/${storedDiagnostic.contentHash}.png`;
      references.push({
        id: diagnosticId,
        kind: 'object-diagnostic',
        uri: diagnosticUri,
        contentHash: storedDiagnostic.contentHash,
        contentType: 'image/png',
        prototypeId,
        provenanceId: diagnosticProvenanceId,
      });
      stagedArtifacts.push({ ...storedDiagnostic, uri: diagnosticUri, artifactKind: 'object-diagnostic', phase: 'asset-validation' });
      referenceProvenance.push({
        id: diagnosticProvenanceId,
        subjectId: diagnosticId,
        kind: 'edited',
        sourceUri: diagnosticUri,
        provider: 'worldengine',
        modelId: 'cpu-glb-diagnostic',
        modelRevision: '1.0.0',
        promptHash,
        license: licenseFor(policies, mesh),
        createdAt,
        contentHash: storedDiagnostic.contentHash,
        parentIds: [provenanceId],
      });
      const boundsRadius = boundsRadiusForAssetClass(requirement.class);
      const lods: AssetLibraryEntry['lods'] = [];
      const lodProvenance: ProvenanceRecord[] = [];
      try {
        const optimized = await generateMeshLods(optimizedGlb.bytes);
        const baseDistance = Math.max(48, boundsRadius * 10);
        for (const [lodIndex, level] of optimized.entries()) {
          const storedLod = await store.put(level.bytes, 'model/gltf-binary');
          const lodUri = `assets/${storedLod.contentHash}.glb`;
          const lodProvenanceId = `${provenanceId}-lod-${lodIndex + 1}`;
          stagedArtifacts.push({ ...storedLod, uri: lodUri, artifactKind: 'refined-glb', phase: 'asset-validation' });
          lods.push({ distance: baseDistance * (lodIndex === 0 ? 1 : 2.5), assetUri: lodUri, contentHash: storedLod.contentHash, provenanceId: lodProvenanceId });
          lodProvenance.push({
            id: lodProvenanceId, subjectId: `${prototypeId}:lod:${lodIndex + 1}`, kind: 'edited', sourceUri: lodUri,
            provider: 'worldengine', modelId: 'meshoptimizer', modelRevision: '1.2.0', license: licenseFor(policies, mesh), createdAt,
            contentHash: storedLod.contentHash, parentIds: [provenanceId],
          });
        }
      } catch (error) {
        optimizationWarnings.push(`Could not generate mesh LODs for ${prototypeId}: ${(error as Error).message}`);
      }
      generatedLibrary.push(AssetLibraryEntrySchema.parse({
        id: prototypeId,
        class: requirement.class,
        assetUri,
        contentHash: storedGlb.contentHash,
        textureFormat: optimizedGlb.textureFormat,
        boundsRadius,
        lods,
        materialVariants: ['default'],
        animationClips: [],
        tags: requirement.tags,
        provenance,
        sourceProvenance,
        lodProvenance,
        rightsAffirmed: true,
      }));
    }
  }
    return { request: { ...request, designSpec, assetLibrary: [...request.assetLibrary, ...generatedLibrary] }, designSpec, references, referenceProvenance, stagedArtifacts, generatedPrototypeIds, optimizationWarnings, compositionOverrides };
  } catch (cause) {
    const failure = cause instanceof Error ? cause.message : String(cause);
    return { request: { ...request, designSpec, assetLibrary: [...request.assetLibrary, ...generatedLibrary] }, designSpec, references, referenceProvenance, stagedArtifacts, generatedPrototypeIds, optimizationWarnings, compositionOverrides, failure };
  }
}

export async function reviewCloudArtifacts(
  artifactInput: CompiledWorldArtifacts,
  preparation: CloudPreparation,
  originalRequest: CompileRequest,
  providers: ProviderExecutionRegistry,
  store: BinaryArtifactStore | undefined,
  signal: AbortSignal,
): Promise<CompiledWorldArtifacts> {
  const reviewer = selection(originalRequest, 'reviewer');
  let placementDiagnosticSummary: Record<string, unknown> | undefined;
  if (reviewer && preparation.generatedPrototypeIds.length > 0) {
    if (!store) throw new Error('Generated placement review requires the configured binary artifact store');
    const atlas = await renderPlacementDiagnosticAtlas(artifactInput.bundle, artifactInput.authoringWorld, new Set(preparation.generatedPrototypeIds));
    if (!atlas) throw new Error('Generated assets have no regional composition anchors for placement review');
    if (atlas.maximumProjectionErrorPixels > 4) throw new Error(`Deterministic placement gate failed: center error ${atlas.maximumProjectionErrorPixels.toFixed(2)}px exceeds 4px`);
    if (atlas.maximumTerrainContactErrorMeters > 0.05) throw new Error(`Deterministic placement gate failed: terrain contact error ${atlas.maximumTerrainContactErrorMeters.toFixed(3)}m exceeds 0.05m`);
    const stored = await store.put(atlas.bytes, 'image/png');
    const referenceId = `diagnostic-placement-${stored.contentHash.slice(0, 12)}`;
    const provenanceId = `provenance-${referenceId}`;
    const uri = `references/${stored.contentHash}.png`;
    const prototypeParents = artifactInput.authoringWorld.prototypes.filter((prototype) => preparation.generatedPrototypeIds.includes(prototype.id)).map((prototype) => prototype.provenanceId);
    const compositionParents = preparation.references.filter((reference) => reference.kind === 'region-concept').map((reference) => reference.provenanceId);
    const parentIds = [...new Set([...prototypeParents, ...compositionParents])];
    const parentProvenance = new Map([...artifactInput.authoringWorld.provenance, ...preparation.referenceProvenance].map((record) => [record.id, record]));
    const commercialUse = parentIds.every((id) => parentProvenance.get(id)?.license.commercialUse === true);
    preparation.references.push({ id: referenceId, kind: 'placement-diagnostic', uri, contentHash: stored.contentHash, contentType: 'image/png', provenanceId });
    preparation.referenceProvenance.push({
      id: provenanceId,
      subjectId: referenceId,
      kind: 'edited',
      sourceUri: uri,
      provider: 'worldengine',
      modelId: 'cpu-placement-diagnostic',
      modelRevision: '1.2.0-calibrated',
      license: { name: 'Diagnostic render inherits parent asset terms', commercialUse },
      createdAt: new Date().toISOString(),
      contentHash: stored.contentHash,
      parentIds,
    });
    preparation.stagedArtifacts.push({ ...stored, uri, artifactKind: 'placement-atlas', phase: 'placement' });
    placementDiagnosticSummary = {
      compositionIds: atlas.compositionIds,
      renderedObjects: atlas.renderedObjects,
      maximumProjectionErrorPixels: atlas.maximumProjectionErrorPixels,
      maximumTerrainContactErrorMeters: atlas.maximumTerrainContactErrorMeters,
      legend: 'Yellow rectangle = requested composition box; green/red cross = actual inverse-projected terrain anchor',
    };
  }
  let artifact: CompiledWorldArtifacts = {
    designSpec: artifactInput.designSpec,
    authoringWorld: AuthoringWorldSchema.parse({
      ...artifactInput.authoringWorld,
      referenceImages: preparation.references,
      provenance: [...artifactInput.authoringWorld.provenance, ...preparation.referenceProvenance],
      diagnostics: [...artifactInput.authoringWorld.diagnostics, ...preparation.optimizationWarnings.map((message) => ({ severity: 'warning' as const, code: 'MESH_LOD_OPTIMIZATION', message }))],
    }),
    bundle: VisualWorldBundleSchema.parse({ ...artifactInput.bundle, provenance: [...artifactInput.bundle.provenance, ...preparation.referenceProvenance] }),
  };
  if (!reviewer || preparation.references.length === 0) {
    if (preparation.generatedPrototypeIds.length > 0 || preparation.referenceProvenance.some((record) => record.kind === 'generated' && !record.reviewedAt)) throw new Error('Generated artifacts require an explicit multimodal reviewer before publication');
    return artifact;
  }
  if (!store) throw new Error('Multimodal review requires the configured binary artifact store');
  let acceptedReview: z.infer<typeof CloudReviewSchema> | undefined;
  const sceneRounds = effectiveQualityProfile(originalRequest) === 'studio' ? originalRequest.refinementPolicy.maxSceneRounds : originalRequest.refinementPolicy.maxSceneRepairRounds;
  for (let repairRound = 0; repairRound <= sceneRounds; repairRound += 1) {
    const text = JSON.stringify({
      title: artifact.designSpec.title,
      style: artifact.designSpec.style,
      regions: artifact.designSpec.regions.map((region) => ({ id: region.id, biome: region.biome, density: region.density })),
      generatedPrototypeIds: preparation.generatedPrototypeIds,
      placementDiagnostic: placementDiagnosticSummary,
      deterministicDiagnostics: artifact.authoringWorld.diagnostics,
      repairRound,
      instruction: 'Images are ordered as canonical terrain input then edited regional composition for each region, followed by masks, isolated/multiview references, exact runtime GLB and Blender passes; the final image is the newest placement atlas. Reject altered topography/camera, malformed shape/orientation/part scale, visibly displaced anchors, wrong class/style, or unstable contact. Never infer approval from raw provider output. Return null patch only when no deterministic transform/state/environment correction is required.',
    });
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
    const reviewImageUris = await Promise.all(preparation.references.map(async (reference) => {
      const bytes = await store.get(reference.contentHash);
      return `data:${reference.contentType};base64,${Buffer.from(bytes).toString('base64')}`;
    }));
    if (reviewImageUris.length !== preparation.references.length) throw new Error('Multimodal review evidence does not match the persisted reference set');
    for (const uri of reviewImageUris) content.push({ type: 'image_url', image_url: { url: uri } });
    const input: JsonPlanningInput = {
      schemaName: 'VisualReview',
      jsonSchema: z.toJSONSchema(sceneRounds === 0 ? TerminalCloudReviewSchema : CloudReviewSchema, { target: 'draft-7' }) as Record<string, unknown>,
      messages: [
        { role: 'system', content: 'Review only visual consistency. Never emit code or scripts. A patch may only adjust existing transforms, visual states, or environment values and must target the supplied world revision.' },
        { role: 'user', content },
      ],
    };
    const rawReview = await providers.invoke<JsonPlanningInput, unknown>(reviewer, input, {}, idempotencyKey(originalRequest, `visual-review:${repairRound}`, { text, imageHashes: preparation.references.map((reference) => reference.contentHash) }), signal, 'review');
    const review = CloudReviewSchema.parse(rawReview);
    if (review.patch && repairRound < sceneRounds) {
      const patch = validateVisualReviewPatch(review.patch, artifact.bundle.worldId, artifact.bundle.sourceRevision);
      const patched = applyCanonicalPatch(artifact.designSpec, artifact.authoringWorld, artifact.bundle, patch);
      artifact = { designSpec: patched.designSpec, authoringWorld: patched.authoringWorld, bundle: patched.bundle };
      const atlas = await renderPlacementDiagnosticAtlas(artifact.bundle, artifact.authoringWorld, new Set(preparation.generatedPrototypeIds));
      if (!atlas) throw new Error('Scene repair removed every generated placement anchor');
      if (atlas.maximumProjectionErrorPixels > 4) throw new Error(`Scene repair failed deterministic center gate: ${atlas.maximumProjectionErrorPixels.toFixed(2)}px`);
      if (atlas.maximumTerrainContactErrorMeters > 0.05) throw new Error(`Scene repair failed deterministic contact gate: ${atlas.maximumTerrainContactErrorMeters.toFixed(3)}m`);
      const stored = await store.put(atlas.bytes, 'image/png');
      const referenceId = `diagnostic-placement-repair-${repairRound + 1}-${stored.contentHash.slice(0, 12)}`;
      const provenanceId = `provenance-${referenceId}`; const uri = `references/${stored.contentHash}.png`;
      const parentIds = artifact.authoringWorld.prototypes.filter((prototype) => preparation.generatedPrototypeIds.includes(prototype.id)).map((prototype) => prototype.provenanceId);
      const provenance: ProvenanceRecord = { id: provenanceId, subjectId: referenceId, kind: 'edited', sourceUri: uri, provider: 'worldengine', modelId: 'cpu-placement-diagnostic', modelRevision: '1.2.0-calibrated', license: { name: 'Diagnostic render inherits reviewed generated asset terms', commercialUse: parentIds.every((id) => artifact.authoringWorld.provenance.find((record) => record.id === id)?.license.commercialUse === true) }, createdAt: new Date().toISOString(), contentHash: stored.contentHash, parentIds };
      const reference: ReferenceImage = { id: referenceId, kind: 'placement-diagnostic', uri, contentHash: stored.contentHash, contentType: 'image/png', provenanceId };
      preparation.references.push(reference); preparation.referenceProvenance.push(provenance); preparation.stagedArtifacts.push({ ...stored, uri, artifactKind: 'placement-atlas', phase: 'scene-refinement' });
      artifact.authoringWorld = AuthoringWorldSchema.parse({ ...artifact.authoringWorld, referenceImages: [...artifact.authoringWorld.referenceImages, reference], provenance: [...artifact.authoringWorld.provenance, provenance] });
      artifact.bundle = VisualWorldBundleSchema.parse({ ...artifact.bundle, provenance: [...artifact.bundle.provenance, provenance] });
      placementDiagnosticSummary = { compositionIds: atlas.compositionIds, renderedObjects: atlas.renderedObjects, maximumProjectionErrorPixels: atlas.maximumProjectionErrorPixels, maximumTerrainContactErrorMeters: atlas.maximumTerrainContactErrorMeters, repairRound: repairRound + 1 };
      continue;
    }
    if (review.patch || review.actions.length > 0) throw new Error(`Multimodal visual review requested another typed scene repair after the bounded repair budget was exhausted: ${review.actions.map((action) => action.type).join(', ') || 'patch'}`);
    if (!review.approved || review.issues.some((issue) => issue.severity === 'error')) throw new Error(`Multimodal visual review rejected generated assets: ${review.issues.map((issue) => issue.message).join('; ') || 'not approved'}`);
    acceptedReview = review;
    break;
  }
  if (!acceptedReview) throw new Error('Multimodal visual review did not produce an accepted terminal result');
  const reviewedAt = new Date().toISOString();
  const markReviewed = (record: ProvenanceRecord): ProvenanceRecord => !record.reviewedAt && (record.kind === 'generated' || record.kind === 'edited') ? { ...record, reviewedAt } : record;
  artifact.authoringWorld = AuthoringWorldSchema.parse({
    ...artifact.authoringWorld,
    provenance: artifact.authoringWorld.provenance.map(markReviewed),
    diagnostics: [...artifact.authoringWorld.diagnostics, ...acceptedReview.issues.map((issue) => ({ severity: issue.severity, code: 'MULTIMODAL_REVIEW', message: issue.message, ...(issue.subjectId ? { subjectId: issue.subjectId } : {}) }))],
  });
  artifact.bundle = VisualWorldBundleSchema.parse({ ...artifact.bundle, provenance: artifact.bundle.provenance.map(markReviewed) });
  return artifact;
}
