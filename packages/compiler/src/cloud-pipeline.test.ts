import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { Accessor, Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { CompileRequestSchema, WorldDesignSpecSchema, type ProviderTermsProfile } from '@worldengine/schema';
import { createReferenceDesignSpec } from '@worldengine/terrain';
import type { BinaryArtifactReference, BinaryArtifactStore } from './binary-artifact.js';
import type { GeneratedImageOutput, JsonPlanningInput, MultiImageTo3DInput, PredictionOutput, TripoImageTo3DInput } from './http-adapters.js';
import { ProviderPolicyRegistry } from './legal.js';
import { planAssetGenerationAssignments } from './cloud-pipeline.js';
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
  constructor(private readonly spec: unknown, private readonly review: unknown = { approved: true, issues: [], patch: null }, private readonly detection?: unknown) {}
  async checkCapabilities() { return { structuredOutput: true, imageInput: true }; }
  async estimate() { return 0.01; }
  async invoke(request: ProviderInvocation<JsonPlanningInput, unknown>) {
    this.calls.push(request.input.schemaName); this.inputs.push(request.input);
    return request.input.schemaName === 'WorldDesignSpec' ? this.spec : request.input.schemaName === 'RegionalCompositionDetection' ? this.detection : this.review;
  }
}

class ImageAdapter implements ProviderAdapter<{ prompt: string; inputImages?: Array<{ source: string }> }, GeneratedImageOutput> {
  readonly provider = 'openai'; readonly modelId = 'image'; readonly revision = 'r1'; calls = 0; readonly inputs: Array<{ prompt: string; inputImages?: Array<{ source: string }> }> = [];
  async checkCapabilities() { return { structuredOutput: false, imageInput: true }; }
  async estimate() { return 0.01; }
  async invoke(request: ProviderInvocation<{ prompt: string; inputImages?: Array<{ source: string }> }, GeneratedImageOutput>) { this.calls += 1; this.inputs.push(request.input); return { images: [{ base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, this.calls]).toString('base64') }] }; }
}

class MeshAdapter implements ProviderAdapter<TripoImageTo3DInput, PredictionOutput> {
  readonly provider = 'wavespeed'; readonly modelId = 'mesh'; readonly revision = 'r1'; calls = 0;
  async checkCapabilities() { return { structuredOutput: false, imageInput: true }; }
  async estimate() { return 0.01; }
  async invoke() { this.calls += 1; return { predictionId: 'fixture', outputs: [{ sourceUrl: 'https://provider.test/generated.glb', bytes: await denseGlb(), contentType: 'model/gltf-binary' }] }; }
}

class StudioMeshAdapter implements ProviderAdapter<MultiImageTo3DInput, PredictionOutput> {
  readonly provider = 'tripo'; readonly modelId = 'multiview'; readonly revision = 'r1'; calls = 0; views = 0;
  async checkCapabilities() { return { structuredOutput: false, imageInput: true, multiImageInput: true, pbr3d: true }; }
  async estimate() { return 0.01; }
  async invoke(request: ProviderInvocation<MultiImageTo3DInput, PredictionOutput>) { this.calls += 1; this.views = request.input.images.length; return { predictionId: 'studio-fixture', outputs: [{ sourceUrl: 'https://provider.test/studio.glb', bytes: await denseGlb(), contentType: 'model/gltf-binary' }] }; }
}

class SegmentationAdapter implements ProviderAdapter<SegmentationInput, GeneratedImageOutput> {
  readonly provider = 'sam2-local'; readonly modelId = 'sam2'; readonly revision = 'r1'; calls = 0;
  async checkCapabilities() { return { structuredOutput: false, imageInput: true, segmentation: true }; }
  async estimate() { return 0; }
  async invoke() { this.calls += 1; return { images: [{ base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42]).toString('base64') }] }; }
}

function profile(provider: string, modelId: string): ProviderTermsProfile {
  return {
    provider, modelId, revision: 'r1', termsUrl: `https://${provider}.test/terms`, termsFingerprint: Buffer.from(`${provider}-terms`).toString('hex').padEnd(64, '0').slice(0, 64),
    reviewedAt: '2026-08-01T00:00:00.000Z', acceptedAt: '2026-08-02T00:00:00.000Z', permittedTerritories: ['EU'], commercialUse: true,
    notices: [], outputConditions: 'fixture outputs approved', retention: 'immediate ingest', trainingUse: 'disabled', contentRestrictions: [], cost: { unit: 'request', usd: 0.01 }, enabled: true,
  };
}

describe('cloud compile orchestration', () => {
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
  });

  it('plans, ingests an isolated image and GLB, and runs mesh-backed multimodal review', async () => {
    const prompt = 'One quiet grove with a single ancient oak';
    const spec = WorldDesignSpecSchema.parse({ ...createReferenceDesignSpec(23), prompt, title: 'Reviewed Grove', assetRequirements: [{ class: 'ancient-oak', count: 1, sourcePreference: ['library', 'cache', 'generate'], tags: ['forest'] }] });
    const planning = new PlanningAdapter(spec);
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
    const artifact = events.find((event) => event.type === 'artifact')!;
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
    const image = new ImageAdapter(); const segmentation = new SegmentationAdapter(); const mesh = new StudioMeshAdapter();
    const providers = new ProviderExecutionRegistry([planning, image, segmentation, mesh]);
    const profiles = [profile('openrouter', 'planner'), profile('openai', 'image'), profile('sam2-local', 'sam2'), profile('tripo', 'multiview')];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const runner: ProcessRunner = async (_command, args) => {
      const job = JSON.parse(await readFile(args[args.indexOf('--job') + 1]!, 'utf8')) as { inputPath: string; outputPath: string; resultPath: string };
      await writeFile(job.outputPath, await readFile(job.inputPath));
      const renderPath = `${job.outputPath}.png`; await writeFile(renderPath, png);
      await writeFile(job.resultPath, JSON.stringify({ workerVersion: 'blender-fixture-1', renders: [{ kind: 'blender-rgb', path: renderPath }], diagnostics: [{ severity: 'info', code: 'CONTACT', message: 'contact fixed' }] }));
      return { code: 0, stdout: '', stderr: '' };
    };
    const blender = new BlenderWorkerClient('blender', '/worker.py', runner);
    const compiler = new DeterministicWorldCompiler({ policies: new ProviderPolicyRegistry(profiles), providers, binaryArtifacts: new MemoryBinaryStore(), studioWorkers: { blender } });
    const byProvider = new Map(profiles.map((item) => [item.provider, item]));
    const selection = (provider: string, role: string) => { const item = byProvider.get(provider)!; return { provider, modelId: item.modelId, revision: item.revision, termsFingerprint: item.termsFingerprint, role }; };
    const request = CompileRequestSchema.parse({
      prompt, seed: 31, qualityProfile: 'studio', heroRegionIds: [hero.id], maxCostUsd: 1, maxAssetGenerations: 1, maxReferenceImages: 1, territory: 'NL', commercialUse: true, dryRun: false,
      refinementPolicy: { maxAssetRepairRounds: 2, maxSceneRepairRounds: 1, terrainCoDeformation: true },
      providerModels: [selection('openrouter', 'planner'), selection('openrouter', 'reviewer'), selection('openrouter', 'object-detection'), selection('openai', 'composition-image'), selection('openai', 'multiview-image'), selection('sam2-local', 'segmentation'), selection('tripo', 'image-to-3d')],
    });
    const events = []; for await (const event of compiler.compile(request, 'studio-cloud-fixture')) events.push(event);
    expect(events.at(-1)?.type).toBe('completed');
    const artifact = events.find((event) => event.type === 'artifact')!;
    const authoring = artifact.data['authoringWorld'] as { referenceImages: Array<{ kind: string }>; regionalCompositions: Array<{ objects: Array<{ screenBox: unknown }> }>; terrain: { edits: Array<{ mode: string }> }; entities: Array<{ visualState: Record<string, unknown> }> };
    expect(authoring.referenceImages.filter((item) => item.kind === 'object-multiview')).toHaveLength(4);
    expect(authoring.referenceImages.some((item) => item.kind === 'object-mask')).toBe(true);
    expect(authoring.referenceImages.some((item) => item.kind === 'blender-rgb')).toBe(true);
    expect(authoring.regionalCompositions[0]?.objects[0]?.screenBox).toEqual(detection.objects[0]!.screenBox);
    expect(authoring.terrain.edits.some((edit) => edit.mode === 'flatten')).toBe(true);
    expect(authoring.entities.some((entity) => entity.visualState['compositionDetected'] === true && entity.visualState['coDeformed'] === true)).toBe(true);
    expect(mesh).toMatchObject({ calls: 1, views: 4 });
    expect(segmentation.calls).toBe(1);
    expect(image.calls).toBe(6);
    expect(planning.calls).toEqual(['WorldDesignSpec', 'RegionalCompositionDetection', 'VisualReview']);
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
