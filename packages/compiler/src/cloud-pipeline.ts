import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AssetLibraryEntrySchema,
  AuthoringWorldSchema,
  PrototypeIdSchema,
  VisualWorldBundleSchema,
  WorldDesignSpecSchema,
  WorldPatchSchema,
  jsonSchemas,
  type AssetLibraryEntry,
  type CompileRequest,
  type ProvenanceRecord,
  type ReferenceImage,
  type ProviderRole,
  type WorldDesignSpec,
} from '@worldengine/schema';
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
import { transcodeGlbTexturesToKtx2 } from './texture-optimizer.js';
import { effectiveQualityProfile, providerForRole } from './quality-profile.js';
import { SegmentationInputSchema, type BlenderRefinementResult, type StudioWorkerRegistry } from './studio-workers.js';
import type { CompositionPlacementOverride } from './authoring-compiler.js';

export interface StagedBinaryArtifact extends BinaryArtifactReference { uri: string }

export interface CloudPreparation {
  request: CompileRequest;
  designSpec: WorldDesignSpec;
  references: ReferenceImage[];
  referenceProvenance: ProvenanceRecord[];
  stagedArtifacts: StagedBinaryArtifact[];
  generatedPrototypeIds: string[];
  optimizationWarnings: string[];
  compositionOverrides: CompositionPlacementOverride[];
}

const CloudReviewSchema = z.object({
  approved: z.boolean(),
  issues: z.array(z.object({ severity: z.enum(['info', 'warning', 'error']), message: z.string().min(1), subjectId: z.string().optional() })).default([]),
  patch: WorldPatchSchema.nullable().default(null),
});

const CompositionDetectionSchema = z.object({
  regionId: z.string().min(1),
  objects: z.array(ObjectDescriptorSchema).min(1).max(40),
});

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

function compositionLayout(spec: WorldDesignSpec, regionIndex: number): Array<{ assetClass: string; screenBox: { x: number; y: number; width: number; height: number } }> {
  const layout: Array<{ assetClass: string; screenBox: { x: number; y: number; width: number; height: number } }> = [];
  let prototypeIndex = 0;
  for (const requirement of spec.assetRequirements) for (let count = 0; count < Math.max(1, requirement.count); count += 1) {
    if (prototypeIndex % spec.regions.length === regionIndex) {
      const column = prototypeIndex % 4;
      const row = Math.floor(prototypeIndex / 4) % 3;
      layout.push({ assetClass: requirement.class, screenBox: { x: 520 + column * 128, y: 330 + row * 48, width: 96, height: 150 } });
    }
    prototypeIndex += 1;
  }
  return layout;
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
    const output = await providers.invoke<JsonPlanningInput, unknown>(planning, input, { temperature: 0 }, idempotencyKey(request, 'planning', input), signal);
    designSpec = WorldDesignSpecSchema.parse(output);
    if (designSpec.seed !== request.seed || designSpec.prompt !== request.prompt) throw new Error('Planning provider changed the canonical seed or prompt');
  }
  const references: ReferenceImage[] = [];
  const referenceProvenance: ProvenanceRecord[] = [];
  const stagedArtifacts: StagedBinaryArtifact[] = [];
  const regionalCompositionSources = new Map<string, { source: string; workerSource: string; provenanceId: string }>();
  const generatedPrototypeIds: string[] = [];
  const optimizationWarnings: string[] = [];
  const generatedLibrary: AssetLibraryEntry[] = [];
  const compositionOverrides: CompositionPlacementOverride[] = [];
  if (image && mesh && (request.maxAssetGenerations > 0 || request.maxReferenceImages > 0)) {
    await providers.requireCapabilities(image, { imageInput: true });
    await providers.requireCapabilities(mesh, { imageInput: true });
    if (detector) await providers.requireCapabilities(detector, { structuredOutput: true, imageInput: true });
    if (segmentation) await providers.requireCapabilities(segmentation, { imageInput: true, segmentation: true });
    if (profile === 'studio') await providers.requireCapabilities(mesh, { multiImageInput: true, pbr3d: true });
    const terrainBundle = compileLocalWorldArtifacts({ ...request, providerModels: [], dryRun: true, maxAssetGenerations: 0, maxReferenceImages: 0 }, designSpec).bundle;
    const requestedHeroRegions = request.heroRegionIds.length > 0 ? request.heroRegionIds.map((id) => designSpec.regions.find((region) => region.id === id) ?? (() => { throw new Error(`Unknown hero region ${id}`); })()) : designSpec.regions;
    for (const [regionIndex, region] of requestedHeroRegions.slice(0, request.maxReferenceImages).entries()) {
      signal.throwIfAborted();
      const camera = referenceCamerasForRegion(region, 1)[0]!;
      const terrainReference = renderTerrainReference(terrainBundle, region, camera, 768, 512);
      const terrainDataUrl = `data:image/png;base64,${Buffer.from(terrainReference).toString('base64')}`;
      const storedTerrain = await store.put(terrainReference, 'image/png');
      const terrainReferenceId = `reference-terrain-${slug(region.id)}-${storedTerrain.contentHash.slice(0, 10)}`;
      const terrainProvenanceId = `provenance-${terrainReferenceId}`;
      const terrainUri = `references/${storedTerrain.contentHash}.png`;
      references.push({ id: terrainReferenceId, kind: 'terrain-reference', uri: terrainUri, contentHash: storedTerrain.contentHash, contentType: 'image/png', regionId: region.id, provenanceId: terrainProvenanceId });
      stagedArtifacts.push({ ...storedTerrain, uri: terrainUri });
      referenceProvenance.push({
        id: terrainProvenanceId, subjectId: terrainReferenceId, kind: 'procedural', sourceUri: terrainUri,
        license: { name: 'Apache-2.0 project-authored terrain reference', commercialUse: true },
        createdAt: new Date().toISOString(), contentHash: storedTerrain.contentHash, parentIds: [], reviewedAt: new Date().toISOString(),
      });
      const layout = compositionLayout(designSpec, regionIndex);
      const layoutInstruction = layout.length > 0 ? ` Use this structured 1536x1024 layout prior: ${layout.map((item) => `${item.assetClass} at pixel box [${item.screenBox.x},${item.screenBox.y},${item.screenBox.width},${item.screenBox.height}]`).join('; ')}. Keep each object's ground contact at the bottom center of its box.` : '';
      const conceptPrompt = `Edit the supplied render of the canonical terrain for ${region.name} in ${designSpec.title}. Preserve its topography, horizon, 3:2 camera, and major surface boundaries exactly. Add region-appropriate visual objects and materials for biome ${region.biome}, elevation ${region.elevation.min} to ${region.elevation.max} meters. ${region.description}. ${designSpec.style.description}.${layoutInstruction} This is a terrain-conditioned regional composition and structured 2D layout prior, not final geometry. PBR lighting, coherent scale and contact, no text, no gameplay UI.`;
      const conceptInput = { prompt: conceptPrompt, size: '1536x1024' as const, quality: 'high' as const, background: 'opaque' as const, n: 1, inputImages: [{ source: terrainDataUrl, contentType: 'image/png' as const }] };
      const generated = await providers.invoke<typeof conceptInput, GeneratedImageOutput>(image, conceptInput, {}, idempotencyKey(request, `region-concept:${region.id}`, conceptInput), signal);
      const selectedImage = generated.images[0];
      if (!selectedImage) throw new Error(`Image provider returned no regional concept for ${region.name}`);
      const ingested = await ingestImage(selectedImage, store, fetcher, signal);
      const referenceId = `reference-region-${slug(region.id)}-${ingested.reference.contentHash.slice(0, 10)}`;
      const provenanceId = `provenance-${referenceId}`;
      const uri = `references/${ingested.reference.contentHash}.${imageExtension(ingested.contentType)}`;
      references.push({ id: referenceId, kind: 'region-concept', uri, contentHash: ingested.reference.contentHash, contentType: ingested.contentType, regionId: region.id, provenanceId });
      regionalCompositionSources.set(region.id, { source: ingested.providerUri, workerSource: `data:${ingested.contentType};base64,${Buffer.from(await store.get(ingested.reference.contentHash)).toString('base64')}`, provenanceId });
      stagedArtifacts.push({ ...ingested.reference, uri });
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
        const detectedRaw = await providers.invoke<JsonPlanningInput, unknown>(detector, detectionInput, { temperature: 0 }, idempotencyKey(request, `composition-detection:${region.id}`, { conceptHash: ingested.reference.contentHash, requiredClasses }), signal);
        const detected = CompositionDetectionSchema.parse(detectedRaw);
        if (detected.regionId !== region.id) throw new Error(`Composition detector targeted ${detected.regionId} instead of ${region.id}`);
        for (const descriptor of detected.objects) {
          if (descriptor.screenBox.x + descriptor.screenBox.width > 1536 || descriptor.screenBox.y + descriptor.screenBox.height > 1024) throw new Error(`Detected object ${descriptor.id} lies outside the regional composition`);
          compositionOverrides.push({ ...descriptor, regionId: region.id });
        }
      }
    }
    const missing = planAssetGenerationAssignments(designSpec, request.assetLibrary, request.maxAssetGenerations).map((assignment) => {
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
      if (segmentation && composition) {
        const segmentationInput = SegmentationInputSchema.parse({ image: composition.workerSource, box: screenBox, width: 1536, height: 1024 });
        const segmented = await providers.invoke<typeof segmentationInput, GeneratedImageOutput>(segmentation, segmentationInput, {}, idempotencyKey(request, `segment:${regionId}:${requirement.class}:${index}`, { composition: composition.provenanceId, screenBox }), signal);
        const maskImage = segmented.images[0];
        if (!maskImage) throw new Error(`Segmentation worker returned no mask for ${requirement.class}`);
        const ingestedMask = await ingestImage(maskImage, store, fetcher, signal);
        maskSource = ingestedMask.providerUri;
        const maskId = `mask-${prototypeId}-${ingestedMask.reference.contentHash.slice(0, 10)}`;
        const maskProvenanceId = `provenance-${maskId}`;
        const maskUri = `references/${ingestedMask.reference.contentHash}.${imageExtension(ingestedMask.contentType)}`;
        references.push({ id: maskId, kind: 'object-mask', uri: maskUri, contentHash: ingestedMask.reference.contentHash, contentType: ingestedMask.contentType, prototypeId, provenanceId: maskProvenanceId });
        stagedArtifacts.push({ ...ingestedMask.reference, uri: maskUri });
        referenceProvenance.push({ id: maskProvenanceId, subjectId: maskId, kind: 'edited', sourceUri: maskUri, provider: segmentation.provider, modelId: segmentation.modelId, modelRevision: segmentation.revision, license: licenseFor(policies, segmentation), createdAt: new Date().toISOString(), contentHash: ingestedMask.reference.contentHash, parentIds: [composition.provenanceId] });
      }
      const imagePrompt = composition
        ? `From the supplied regional composition for ${assignedRegion.name}, re-render the ${requirement.class} whose structured pixel box is [${screenBox.x},${screenBox.y},${screenBox.width},${screenBox.height}] as an isolated asset reference. Preserve that object's style, materials, proportions, and identity. Show the full object centered at physically plausible scale with PBR-friendly detail, no text, no people, transparent background. Do not include terrain or neighboring objects.`
        : `Isolated ${requirement.class} visual asset for ${designSpec.title}. ${designSpec.style.description}. Full object, centered, physically plausible scale, PBR-friendly materials, no text, no people, transparent background.`;
      const imageInput = { prompt: imagePrompt, size: '1024x1024' as const, quality: 'high' as const, background: 'transparent' as const, n: 1, inputImages: composition ? [{ source: composition.source }, ...(maskSource ? [{ source: maskSource }] : [])] : [] };
      const generated = await providers.invoke<typeof imageInput, GeneratedImageOutput>(image, imageInput, {}, idempotencyKey(request, `isolated-image:${requirement.class}:${index}`, imageInput), signal);
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
      stagedArtifacts.push({ ...ingestedImage.reference, uri: referenceUri });
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
        parentIds: composition ? [composition.provenanceId] : [],
      });
      const viewSources: MultiImageTo3DInput['images'] = [{ source: ingestedImage.providerUri, orientation: 'front' }];
      if (profile === 'studio' && multiview) {
        await providers.requireCapabilities(multiview, { imageInput: true });
        for (const orientation of ['left', 'back', 'right', 'perspective'] as const) {
          const viewPrompt = `Re-render this exact isolated ${requirement.class} from the ${orientation} view. Preserve identity, geometry, proportions, materials, colors, scale, neutral PBR lighting, transparent background, and full-object framing. Do not add or remove parts.`;
          const viewInput = { prompt: viewPrompt, size: '1024x1024' as const, quality: 'high' as const, background: 'transparent' as const, n: 1, inputImages: [{ source: ingestedImage.providerUri }] };
          const viewOutput = await providers.invoke<typeof viewInput, GeneratedImageOutput>(multiview, viewInput, {}, idempotencyKey(request, `multiview:${requirement.class}:${index}:${orientation}`, { sourceHash: ingestedImage.reference.contentHash, viewInput }), signal);
          const generatedView = viewOutput.images[0];
          if (!generatedView) throw new Error(`Multiview generator returned no ${orientation} view for ${requirement.class}`);
          const ingestedView = await ingestImage(generatedView, store, fetcher, signal);
          const viewId = `multiview-${prototypeId}-${orientation}-${ingestedView.reference.contentHash.slice(0, 10)}`;
          const viewProvenanceId = `provenance-${viewId}`;
          const viewUri = `references/${ingestedView.reference.contentHash}.${imageExtension(ingestedView.contentType)}`;
          references.push({ id: viewId, kind: 'object-multiview', uri: viewUri, contentHash: ingestedView.reference.contentHash, contentType: ingestedView.contentType, prototypeId, provenanceId: viewProvenanceId });
          stagedArtifacts.push({ ...ingestedView.reference, uri: viewUri });
          referenceProvenance.push({ id: viewProvenanceId, subjectId: viewId, kind: 'generated', sourceUri: viewUri, provider: multiview.provider, modelId: multiview.modelId, modelRevision: multiview.revision, promptHash: createHash('sha256').update(viewPrompt).digest('hex'), license: licenseFor(policies, multiview), createdAt: new Date().toISOString(), contentHash: ingestedView.reference.contentHash, parentIds: [referenceProvenanceId] });
          viewSources.push({ source: ingestedView.providerUri, orientation });
        }
      }
      const meshInput: TripoImageTo3DInput | MultiImageTo3DInput = profile === 'studio'
        ? { images: viewSources.filter((view) => view.orientation !== 'perspective'), pbr: true, geometryQuality: 'detailed', textureResolution: '4k', faceLimit: 250_000, seed: request.seed + index }
        : { image: ingestedImage.providerUri, texture: true, pbr: true, texture_quality: 'detailed', geometry_quality: 'detailed', texture_alignment: 'original_image', orientation: 'align_image', auto_size: false, quad: false, model_seed: request.seed + index, texture_seed: request.seed + index };
      const prediction = await providers.invoke<typeof meshInput, PredictionOutput>(mesh, meshInput, {}, idempotencyKey(request, `image-to-3d:${requirement.class}:${index}`, { imageHashes: [ingestedImage.reference.contentHash, ...references.filter((item) => item.kind === 'object-multiview' && item.prototypeId === prototypeId).map((item) => item.contentHash)], settings: meshInput }), signal);
      const glb = prediction.outputs.find((output) => output.contentType === 'model/gltf-binary' || output.sourceUrl.toLowerCase().endsWith('.glb'));
      if (!glb) throw new Error(`3D provider returned no GLB for ${requirement.class}`);
      assertValidGlb(glb.bytes);
      const rawStoredGlb = await store.put(glb.bytes, 'model/gltf-binary');
      let blenderResult: BlenderRefinementResult | undefined;
      if (profile === 'studio') {
        let candidate = glb.bytes;
        for (let repairRound = 0; repairRound <= request.refinementPolicy.maxAssetRepairRounds; repairRound += 1) {
          blenderResult = await studioWorkers!.blender!.refine(candidate, {
            operations: ['validate-mesh', 'fix-normals', 'normalize-origin', 'normalize-materials', 'fix-ground-contact', 'export-glb', 'render-turntable', 'render-passes'],
            targetHeightMeters: Math.max(1, boundsRadiusForAssetClass(requirement.class) * 2), renderResolution: 512,
          }, signal);
          candidate = blenderResult.glb;
          const errors = blenderResult.diagnostics.filter((item) => item.severity === 'error');
          if (errors.length === 0) break;
          optimizationWarnings.push(`Blender asset repair round ${repairRound + 1} for ${prototypeId}: ${errors.map((item) => `${item.code}: ${item.message}`).join('; ')}`);
          if (repairRound === request.refinementPolicy.maxAssetRepairRounds) throw new Error(`Blender repair budget exhausted for ${prototypeId}: ${errors.map((item) => item.message).join('; ')}`);
        }
      }
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
      if (rawStoredGlb.contentHash !== storedGlb.contentHash) stagedArtifacts.push({ ...rawStoredGlb, uri: rawAssetUri });
      if (refinedStoredGlb.contentHash !== rawStoredGlb.contentHash && refinedStoredGlb.contentHash !== storedGlb.contentHash) stagedArtifacts.push({ ...refinedStoredGlb, uri: refinedAssetUri });
      stagedArtifacts.push({ ...storedGlb, uri: assetUri });
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
          stagedArtifacts.push({ ...storedRender, uri: renderUri });
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
      stagedArtifacts.push({ ...storedDiagnostic, uri: diagnosticUri });
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
          stagedArtifacts.push({ ...storedLod, uri: lodUri });
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
      modelRevision: '1.1.0-camera-aligned',
      license: { name: 'Diagnostic render inherits parent asset terms', commercialUse },
      createdAt: new Date().toISOString(),
      contentHash: stored.contentHash,
      parentIds,
    });
    preparation.stagedArtifacts.push({ ...stored, uri });
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
  for (let repairRound = 0; repairRound <= originalRequest.refinementPolicy.maxSceneRepairRounds; repairRound += 1) {
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
      jsonSchema: z.toJSONSchema(CloudReviewSchema, { target: 'draft-7' }) as Record<string, unknown>,
      messages: [
        { role: 'system', content: 'Review only visual consistency. Never emit code or scripts. A patch may only adjust existing transforms, visual states, or environment values and must target the supplied world revision.' },
        { role: 'user', content },
      ],
    };
    const rawReview = await providers.invoke<JsonPlanningInput, unknown>(reviewer, input, { temperature: 0 }, idempotencyKey(originalRequest, `visual-review:${repairRound}`, { text, imageHashes: preparation.references.map((reference) => reference.contentHash) }), signal);
    const review = CloudReviewSchema.parse(rawReview);
    if (review.patch && repairRound < originalRequest.refinementPolicy.maxSceneRepairRounds) {
      const patch = validateVisualReviewPatch(review.patch, artifact.bundle.worldId, artifact.bundle.sourceRevision);
      const patched = applyCanonicalPatch(artifact.designSpec, artifact.authoringWorld, artifact.bundle, patch);
      artifact = { designSpec: patched.designSpec, authoringWorld: patched.authoringWorld, bundle: patched.bundle };
      const atlas = await renderPlacementDiagnosticAtlas(artifact.bundle, artifact.authoringWorld, new Set(preparation.generatedPrototypeIds));
      if (!atlas) throw new Error('Scene repair removed every generated placement anchor');
      const stored = await store.put(atlas.bytes, 'image/png');
      const referenceId = `diagnostic-placement-repair-${repairRound + 1}-${stored.contentHash.slice(0, 12)}`;
      const provenanceId = `provenance-${referenceId}`; const uri = `references/${stored.contentHash}.png`;
      const parentIds = artifact.authoringWorld.prototypes.filter((prototype) => preparation.generatedPrototypeIds.includes(prototype.id)).map((prototype) => prototype.provenanceId);
      const provenance: ProvenanceRecord = { id: provenanceId, subjectId: referenceId, kind: 'edited', sourceUri: uri, provider: 'worldengine', modelId: 'cpu-placement-diagnostic', modelRevision: '1.1.0-camera-aligned', license: { name: 'Diagnostic render inherits reviewed generated asset terms', commercialUse: parentIds.every((id) => artifact.authoringWorld.provenance.find((record) => record.id === id)?.license.commercialUse === true) }, createdAt: new Date().toISOString(), contentHash: stored.contentHash, parentIds };
      const reference: ReferenceImage = { id: referenceId, kind: 'placement-diagnostic', uri, contentHash: stored.contentHash, contentType: 'image/png', provenanceId };
      preparation.references.push(reference); preparation.referenceProvenance.push(provenance); preparation.stagedArtifacts.push({ ...stored, uri });
      artifact.authoringWorld = AuthoringWorldSchema.parse({ ...artifact.authoringWorld, referenceImages: [...artifact.authoringWorld.referenceImages, reference], provenance: [...artifact.authoringWorld.provenance, provenance] });
      artifact.bundle = VisualWorldBundleSchema.parse({ ...artifact.bundle, provenance: [...artifact.bundle.provenance, provenance] });
      placementDiagnosticSummary = { compositionIds: atlas.compositionIds, renderedObjects: atlas.renderedObjects, maximumProjectionErrorPixels: atlas.maximumProjectionErrorPixels, maximumTerrainContactErrorMeters: atlas.maximumTerrainContactErrorMeters, repairRound: repairRound + 1 };
      continue;
    }
    if (review.patch) throw new Error('Multimodal visual review requested another scene repair after the bounded repair budget was exhausted');
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
