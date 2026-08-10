import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { Accessor, Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { CompileRequestSchema, WorldDesignSpecSchema, type ProviderTermsProfile } from '@worldengine/schema';
import { createReferenceDesignSpec } from '@worldengine/terrain';
import type { BinaryArtifactReference, BinaryArtifactStore } from './binary-artifact.js';
import type { GeneratedImageOutput, JsonPlanningInput, MultiImageTo3DInput, PredictionOutput, TripoImageTo3DInput } from './http-adapters.js';
import { ProviderPolicyRegistry } from './legal.js';
import { applyTerrainReviewAdjustments, planAssetGenerationAssignments, planStudioHeroAssetGenerationAssignments, prepareCloudCompile } from './cloud-pipeline.js';
import { buildExecutableTerrainPlan } from './local-planner.js';
import { DeterministicWorldCompiler } from './pipeline.js';
import { ProviderExecutionRegistry, type ProviderAdapter, type ProviderInvocation } from './provider.js';
import { BlenderWorkerClient, type ProcessRunner, type SegmentationInput } from './studio-workers.js';

class MemoryBinaryStore implements BinaryArtifactStore {
  readonly values = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array, contentType: string): Promise<BinaryArtifactReference> {
    const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
    const contentHash = [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
    this.values.set(contentHash, bytes);
    return { contentHash, contentType, byteLength: bytes.byteLength };
  }
  async get(contentHash: string): Promise<Uint8Array> { return this.values.get(contentHash)!; }
}

async function denseGlb(segments = 16): Promise<Uint8Array> {
  const document = new Document(); const buffer = document.createBuffer();
  const positions = new Float32Array((segments + 1) * (segments + 1) * 3);
  for (let z = 0; z <= segments; z += 1) for (let x = 0; x <= segments; x += 1) {
    const offset = (z * (segments + 1) + x) * 3; positions[offset] = x; positions[offset + 1] = Math.sin(x * 0.4) * Math.cos(z * 0.35); positions[offset + 2] = z;
  }
  const indices = new Uint32Array(segments * segments * 6); let offset = 0;
  for (let z = 0; z < segments; z += 1) for (let x = 0; x < segments; x += 1) {
    const a = z * (segments + 1) + x; const b = a + 1; const c = a + segments + 1; const d = c + 1; indices.set([a, c, b, b, c, d], offset); offset += 6;
  }
  const position = document.createAccessor().setType(Accessor.Type.VEC3!).setArray(positions).setBuffer(buffer);
  const index = document.createAccessor().setType(Accessor.Type.SCALAR!).setArray(indices).setBuffer(buffer);
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let pixel = 0; pixel < 64; pixel += 1) pixels.set([40 + (pixel % 8) * 20, 95 + Math.floor(pixel / 8) * 10, 55, 255], pixel * 4);
  const png = await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
  const texture = document.createTexture('fixture-albedo').setImage(Uint8Array.from(png)).setMimeType('image/png');
  const material = document.createMaterial('fixture-pbr').setBaseColorTexture(texture);
  const mesh = document.createMesh().addPrimitive(document.createPrimitive().setAttribute('POSITION', position).setIndices(index).setMaterial(material));
  document.createScene().addChild(document.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(document);
}

class PlanningAdapter implements ProviderAdapter<JsonPlanningInput, unknown> {
  readonly provider = 'openrouter'; readonly modelId = 'planner'; readonly revision = 'r1'; calls: string[] = []; readonly inputs: JsonPlanningInput[] = [];
  constructor(private readonly spec: unknown, private readonly review: unknown = { approved: true, issues: [], patch: null }, private readonly detection?: unknown, private readonly compositionReview: unknown = { structuralSimilarityOutsideObjects: 0.96, terrainMaskOverlap: 0.98, cameraLandmarkDriftPixels: 2, diagnosis: 'Terrain and registered camera preserved' }) {}
  async checkCapabilities() { return { structuredOutput: true, imageInput: true }; }
  async estimate() { return 0.01; }
  async invoke(request: ProviderInvocation<JsonPlanningInput, unknown>) {
    this.calls.push(request.input.schemaName); this.inputs.push(request.input);
    return request.input.schemaName === 'WorldDesignSpec' ? this.spec
      : request.input.schemaName === 'RegionalCompositionDetection' ? this.detection
        : request.input.schemaName === 'CompositionPreservationReview' ? this.compositionReview
          : request.input.schemaName === 'TerrainFoundationReview' ? { approved: true, diagnosis: 'Registered terrain passes accepted', adjustments: [] }
          : this.review;
  }
}

async function fixturePng(red = 64, alpha = 255): Promise<Buffer> {
  return sharp({ create: { width: 1536, height: 1024, channels: 4, background: { r: red, g: 96, b: 64, alpha: alpha / 255 } } }).png().toBuffer();
}

class ImageAdapter implements ProviderAdapter<{ prompt: string; inputImages?: Array<{ source: string }> }, GeneratedImageOutput> {
  readonly modelId: string; readonly revision = 'r1'; calls = 0; readonly inputs: Array<{ prompt: string; inputImages?: Array<{ source: string }> }> = [];
  constructor(readonly provider = 'openai') { this.modelId = provider === 'openrouter-image' ? 'openai/gpt-image-2' : 'image'; }
  async checkCapabilities() { return { structuredOutput: false, imageInput: true }; }
  async estimate() { return 0.01; }
  async invoke(request: ProviderInvocation<{ prompt: string; inputImages?: Array<{ source: string }> }, GeneratedImageOutput>) { this.calls += 1; this.inputs.push(request.input); return { images: [{ base64: (await fixturePng(48 + this.calls)).toString('base64') }] }; }
}

class MeshAdapter implements ProviderAdapter<TripoImageTo3DInput, PredictionOutput> {
  readonly provider = 'wavespeed'; readonly modelId = 'mesh'; readonly revision = 'r1'; calls = 0;
  async checkCapabilities() { return { structuredOutput: false, imageInput: true }; }
  async estimate() { return 0.01; }
  async invoke() { this.calls += 1; return { predictionId: 'fixture', outputs: [{ sourceUrl: 'https://provider.test/generated.glb', bytes: await denseGlb(), contentType: 'model/gltf-binary' }] }; }
}

class StudioMeshAdapter implements ProviderAdapter<MultiImageTo3DInput, PredictionOutput> {
  readonly provider = 'wavespeed'; readonly modelId = 'tripo3d/h3.1/multiview-to-3d'; readonly revision = 'r1'; calls = 0; views = 0;
  async checkCapabilities() { return { structuredOutput: false, imageInput: true, multiImageInput: true, pbr3d: true }; }
  async estimate() { return 0.01; }
  async invoke(request: ProviderInvocation<MultiImageTo3DInput, PredictionOutput>) { this.calls += 1; this.views = request.input.images.length; return { predictionId: 'studio-fixture', outputs: [{ sourceUrl: 'https://provider.test/studio.glb', bytes: await denseGlb(), contentType: 'model/gltf-binary' }] }; }
}

class SegmentationAdapter implements ProviderAdapter<SegmentationInput, GeneratedImageOutput> {
  readonly provider = 'sam2-local'; readonly modelId = 'sam2'; readonly revision = 'r1'; calls = 0;
  async checkCapabilities() { return { structuredOutput: false, imageInput: true, segmentation: true }; }
  async estimate() { return 0; }
  async invoke() { this.calls += 1; return { images: [{ base64: (await fixturePng(255)).toString('base64') }] }; }
}

function profile(provider: string, modelId: string): ProviderTermsProfile {
  return {
    provider, modelId, revision: 'r1', termsUrl: `https://${provider}.test/terms`, termsFingerprint: Buffer.from(`${provider}-terms`).toString('hex').padEnd(64, '0').slice(0, 64),
    reviewedAt: '2026-08-01T00:00:00.000Z', acceptedAt: '2026-08-02T00:00:00.000Z', permittedTerritories: ['EU'], commercialUse: true,
    notices: [], outputConditions: 'fixture outputs approved', retention: 'immediate ingest', trainingUse: 'disabled', contentRestrictions: [], cost: { unit: 'request', usd: 0.01 }, enabled: true,
  };
}

describe('cloud compile orchestration', () => {
  it('applies only bounded typed terrain-review adjustments', () => {
    const base = createReferenceDesignSpec(21); const spec = WorldDesignSpecSchema.parse({ ...base, terrainPlan: buildExecutableTerrainPlan(base.regions, base.features, base.assetRequirements.map((requirement) => requirement.class)) });
    const region = spec.terrainPlan.regions[0]!; const material = spec.terrainPlan.materialSets[0]!; const scatter = spec.terrainPlan.scatterRecipes[0]!;
    const adjusted = applyTerrainReviewAdjustments(spec, [
      { type: 'landform-strength', targetId: `${region.regionId}:0`, value: 99 }, { type: 'boundary-blend', targetId: 'terrain', value: 260 },
      { type: 'material-tiling', targetId: material.id, value: 6 }, { type: 'scatter-density', targetId: scatter.id, value: 1_200 },
      { type: 'light-time', targetId: 'environment', value: 27 }, { type: 'fog-density', targetId: 'environment', value: 0.002 },
    ]);
    expect(adjusted.terrainPlan.regions[0]!.operators[0]!.strength).toBe(2);
    expect(adjusted.terrainPlan.maskBlendMeters).toBe(260);
    expect(adjusted.terrainPlan.materialSets.find((entry) => entry.id === material.id)).toMatchObject({ metersPerTile: 6 });
    expect(adjusted.terrainPlan.scatterRecipes.find((entry) => entry.id === scatter.id)).toMatchObject({ densityPerSquareKm: 1_200 });
    expect(adjusted.environment).toMatchObject({ timeOfDay: 3, fogDensity: 0.002 });
  });

  it('keeps generated assets assigned to the exact canonical region concept camera', () => {
    const base = createReferenceDesignSpec(22);
    const spec = WorldDesignSpecSchema.parse({
      ...base,
      assetRequirements: [
        { class: 'first-object', count: 1, sourcePreference: ['library', 'cache', 'generate'], tags: [] },
        { class: 'second-object', count: 1, sourcePreference: ['library', 'cache', 'generate'], tags: [] },
      ],
    });
    expect(planAssetGenerationAssignments(spec, [], 2).map((assignment) => ({ class: assignment.requirement.class, regionId: assignment.regionId, prototypeIndex: assignment.prototypeIndex, screenBox: assignment.screenBox }))).toEqual([
      { class: 'first-object', regionId: spec.regions[0]!.id, prototypeIndex: 0, screenBox: { x: 520, y: 330, width: 96, height: 150 } },
      { class: 'second-object', regionId: spec.regions[1]!.id, prototypeIndex: 1, screenBox: { x: 648, y: 330, width: 96, height: 150 } },
    ]);
    expect(planAssetGenerationAssignments(spec, [{ class: 'first-object' }], 2).map((assignment) => assignment.regionId)).toEqual([spec.regions[1]!.id]);
    expect(planStudioHeroAssetGenerationAssignments(spec, [], 2, [spec.regions[3]!.id]).map((assignment) => assignment.regionId)).toEqual([spec.regions[3]!.id, spec.regions[3]!.id]);
  });

  it('plans, ingests an isolated image and GLB, and runs mesh-backed multimodal review', async () => {
    const prompt = 'One quiet grove with a single ancient oak';
    const spec = WorldDesignSpecSchema.parse({ ...createReferenceDesignSpec(23), prompt, title: 'Reviewed Grove', assetRequirements: [{ class: 'ancient-oak', count: 1, sourcePreference: ['library', 'cache', 'generate'], tags: ['forest'] }] });
    const planning = new PlanningAdapter({ ...spec, id: 'provider-invented-id', seed: 999, prompt: 'provider changed prompt', bounds: { min: [2_000, 2_000], max: [-2_000, -2_000] }, chunkSize: 512, terrainSamples: 129 });
    const image = new ImageAdapter();
    const mesh = new MeshAdapter();
    const providers = new ProviderExecutionRegistry();
    providers.register(planning); providers.register(image); providers.register(mesh);
    const profiles = [profile('openrouter', 'planner'), profile('openai', 'image'), profile('wavespeed', 'mesh')];
    const store = new MemoryBinaryStore();
    const compiler = new DeterministicWorldCompiler({ policies: new ProviderPolicyRegistry(profiles), providers, binaryArtifacts: store });
    const request = CompileRequestSchema.parse({
      prompt, seed: 23, maxCostUsd: 0.05, maxAssetGenerations: 1, maxReferenceImages: 1, territory: 'NL', commercialUse: true, dryRun: false,
      providerModels: profiles.map((item) => ({ provider: item.provider, modelId: item.modelId, revision: item.revision, termsFingerprint: item.termsFingerprint })),
    });
    const events = []; for await (const event of compiler.compile(request, 'cloud-fixture')) events.push(event);
    expect(events.at(-1)?.type).toBe('completed');
    const accountedCost = [...events].reverse().find((event) => event.type === 'cost')!;
    expect(accountedCost).toMatchObject({ phase: 'cost-accounting', data: { reservedCostUsd: 0.05, actualCostUsd: 0.05, accountingBasis: 'reviewed-provider-unit-price' } });
    expect(accountedCost.data['providerAttempts']).toEqual(expect.arrayContaining([
      expect.objectContaining({ compileId: 'cloud-fixture', phase: 'terrain', provider: 'openrouter', modelId: 'planner', revision: 'r1', actualCostUsd: 0.01 }),
      expect.objectContaining({ compileId: 'cloud-fixture', phase: 'composition', provider: 'openai', modelId: 'image', revision: 'r1', actualCostUsd: 0.01 }),
      expect.objectContaining({ compileId: 'cloud-fixture', phase: 'reconstruction', provider: 'wavespeed', modelId: 'mesh', revision: 'r1', actualCostUsd: 0.01 }),
      expect.objectContaining({ compileId: 'cloud-fixture', phase: 'review', provider: 'openrouter', modelId: 'planner', revision: 'r1', actualCostUsd: 0.01 }),
    ]));
    const artifact = events.find((event) => event.type === 'artifact')!;
    expect(artifact.data['designSpec']).toMatchObject({ id: 'design-23-the-aster-vale', seed: 23, prompt, bounds: spec.bounds, chunkSize: 256, terrainSamples: 257 });
    const bundle = artifact.data['bundle'] as { optimization: { meshLods: boolean; textureFormat: string }; prototypes: Array<{ id: string; assetUri: string; contentHash: string; textureFormat: string; lods: Array<{ assetUri: string; contentHash: string; provenanceId: string }> }>; provenance: Array<{ id: string; subjectId: string; kind: string; contentHash: string; parentIds: string[]; reviewedAt?: string }> };
    const authoring = artifact.data['authoringWorld'] as {
      referenceImages: Array<{ id: string; kind: string; uri: string; prototypeId: string; provenanceId: string }>;
      provenance: Array<{ id: string; subjectId: string; kind: string; parentIds: string[]; reviewedAt?: string }>;
    };
    const binaryArtifacts = artifact.data['binaryArtifacts'] as Array<{ uri: string; contentHash: string }>;
    expect(bundle.prototypes).toHaveLength(1);
    expect(bundle.prototypes[0]?.assetUri).toMatch(/^assets\/[a-f\d]{64}\.glb$/);
    expect(bundle.prototypes[0]?.lods).toHaveLength(2);
    expect(bundle.prototypes[0]?.textureFormat).toBe('ktx2');
    expect(bundle.prototypes[0]?.lods.every((lod) => bundle.provenance.some((record) => record.id === lod.provenanceId && record.contentHash === lod.contentHash && record.reviewedAt))).toBe(true);
    expect(bundle.optimization.meshLods).toBe(true);
    expect(bundle.optimization.textureFormat).toBe('ktx2');
    expect(bundle.provenance.some((record) => record.kind === 'generated' && record.reviewedAt)).toBe(true);
    expect(authoring.referenceImages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'terrain-reference', uri: expect.stringMatching(/^references\//) }),
      expect.objectContaining({ kind: 'region-concept', uri: expect.stringMatching(/^references\//) }),
      expect.objectContaining({ kind: 'object-isolated', uri: expect.stringMatching(/^references\//), prototypeId: expect.any(String) }),
      expect.objectContaining({ kind: 'object-diagnostic', uri: expect.stringMatching(/^references\//), prototypeId: expect.any(String) }),
      expect.objectContaining({ kind: 'placement-diagnostic', uri: expect.stringMatching(/^references\//) }),
    ]));
    expect(authoring.referenceImages).toHaveLength(5);
    const terrain = authoring.referenceImages.find((reference) => reference.kind === 'terrain-reference')!;
    const concept = authoring.referenceImages.find((reference) => reference.kind === 'region-concept')!;
    const isolated = authoring.referenceImages.find((reference) => reference.kind === 'object-isolated')!;
    const diagnostic = authoring.referenceImages.find((reference) => reference.kind === 'object-diagnostic')!;
    const placementDiagnostic = authoring.referenceImages.find((reference) => reference.kind === 'placement-diagnostic')!;
    const provenance = new Map(authoring.provenance.map((record) => [record.id, record]));
    expect(provenance.get(concept.provenanceId)?.parentIds).toContain(terrain.provenanceId);
    expect(provenance.get(isolated.provenanceId)?.parentIds).toContain(concept.provenanceId);
    const optimizedAsset = bundle.provenance.find((record) => record.subjectId === bundle.prototypes[0]!.id)!;
    const providerSource = bundle.provenance.find((record) => optimizedAsset.parentIds.includes(record.id))!;
    expect(optimizedAsset.kind).toBe('edited');
    expect(providerSource.kind).toBe('generated');
    expect(providerSource.parentIds).toContain(isolated.provenanceId);
    expect(provenance.get(diagnostic.provenanceId)).toMatchObject({ kind: 'edited', parentIds: [optimizedAsset.id], reviewedAt: expect.any(String) });
    expect(provenance.get(placementDiagnostic.provenanceId)).toMatchObject({ kind: 'edited', parentIds: expect.arrayContaining([optimizedAsset.id, concept.provenanceId]), reviewedAt: expect.any(String) });
    expect(bundle.provenance.filter((record) => record.kind === 'generated').every((record) => typeof record.reviewedAt === 'string')).toBe(true);
    expect(bundle.provenance.filter((record) => record.kind === 'edited')).toHaveLength(5);
    expect(bundle.provenance.filter((record) => record.kind === 'edited').every((record) => typeof record.reviewedAt === 'string')).toBe(true);
    expect(binaryArtifacts.map((item) => item.uri).sort()).toEqual(expect.arrayContaining([expect.stringMatching(/^assets\//), expect.stringMatching(/^references\//)]));
    expect(store.values.size).toBe(9);
    expect(planning.calls).toEqual(['WorldDesignSpec', 'VisualReview']);
    expect(planning.inputs.find((input) => input.schemaName === 'VisualReview')?.jsonSchema).toMatchObject({ properties: { patch: { type: 'null' } } });
    const reviewContent = planning.inputs[1]?.messages[1]?.content as Array<{ type: string; image_url?: { url?: string } }>;
    expect(reviewContent.filter((item) => item.type === 'image_url')).toHaveLength(5);
    expect(reviewContent.at(-1)?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    expect(image.calls).toBe(2);
    expect(image.inputs[0]?.inputImages?.[0]?.source).toMatch(/^data:image\/png;base64,/);
    expect(image.inputs[0]?.prompt).toContain('Preserve its topography');
    expect(image.inputs[0]?.prompt).toContain('structured 1536x1024 layout prior');
    expect(image.inputs[0]?.prompt).toContain('ancient-oak at pixel box');
    expect(image.inputs[1]?.inputImages?.[0]?.source).toMatch(/^data:image\/png;base64,/);
    expect(image.inputs[1]?.prompt).toContain('supplied regional composition');
    expect(mesh.calls).toBe(1);
  }, 20_000);

  it('runs the complete Studio detection, mask, multiview, Blender, and co-deformation chain', async () => {
    const prompt = 'A studio-quality ancient oak clearing';
    const base = createReferenceDesignSpec(31);
    const hero = base.regions[0]!;
    const spec = WorldDesignSpecSchema.parse({ ...base, prompt, title: 'Studio Clearing', assetRequirements: [{ class: 'ancient-oak', count: 1, sourcePreference: ['generate'], tags: ['forest'] }] });
    const detection = { regionId: hero.id, objects: [{ id: 'detected-oak', assetClass: 'ancient-oak', description: 'Visible old oak from the actual composition', screenBox: { x: 600, y: 300, width: 220, height: 380 }, desiredHeightMeters: 12, tags: ['forest'] }] };
    const planning = new PlanningAdapter(spec, { approved: true, issues: [], patch: null }, detection);
    const image = new ImageAdapter('openrouter-image'); const segmentation = new SegmentationAdapter(); const mesh = new StudioMeshAdapter();
    const providers = new ProviderExecutionRegistry([planning, image, segmentation, mesh]);
    const profiles = [profile('openrouter', 'planner'), profile('openrouter-image', 'openai/gpt-image-2'), profile('sam2-local', 'sam2'), profile('wavespeed', 'tripo3d/h3.1/multiview-to-3d')];
    const png = new Uint8Array(await fixturePng());
    let assetRefinementCalls = 0;
    const runner: ProcessRunner = async (_command, args) => {
      const job = JSON.parse(await readFile(args[args.indexOf('--job') + 1]!, 'utf8')) as { operation?: string; inputPath: string; outputPath: string; resultPath: string; materials?: Array<{ baseColorPath: string; normalPath: string; roughnessPath: string; macroVariationPath: string }>; assets?: Array<{ id: string; transform: unknown; placementTarget: { cameraId: string; maskPath: string } }>; cameras?: Array<{ id: string }>; environment?: { timeOfDay: number; fogDensity: number } };
      if (job.operation === 'refine-region') {
        expect(job.materials?.length).toBeGreaterThan(0);
        expect((await readFile(job.materials![0]!.baseColorPath)).byteLength).toBeGreaterThan(8);
        expect(job.environment).toEqual({ timeOfDay: spec.environment.timeOfDay, fogDensity: spec.environment.fogDensity });
        for (const asset of job.assets ?? []) {
          expect(job.cameras?.some((camera) => camera.id === asset.placementTarget.cameraId)).toBe(true);
          expect((await readFile(asset.placementTarget.maskPath)).byteLength).toBeGreaterThan(8);
        }
        const renderPath = `${job.resultPath}.png`; await writeFile(renderPath, png);
        await writeFile(job.resultPath, JSON.stringify({
          workerVersion: 'blender-fixture-1',
          transforms: (job.assets ?? []).map((asset) => ({ id: asset.id, transform: asset.transform, contactErrorMeters: 0.01, silhouetteIou: 0.91, centerErrorPixels: 2 })),
          terrainEdits: [{ footprint: [[-10, -10], [10, -10], [10, 10], [-10, 10]], targetHeight: 1, supportMarginMeters: 2, falloffEndMeters: 5 }],
          renders: (job.cameras ?? []).flatMap((camera) => ['blender-rgb', 'blender-depth', 'blender-normal', 'blender-semantic', 'blender-instance'].map((kind) => ({ kind, cameraId: camera.id, path: renderPath }))),
          diagnostics: [{ severity: 'info', code: 'REGION_CONTACT', message: 'contact fixed' }],
        }));
        return { code: 0, stdout: '', stderr: '' };
      }
      await writeFile(job.outputPath, await readFile(job.inputPath));
      const renderPath = `${job.outputPath}.png`; await writeFile(renderPath, png);
      assetRefinementCalls += 1;
      await writeFile(job.resultPath, JSON.stringify({ workerVersion: 'blender-fixture-1', renders: [{ kind: 'blender-rgb', path: renderPath }], diagnostics: assetRefinementCalls === 1 ? [{ severity: 'error', code: 'NON_MANIFOLD', message: 'regenerate identity-consistent source views' }] : [{ severity: 'info', code: 'CONTACT', message: 'contact fixed' }] }));
      return { code: 0, stdout: '', stderr: '' };
    };
    const blender = new BlenderWorkerClient('blender', '/worker.py', runner);
    const compiler = new DeterministicWorldCompiler({ policies: new ProviderPolicyRegistry(profiles), providers, binaryArtifacts: new MemoryBinaryStore(), studioWorkers: { blender } });
    const byProvider = new Map(profiles.map((item) => [item.provider, item]));
    const selection = (provider: string, role: string) => { const item = byProvider.get(provider)!; return { provider, modelId: item.modelId, revision: item.revision, termsFingerprint: item.termsFingerprint, role }; };
    const request = CompileRequestSchema.parse({
      prompt, seed: 31, qualityProfile: 'studio', heroRegionIds: [hero.id], maxCostUsd: 1, maxAssetGenerations: 1, maxReferenceImages: 1, territory: 'NL', commercialUse: true, dryRun: false,
      refinementPolicy: { maxTerrainRounds: 3, maxCompositionAttempts: 3, maxAssetAttempts: 2, maxSceneRounds: 3, maxAssetRepairRounds: 2, maxSceneRepairRounds: 1, terrainCoDeformation: true },
      providerModels: [selection('openrouter', 'planner'), selection('openrouter', 'reviewer'), selection('openrouter', 'object-detection'), selection('openrouter-image', 'composition-image'), selection('openrouter-image', 'multiview-image'), selection('sam2-local', 'segmentation'), selection('wavespeed', 'image-to-3d')],
    });
    const events = []; for await (const event of compiler.compile(request, 'studio-cloud-fixture')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
    const artifact = events.find((event) => event.type === 'artifact')!;
    const stagedTerrain = artifact.data['binaryArtifacts'] as Array<{ uri: string; artifactKind?: string }>;
    const studioBundle = artifact.data['bundle'] as { prototypes: Array<{ id: string; assetUri: string }>; authoredInstances: Array<{ prototypeId: string; visualState: Record<string, unknown> }> };
    expect(stagedTerrain).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: expect.stringMatching(/^terrain\/[a-f\d]{64}\.f32$/), artifactKind: 'terrain-heightfield' }),
      expect.objectContaining({ uri: expect.stringMatching(/^terrain\/[a-f\d]{64}\.bin$/), artifactKind: 'terrain-splat' }),
      expect.objectContaining({ uri: expect.stringMatching(/^terrain\/[a-f\d]{64}\.ktx2$/), contentType: 'image/ktx2', artifactKind: 'terrain-normal' }),
      expect.objectContaining({ uri: expect.stringMatching(/^terrain\/[a-f\d]{64}\.ktx2$/), contentType: 'image/ktx2', artifactKind: 'terrain-roughness' }),
    ]));
    expect(stagedTerrain.filter((item) => item.artifactKind === 'terrain-rgb')).toHaveLength(3);
    expect(stagedTerrain.filter((item) => item.artifactKind === 'terrain-depth')).toHaveLength(3);
    expect(stagedTerrain.filter((item) => item.artifactKind === 'terrain-normal' && item.uri.startsWith('references/'))).toHaveLength(3);
    expect(stagedTerrain.filter((item) => item.artifactKind === 'terrain-semantic')).toHaveLength(3);
    expect(stagedTerrain.filter((item) => item.artifactKind === 'terrain-instance')).toHaveLength(3);
    const realPrototypeIds = new Set(studioBundle.prototypes.filter((prototype) => !prototype.assetUri.startsWith('primitive://')).map((prototype) => prototype.id));
    expect(studioBundle.authoredInstances.filter((instance) => instance.visualState['enrichedHero'] === true && realPrototypeIds.has(instance.prototypeId)).length).toBeGreaterThanOrEqual(500);
    expect(studioBundle.authoredInstances.filter((instance) => instance.visualState['enrichedHero'] === true && !realPrototypeIds.has(instance.prototypeId))).toHaveLength(0);
    const authoring = artifact.data['authoringWorld'] as { referenceImages: Array<{ kind: string }>; regionalCompositions: Array<{ objects: Array<{ screenBox: unknown }> }>; terrain: { footprintEdits: Array<{ mode: string }> }; entities: Array<{ visualState: Record<string, unknown> }> };
    expect(authoring.referenceImages.filter((item) => item.kind === 'object-multiview')).toHaveLength(7);
    expect(authoring.referenceImages.some((item) => item.kind === 'object-mask')).toBe(true);
    expect(authoring.referenceImages.some((item) => item.kind === 'blender-rgb')).toBe(true);
    expect(authoring.regionalCompositions[0]?.objects[0]?.screenBox).toEqual(detection.objects[0]!.screenBox);
    expect(authoring.terrain.footprintEdits.some((edit) => edit.mode === 'flatten')).toBe(true);
    expect(authoring.entities.some((entity) => entity.visualState['compositionDetected'] === true && entity.visualState['coDeformed'] === true)).toBe(true);
    expect(mesh).toMatchObject({ calls: 2, views: 4 });
    expect(segmentation.calls).toBe(1);
    expect(image.calls).toBe(8);
    expect(Buffer.from(image.inputs[0]!.inputImages![0]!.source.split(',')[1]!, 'base64')).toEqual(Buffer.from(png));
    expect(planning.calls).toEqual(['WorldDesignSpec', 'TerrainFoundationReview', 'CompositionPreservationReview', 'RegionalCompositionDetection', 'VisualReview']);
  }, 20_000);

  it('preserves every rejected Studio composition candidate in the partial preparation checkpoint', async () => {
    const prompt = 'A rejected Studio composition must remain inspectable';
    const base = createReferenceDesignSpec(44); const hero = base.regions[0]!;
    const spec = WorldDesignSpecSchema.parse({ ...base, prompt, assetRequirements: [{ class: 'stone-arch', count: 1, sourcePreference: ['generate'], tags: ['structure'] }] });
    const failedPreservation = { structuralSimilarityOutsideObjects: 0.71, terrainMaskOverlap: 0.82, cameraLandmarkDriftPixels: 19, diagnosis: 'Camera and terrain drift' };
    const planning = new PlanningAdapter(spec, { approved: true, issues: [], patch: null }, undefined, failedPreservation);
    const image = new ImageAdapter('openrouter-image'); const segmentation = new SegmentationAdapter(); const mesh = new StudioMeshAdapter();
    const providers = new ProviderExecutionRegistry([planning, image, segmentation, mesh]);
    const profiles = [profile('openrouter', 'planner'), profile('openrouter-image', 'openai/gpt-image-2'), profile('sam2-local', 'sam2'), profile('wavespeed', 'tripo3d/h3.1/multiview-to-3d')];
    const byProvider = new Map(profiles.map((item) => [item.provider, item]));
    const selected = (provider: string, role: string) => { const item = byProvider.get(provider)!; return { provider, modelId: item.modelId, revision: item.revision, termsFingerprint: item.termsFingerprint, role }; };
    const request = CompileRequestSchema.parse({
      prompt, seed: 44, qualityProfile: 'studio', heroRegionIds: [hero.id], maxCostUsd: 1, maxAssetGenerations: 1, maxReferenceImages: 1, territory: 'NL', commercialUse: true, dryRun: false,
      refinementPolicy: { maxTerrainRounds: 3, maxCompositionAttempts: 3, maxAssetAttempts: 2, maxSceneRounds: 3, maxAssetRepairRounds: 2, maxSceneRepairRounds: 1, terrainCoDeformation: true },
      providerModels: [selected('openrouter', 'planner'), selected('openrouter', 'reviewer'), selected('openrouter', 'object-detection'), selected('openrouter-image', 'composition-image'), selected('openrouter-image', 'multiview-image'), selected('sam2-local', 'segmentation'), selected('wavespeed', 'image-to-3d')],
    });
    const terrainPng = new Uint8Array(await fixturePng(72));
    const blender = new BlenderWorkerClient('blender', '/worker.py', async (_command, args) => {
      const job = JSON.parse(await readFile(args[args.indexOf('--job') + 1]!, 'utf8')) as { resultPath: string; materials?: Array<{ normalPath: string }>; assets?: unknown[]; cameras?: Array<{ id: string }>; environment?: { timeOfDay: number; fogDensity: number } };
      expect(job.assets).toHaveLength(0);
      expect(job.materials?.length).toBeGreaterThan(0);
      expect([...(await readFile(job.materials![0]!.normalPath)).subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(job.environment).toEqual({ timeOfDay: spec.environment.timeOfDay, fogDensity: spec.environment.fogDensity });
      const renderPath = `${job.resultPath}.png`; await writeFile(renderPath, terrainPng);
      await writeFile(job.resultPath, JSON.stringify({
        workerVersion: 'blender-fixture-1', transforms: [], terrainEdits: [],
        renders: (job.cameras ?? []).flatMap((camera) => ['blender-rgb', 'blender-depth', 'blender-normal', 'blender-semantic', 'blender-instance'].map((kind) => ({ kind, cameraId: camera.id, path: renderPath }))),
        diagnostics: [],
      }));
      return { code: 0, stdout: '', stderr: '' };
    });
    const preparation = await prepareCloudCompile(request, spec, providers, new ProviderPolicyRegistry(profiles), new MemoryBinaryStore(), new AbortController().signal, fetch, { blender });
    expect(preparation.failure).toContain('Regional composition attempts exhausted');
    expect(preparation.references.filter((reference) => reference.kind === 'region-concept')).toHaveLength(0);
    expect(preparation.stagedArtifacts.filter((artifact) => artifact.artifactKind === 'regional-composition')).toHaveLength(3);
    expect(preparation.stagedArtifacts.filter((artifact) => artifact.artifactKind === 'regional-composition').every((artifact) => artifact.phase === 'composition')).toBe(true);
    expect(preparation.stagedArtifacts.some((artifact) => artifact.artifactKind === 'terrain-rgb')).toBe(true);
    expect(image.calls).toBe(3);
  }, 20_000);

  it('does not publish or review-stamp assets rejected by multimodal review', async () => {
    const prompt = 'One rejected generated oak';
    const spec = WorldDesignSpecSchema.parse({ ...createReferenceDesignSpec(25), prompt, assetRequirements: [{ class: 'oak', count: 1, sourcePreference: ['generate'], tags: [] }] });
    const planning = new PlanningAdapter(spec, { approved: false, issues: [{ severity: 'error', message: 'Object identity does not match the composition' }], patch: null });
    const image = new ImageAdapter();
    const mesh = new MeshAdapter();
    const providers = new ProviderExecutionRegistry([planning, image, mesh]);
    const profiles = [profile('openrouter', 'planner'), profile('openai', 'image'), profile('wavespeed', 'mesh')];
    const compiler = new DeterministicWorldCompiler({ policies: new ProviderPolicyRegistry(profiles), providers, binaryArtifacts: new MemoryBinaryStore() });
    const request = CompileRequestSchema.parse({
      prompt, seed: 25, maxCostUsd: 0.05, maxAssetGenerations: 1, maxReferenceImages: 1, territory: 'NL', commercialUse: true, dryRun: false,
      providerModels: profiles.map((item) => ({ provider: item.provider, modelId: item.modelId, revision: item.revision, termsFingerprint: item.termsFingerprint })),
    });
    const events = []; for await (const event of compiler.compile(request, 'rejected-cloud-fixture')) events.push(event);
    expect(events.some((event) => event.type === 'artifact')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'failed', message: expect.stringContaining('Object identity does not match') });
  });

  it('fails closed when a selected generation role has no configured adapter', async () => {
    const prompt = 'No fallback world';
    const spec = WorldDesignSpecSchema.parse({ ...createReferenceDesignSpec(24), prompt, assetRequirements: [{ class: 'oak', count: 1, sourcePreference: ['generate'], tags: [] }] });
    const providers = new ProviderExecutionRegistry();
    providers.register(new PlanningAdapter(spec));
    const profiles = [profile('openrouter', 'planner'), profile('openai', 'image'), profile('wavespeed', 'mesh')];
    const compiler = new DeterministicWorldCompiler({ policies: new ProviderPolicyRegistry(profiles), providers, binaryArtifacts: new MemoryBinaryStore() });
    const request = CompileRequestSchema.parse({ prompt, seed: 24, maxCostUsd: 0.04, maxAssetGenerations: 1, territory: 'NL', commercialUse: true, dryRun: false, providerModels: profiles.map((item) => ({ provider: item.provider, modelId: item.modelId, revision: item.revision, termsFingerprint: item.termsFingerprint })) });
    const events = []; for await (const event of compiler.compile(request, 'missing-adapter')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'failed', message: expect.stringContaining('No execution adapter') });
  });
});
