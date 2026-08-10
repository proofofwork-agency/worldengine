import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { Accessor, Document, NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { persistCanonicalSnapshot, persistStagedArtifacts, startCompilerService, type RunningCompilerService } from './server.js';
import { JobLedger } from './ledger.js';
import { CompileRequestSchema, QUALITY_DIMENSION_WEIGHTS, WorldDesignSpecSchema, type ProviderRole, type ProviderTermsProfile, type QualityDimension } from '@worldengine/schema';
import { compileLocalWorldArtifacts, createQualityCertification, FileBinaryArtifactStore, FileWorldStorage, PAPER_DERIVED_BENCHMARK_SCENARIOS, ProviderExecutionRegistry, validateKtx2, type JsonPlanningInput, type ProviderAdapter, type ProviderInvocation, type WorldStorage } from '@worldengine/compiler';
import { createReferenceDesignSpec, REFERENCE_SCATTER_INSTANCES_PER_CHUNK } from '@worldengine/terrain';

let service: RunningCompilerService | undefined;
let directory: string | undefined;

class AbortablePlanningAdapter implements ProviderAdapter<JsonPlanningInput, unknown> {
  readonly provider = 'openrouter';
  readonly modelId = 'abortable-planner';
  readonly revision = 'r1';
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });

  async checkCapabilities() { return { structuredOutput: true, imageInput: true }; }
  async estimate() { return 0; }
  async invoke(_request: ProviderInvocation<JsonPlanningInput, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.markStarted();
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('Aborted')); return; }
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('Aborted')), { once: true });
    });
  }
}

function acceptedPlanningProfile(): ProviderTermsProfile {
  return {
    provider: 'openrouter', modelId: 'abortable-planner', revision: 'r1', termsUrl: 'https://openrouter.test/terms', termsFingerprint: 'a'.repeat(64),
    reviewedAt: '2026-08-01T00:00:00.000Z', acceptedAt: '2026-08-02T00:00:00.000Z', permittedTerritories: ['EU'], commercialUse: true,
    notices: [], outputConditions: 'fixture outputs approved', retention: 'zero data retention', trainingUse: 'disabled', contentRestrictions: [], cost: { unit: 'request', usd: 0 }, enabled: true,
  };
}

function fixtureGlb(): Uint8Array {
  const binary = new Uint8Array(36);
  const binaryView = new DataView(binary.buffer);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => binaryView.setFloat32(index * 4, value, true));
  const json = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: binary.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }], scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ name: 'Fixture', primitives: [{ attributes: { POSITION: 0 } }] }], animations: [{ name: 'Idle', samplers: [], channels: [] }] });
  const encoded = new TextEncoder().encode(json);
  const jsonLength = Math.ceil(encoded.byteLength / 4) * 4;
  const bytes = new Uint8Array(20 + jsonLength + 8 + binary.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20);
  bytes.set(encoded, 20);
  const binaryOffset = 20 + jsonLength;
  view.setUint32(binaryOffset, binary.byteLength, true);
  view.setUint32(binaryOffset + 4, 0x004e4942, true);
  bytes.set(binary, binaryOffset + 8);
  return bytes;
}

async function texturedFixtureGlb(): Promise<Uint8Array> {
  const document = new Document(); const buffer = document.createBuffer();
  const positions = document.createAccessor().setType(Accessor.Type.VEC3!).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const texcoords = document.createAccessor().setType(Accessor.Type.VEC2!).setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer);
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let pixel = 0; pixel < 64; pixel += 1) pixels.set([85, 110 + (pixel % 8) * 12, 65, 255], pixel * 4);
  const png = await sharp(pixels, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
  const texture = document.createTexture('fixture-albedo').setImage(Uint8Array.from(png)).setMimeType('image/png');
  const material = document.createMaterial('fixture-pbr').setBaseColorTexture(texture);
  const primitive = document.createPrimitive().setAttribute('POSITION', positions).setAttribute('TEXCOORD_0', texcoords).setMaterial(material);
  document.createScene().addChild(document.createNode().setMesh(document.createMesh('Fixture').addPrimitive(primitive)));
  document.createAnimation('Idle');
  return new NodeIO().writeBinary(document);
}

afterEach(async () => {
  await service?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  service = undefined;
  directory = undefined;
});

describe('compiler HTTP service', () => {
  it('publishes the bundle manifest only after both canonical documents exist', async () => {
    const spec = createReferenceDesignSpec(41);
    const request = CompileRequestSchema.parse({ prompt: spec.prompt, seed: spec.seed, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: false, dryRun: false });
    const artifact = compileLocalWorldArtifacts(request, spec, new Date('2026-08-10T00:00:00.000Z'));
    const calls: string[] = [];
    const storage = {
      async putDesignSpec() { calls.push('design'); return 'design'; },
      async putAuthoringWorld() { calls.push('authoring'); return 'authoring'; },
      async putBundle() { calls.push('bundle'); return 'bundle'; },
    } as unknown as WorldStorage;
    await persistCanonicalSnapshot(storage, artifact.bundle, artifact.designSpec, artifact.authoringWorld);
    expect(calls).toEqual(['design', 'authoring', 'bundle']);

    calls.length = 0;
    const failingStorage = {
      async putDesignSpec() { calls.push('design'); return 'design'; },
      async putAuthoringWorld() { calls.push('authoring'); throw new Error('simulated authoring write failure'); },
      async putBundle() { calls.push('bundle'); return 'bundle'; },
    } as unknown as WorldStorage;
    await expect(persistCanonicalSnapshot(failingStorage, artifact.bundle, artifact.designSpec, artifact.authoringWorld)).rejects.toThrow('simulated authoring write failure');
    expect(calls).toEqual(['design', 'authoring']);
  });

  it('turns a canonical publication fault into a durable terminal failure without exposing a partial bundle', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-publication-fault-'));
    const delegate = new FileWorldStorage(join(directory, 'fault-storage'));
    const faultingStorage = new Proxy(delegate, {
      get(target, property) {
        if (property === 'putAuthoringWorld') return async () => { throw new Error('fixture-private-storage-detail'); };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as WorldStorage;
    service = await startCompilerService({ dataDirectory: directory, worldStorage: faultingStorage });
    const response = await fetch(`${service.origin}/v1/compiles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Atomic publication failure fixture', seed: 43, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: false, dryRun: false }),
    });
    const { compileId } = await response.json() as { compileId: string };
    const events = await fetch(`${service.origin}/v1/compiles/${compileId}/events`).then((result) => result.text());
    expect(events).toContain('event: failed');
    expect(events).toContain('CANONICAL_PUBLICATION_FAILED');
    expect(events).not.toContain('fixture-private-storage-detail');
    expect(events).not.toContain('event: completed');
    const job = await fetch(`${service.origin}/v1/compiles/${compileId}`).then((result) => result.json()) as { status: string };
    expect(job.status).toBe('failed');
    expect((await fetch(`${service.origin}/v1/worlds/world-${compileId}/bundle`)).status).toBe(404);
  });

  it('copies only integrity-checked staged provider outputs into world storage', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-staged-'));
    const binary = new FileBinaryArtifactStore(join(directory, 'binary'));
    const worlds = new FileWorldStorage(join(directory, 'worlds'));
    const glb = await binary.put(fixtureGlb(), 'model/gltf-binary');
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const png = await binary.put(pngBytes, 'image/png');
    const heightfieldBytes = new Uint8Array(new Float32Array([0, 1, 2, 3]).buffer);
    const heightfield = await binary.put(heightfieldBytes, 'application/octet-stream');
    const ktx2Bytes = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ktx2 = await binary.put(ktx2Bytes, 'image/ktx2');
    await persistStagedArtifacts('staged-world', [
      { ...glb, uri: `assets/${glb.contentHash}.glb` },
      { ...png, uri: `references/${png.contentHash}.png` },
      { ...heightfield, uri: `terrain/${heightfield.contentHash}.f32` },
      { ...ktx2, uri: `terrain/${ktx2.contentHash}.ktx2` },
    ], binary, worlds);
    expect(await worlds.getAsset('staged-world', glb.contentHash)).toEqual(fixtureGlb());
    expect(await worlds.getReference('staged-world', png.contentHash, 'png')).toEqual(pngBytes);
    expect(await worlds.getTerrain('staged-world', heightfield.contentHash, 'f32')).toEqual(heightfieldBytes);
    expect(await worlds.getTerrain('staged-world', ktx2.contentHash, 'ktx2')).toEqual(ktx2Bytes);
    await expect(persistStagedArtifacts('staged-world', [{ ...png, uri: '../escape.png' }], binary, worlds)).rejects.toThrow('unsupported artifact URI');
  });

  it('creates a durable compile and serves its immutable bundle', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-test-'));
    service = await startCompilerService({ dataDirectory: directory });
    const health = await fetch(`${service.origin}/health`).then((result) => result.json()) as { generation: { browserKeysAccepted: boolean; blenderWorker: string; qualityProfiles: Record<string, { available: boolean; issue?: string }>; providers: Array<{ termsFingerprint: string; configured: boolean; operational: boolean; operationalIssues: string[] }> } };
    expect(health.generation).toMatchObject({ browserKeysAccepted: false, blenderWorker: 'not-configured', qualityProfiles: { local: { available: true }, cheap: { available: false, issue: expect.stringContaining('openrouter') }, studio: { available: false, issue: expect.stringContaining('blender') } } });
    expect(health.generation.providers).toEqual(expect.arrayContaining([expect.objectContaining({ termsFingerprint: 'UNREVIEWED', configured: false, operational: false, operationalIssues: expect.arrayContaining(['TERMS_NOT_ACCEPTED', 'TERMS_FINGERPRINT_INVALID']) })]));
    const response = await fetch(`${service.origin}/v1/compiles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'A coastal valley', seed: 42, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: true, dryRun: false }),
    });
    expect(response.status).toBe(202);
    const { compileId } = await response.json() as { compileId: string };
    const events = await fetch(`${service.origin}/v1/compiles/${compileId}/events`).then((result) => result.text());
    expect(events).toContain('event: completed');
    const bundleResponse = await fetch(`${service.origin}/v1/worlds/world-${compileId}/bundle`);
    expect(bundleResponse.status).toBe(200);
    const bundle = await bundleResponse.json() as { chunks: unknown[]; prototypes: unknown[]; immutable: boolean };
    expect(bundle.chunks).toHaveLength(256);
    expect(bundle.prototypes).toHaveLength(20);
    expect(bundle.immutable).toBe(true);
    const design = await fetch(`${service.origin}/v1/worlds/world-${compileId}/design`).then((result) => result.json()) as { format: string; regions: unknown[] };
    const authoring = await fetch(`${service.origin}/v1/worlds/world-${compileId}/authoring`).then((result) => result.json()) as { format: string; entities: unknown[]; revision: number };
    expect(design).toMatchObject({ format: 'WorldDesignSpec', regions: expect.any(Array) });
    expect(authoring).toMatchObject({ format: 'AuthoringWorld', revision: 0 });
    expect(authoring.entities).toHaveLength(REFERENCE_SCATTER_INSTANCES_PER_CHUNK * 256 + 20);
    const jobs = await fetch(`${service.origin}/v1/compiles`).then((result) => result.json()) as { jobs: Array<{ id: string; status: string }> };
    expect(jobs.jobs).toContainEqual(expect.objectContaining({ id: compileId, status: 'completed' }));
    const job = await fetch(`${service.origin}/v1/compiles/${compileId}`).then((result) => result.json()) as { events: Array<{ sequence: number; type: string }> };
    const artifactCatalog = await fetch(`${service.origin}/v1/compiles/${compileId}/artifacts`);
    expect(artifactCatalog.status).toBe(200);
    expect(await artifactCatalog.json()).toMatchObject({ compileId, artifacts: expect.any(Array), attempts: expect.any(Array), decisions: [] });
    const compileReport = await fetch(`${service.origin}/v1/compiles/${compileId}/report`);
    expect(compileReport.status).toBe(200);
    expect(await compileReport.json()).toMatchObject({ compileId, status: 'published', qualityProfile: 'local', cost: { capUsd: 0 } });
    expect((await fetch(`${service.origin}/v1/compiles/${compileId}/artifacts/missing`)).status).toBe(404);
    expect((await fetch(`${service.origin}/v1/compiles/${compileId}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxCostUsd: 1, confirmed: true }) })).status).toBe(409);
    const terminalSequence = job.events.find((event) => event.type === 'completed')!.sequence;
    const resumed = await fetch(`${service.origin}/v1/compiles/${compileId}/events`, { headers: { 'last-event-id': String(terminalSequence) } });
    expect(await resumed.text()).toBe('');
    const terminalCancel = await fetch(`${service.origin}/v1/compiles/${compileId}/cancel`, { method: 'POST' });
    expect(terminalCancel.status).toBe(409);
  });

  it('publishes an affirmed evidence-backed Studio certification and immutable HTML report', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-quality-'));
    const storage = new FileWorldStorage(join(directory, 'quality-storage'));
    const spec = createReferenceDesignSpec(51);
    const request = CompileRequestSchema.parse({ prompt: spec.prompt, seed: spec.seed, qualityProfile: 'studio', maxCostUsd: 100, maxAssetGenerations: 0, maxReferenceImages: 0, territory: 'NL', commercialUse: true, dryRun: false, refinementPolicy: { maxAssetRepairRounds: 2, maxSceneRepairRounds: 1, terrainCoDeformation: true } });
    const artifact = compileLocalWorldArtifacts(request, spec, new Date('2026-08-10T00:00:00.000Z'));
    const proofBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const proofHash = createHash('sha256').update(proofBytes).digest('hex');
    await storage.putReference(artifact.bundle.worldId, proofHash, 'png', proofBytes, 'image/png');
    const proofKinds = ['region-concept', 'object-mask', 'object-crop', 'object-multiview', 'blender-rgb', 'blender-depth', 'blender-normal', 'blender-semantic', 'blender-instance', 'placement-diagnostic'] as const;
    const prototypeId = artifact.authoringWorld.prototypes[0]!.id; const regionId = artifact.designSpec.regions[0]!.id;
    const proofReferences = proofKinds.map((kind) => ({ id: `proof-${kind}`, kind, uri: `references/${proofHash}.png`, contentHash: proofHash, contentType: 'image/png' as const, ...(kind === 'region-concept' ? { regionId } : {}), ...(['object-mask', 'object-crop', 'object-multiview'].includes(kind) ? { prototypeId } : {}), ...(['blender-rgb', 'blender-depth', 'blender-normal', 'blender-semantic', 'blender-instance'].includes(kind) ? { prototypeId } : {}), provenanceId: `provenance-proof-${kind}` }));
    const proofProvenance = proofKinds.map((kind) => ({ id: `provenance-proof-${kind}`, subjectId: `proof-${kind}`, kind: 'edited' as const, sourceUri: `references/${proofHash}.png`, license: { name: 'fixture evidence', commercialUse: true }, createdAt: '2026-08-10T00:00:00.000Z', contentHash: proofHash, parentIds: [], reviewedAt: '2026-08-10T00:00:00.000Z' }));
    artifact.authoringWorld.referenceImages.push(...proofReferences);
    artifact.authoringWorld.provenance.push(...proofProvenance); artifact.bundle.provenance.push(...proofProvenance);
    const detected = artifact.authoringWorld.entities.find((entity) => entity.visualState['compositionPlaced'] === true)!;
    detected.visualState = { ...detected.visualState, compositionDetected: true, coDeformed: true };
    if (artifact.authoringWorld.terrain.kind === 'compiled-heightfield') artifact.authoringWorld.terrain.footprintEdits.push({ footprint: [[-2, -2], [2, -2], [2, 2], [-2, 2]], targetHeight: 0, mode: 'flatten', supportMarginMeters: 2, falloffEndMeters: 5 });
    await persistCanonicalSnapshot(storage, artifact.bundle, artifact.designSpec, artifact.authoringWorld);
    const profiles = [
      { ...acceptedPlanningProfile(), provider: 'openrouter', modelId: 'planning-review' },
      { ...acceptedPlanningProfile(), provider: 'openrouter-image', modelId: 'openai/gpt-image-2' },
      { ...acceptedPlanningProfile(), provider: 'sam2-local', modelId: 'sam2' },
      { ...acceptedPlanningProfile(), provider: 'wavespeed', modelId: 'tripo3d/h3.1/multiview-to-3d' },
    ];
    service = await startCompilerService({ dataDirectory: directory, worldStorage: storage, providerProfiles: profiles });
    const scenarioEvidence = new Map<string, string>();
    for (const scenario of PAPER_DERIVED_BENCHMARK_SCENARIOS) {
      const uploaded = await fetch(`${service.origin}/v1/worlds/${artifact.bundle.worldId}/quality-evidence/${scenario.id}`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-worldengine-evidence-affirmed': 'true' }, body: proofBytes });
      expect(uploaded.status).toBe(201);
      scenarioEvidence.set(scenario.id, ((await uploaded.json()) as { referenceId: string }).referenceId);
    }
    const evidenceId = proofReferences[0]!.id;
    const dimensionScores = Object.fromEntries((Object.keys(QUALITY_DIMENSION_WEIGHTS) as QualityDimension[]).map((dimension) => [dimension, { score: 92, evidenceIds: [evidenceId] }])) as Record<QualityDimension, { score: number; evidenceIds: string[] }>;
    const byProvider = new Map(profiles.map((profile) => [profile.provider, profile]));
    const provider = (role: ProviderRole, name: string) => { const profile = byProvider.get(name)!; return { role, provider: profile.provider, modelId: profile.modelId, revision: profile.revision, termsFingerprint: profile.termsFingerprint }; };
    const certification = createQualityCertification({
      benchmarkId: 'studio-certification-51', qualityProfile: 'studio', dimensionScores,
      hardGates: ['provider-policy', 'all-assets-reviewed', 'terrain-contact', 'free-viewpoint', 'runtime-performance', 'cost-cap', 'independent-raters'].map((id) => ({ id, passed: true, message: `${id} passed`, evidenceIds: [evidenceId] })),
      scenarios: PAPER_DERIVED_BENCHMARK_SCENARIOS.map((scenario) => ({ id: scenario.id, score: 91, evidenceIds: [scenarioEvidence.get(scenario.id)!] })),
      raterCount: 3, raterAgreement: 0.82, evidenceIds: [evidenceId], actualCostUsd: 84, durationMs: 2_000,
      providers: [provider('planner', 'openrouter'), provider('reviewer', 'openrouter'), provider('object-detection', 'openrouter'), provider('composition-image', 'openrouter-image'), provider('multiview-image', 'openrouter-image'), provider('segmentation', 'sam2-local'), provider('image-to-3d', 'wavespeed')],
    });
    const published = await fetch(`${service.origin}/v1/worlds/${artifact.bundle.worldId}/certifications`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-worldengine-certification-affirmed': 'true' }, body: JSON.stringify(certification) });
    expect(published.status).toBe(201);
    expect(await published.json()).toMatchObject({ bundleVersion: 7, certified: true, weightedScore: 92 });
    const report = await fetch(`${service.origin}/v1/worlds/${artifact.bundle.worldId}/quality-report?format=html`);
    expect(report.headers.get('content-type')).toContain('text/html');
    expect(await report.text()).toContain('92.0/100 · CERTIFIED');
  });

  it('resumes and completes an interrupted durable job after service restart', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-ledger-'));
    const path = join(directory, 'jobs.sqlite');
    const request = CompileRequestSchema.parse({ prompt: 'recover me', seed: 3, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: false, dryRun: true });
    const first = new JobLedger(path); first.createJob('interrupted', request); first.close();
    service = await startCompilerService({ dataDirectory: directory });
    const events = await fetch(`${service.origin}/v1/compiles/interrupted/events`).then((response) => response.text());
    expect(events).toContain('event: completed');
    const recovered = await fetch(`${service.origin}/v1/compiles/interrupted`).then((response) => response.json()) as { status: string; events: Array<{ type: string }> };
    expect(recovered.status).toBe('completed');
    expect(recovered.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'completed' })]));
  });

  it('persists a typed repair decision while resetting only resumable DAG checkpoints', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-decision-'));
    const ledger = new JobLedger(join(directory, 'jobs.sqlite'));
    const request = CompileRequestSchema.parse({ prompt: 'repair me', seed: 4, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: false, dryRun: true });
    ledger.createJob('attention', request);
    await ledger.save('attention', { id: 'requirements', status: 'completed', output: { failure: 'camera drift' }, completedAt: '2026-08-10T00:00:00.000Z' });
    ledger.appendEvent({ sequence: 0, compileId: 'attention', type: 'needs-attention', phase: 'region-map', progress: 1, message: 'camera drift', timestamp: '2026-08-10T00:00:01.000Z', data: {} });
    expect(ledger.decisions('attention')).toEqual([expect.objectContaining({ approved: false, diagnosis: [expect.objectContaining({ code: 'composition-drift' })], actions: [expect.objectContaining({ type: 'regenerate-composition' })] })]);
    expect(ledger.attempts('attention')[0]?.plannedAction?.type).toBe('regenerate-composition');
    expect(ledger.nodeOutput('attention', 'requirements')).toBeDefined();
    ledger.resetDag('attention');
    expect(ledger.nodeOutput('attention', 'requirements')).toBeUndefined();
    expect(ledger.decisions('attention')).toHaveLength(1);
    ledger.createJob('silhouette-attention', request);
    ledger.appendEvent({ sequence: 0, compileId: 'silhouette-attention', type: 'needs-attention', phase: 'region-refinement', progress: 1, message: 'Blender region refinement failed silhouette thresholds', timestamp: '2026-08-10T00:00:02.000Z', data: {} });
    expect(ledger.decisions('silhouette-attention')[0]).toMatchObject({ diagnosis: [{ code: 'silhouette-mismatch' }], actions: [{ type: 'reconstruct-mesh' }] });
    ledger.close();
  });

  it('persists provider-priced generation attempts from compile cost accounting', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-provider-costs-'));
    const ledger = new JobLedger(join(directory, 'jobs.sqlite'));
    const request = CompileRequestSchema.parse({ prompt: 'account this provider action', seed: 8, maxCostUsd: 1, maxAssetGenerations: 0, territory: 'NL', commercialUse: false, dryRun: true });
    ledger.createJob('accounted', request);
    ledger.appendEvent({
      sequence: 0, compileId: 'accounted', type: 'cost', phase: 'cost-accounting', progress: 0.945,
      message: 'Provider attempts accounted against the confirmed cap', timestamp: '2026-08-10T00:00:01.000Z',
      data: { reservedCostUsd: 0.25, actualCostUsd: 0.25, providerAttempts: [{ id: 'provider-attempt-1', compileId: 'accounted', phase: 'composition', index: 0, status: 'passed', provider: 'openrouter-image', modelId: 'openai/gpt-image-2', revision: 'r1', reservedCostUsd: 0.25, actualCostUsd: 0.25, artifactIds: [], startedAt: '2026-08-10T00:00:00.000Z', completedAt: '2026-08-10T00:00:01.000Z' }] },
    });
    expect(ledger.attempts('accounted')).toEqual([expect.objectContaining({ id: 'provider-attempt-1', phase: 'composition', provider: 'openrouter-image', modelId: 'openai/gpt-image-2', revision: 'r1', reservedCostUsd: 0.25, actualCostUsd: 0.25 })]);
    ledger.close();
  });

  it('rejects malformed requests without persisting secrets', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-test-'));
    service = await startCompilerService({ dataDirectory: directory });
    const secret = 'must-never-reach-the-ledger';
    const response = await fetch(`${service.origin}/v1/compiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '', apiKey: secret }) });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
    const jobs = await fetch(`${service.origin}/v1/compiles`).then((result) => result.json()) as { jobs: unknown[] };
    expect(jobs.jobs).toEqual([]);
  });

  it('actively aborts in-flight provider work and never publishes a cancelled world', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-cancel-'));
    const adapter = new AbortablePlanningAdapter();
    const providers = new ProviderExecutionRegistry([adapter]);
    service = await startCompilerService({ dataDirectory: directory, providerProfiles: [acceptedPlanningProfile()], providerRegistry: providers });
    const spec = WorldDesignSpecSchema.parse({ ...createReferenceDesignSpec(17), prompt: 'Cancellation fixture' });
    const response = await fetch(`${service.origin}/v1/compiles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: spec.prompt, seed: spec.seed, maxCostUsd: 0, maxAssetGenerations: 0, maxReferenceImages: 0,
        territory: 'NL', commercialUse: true, dryRun: false, designSpec: spec,
        providerModels: [{ provider: adapter.provider, modelId: adapter.modelId, revision: adapter.revision, termsFingerprint: acceptedPlanningProfile().termsFingerprint }],
      }),
    });
    expect(response.status).toBe(202);
    const { compileId } = await response.json() as { compileId: string };
    await adapter.started;
    const cancelled = await fetch(`${service.origin}/v1/compiles/${compileId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({ compileId, status: 'cancelled' });
    const events = await fetch(`${service.origin}/v1/compiles/${compileId}/events`).then((result) => result.text());
    expect(events).toContain('event: cancelled');
    expect(events).not.toContain('event: completed');
    const job = await fetch(`${service.origin}/v1/compiles/${compileId}`).then((result) => result.json()) as { status: string };
    expect(job.status).toBe('cancelled');
    expect((await fetch(`${service.origin}/v1/worlds/world-${compileId}/bundle`)).status).toBe(404);
  });

  it('rejects browser mutations outside local/LAN or explicitly allowed editor origins', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-origin-'));
    service = await startCompilerService({ dataDirectory: directory, allowedOrigins: ['https://editor.example'] });
    const denied = await fetch(`${service.origin}/v1/compiles`, {
      method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Spend from another site', seed: 1, maxCostUsd: 10, maxAssetGenerations: 10, territory: 'NL', commercialUse: true, dryRun: false }),
    });
    expect(denied.status).toBe(403);
    const configured = await fetch(`${service.origin}/v1/compiles`, { method: 'OPTIONS', headers: { origin: 'https://editor.example' } });
    expect(configured.status).toBe(204);
    expect(configured.headers.get('access-control-allow-origin')).toBe('https://editor.example');
    const lan = await fetch(`${service.origin}/v1/compiles`, { method: 'OPTIONS', headers: { origin: 'http://192.168.1.96:4173' } });
    expect(lan.status).toBe(204);
  });

  it('keeps dry-run estimation read-only', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-dry-run-'));
    service = await startCompilerService({ dataDirectory: directory });
    const response = await fetch(`${service.origin}/v1/compiles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Estimate without publishing', seed: 5, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: false, dryRun: true }),
    });
    const { compileId } = await response.json() as { compileId: string };
    const events = await fetch(`${service.origin}/v1/compiles/${compileId}/events`).then((result) => result.text());
    expect(events).toContain('event: completed');
    const bundle = await fetch(`${service.origin}/v1/worlds/world-${compileId}/bundle`);
    expect(bundle.status).toBe(404);
  });

  it('verifies, time-bounds, and durably deduplicates WaveSpeed webhooks', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-webhook-'));
    const secret = 'whsec_fixture-secret';
    service = await startCompilerService({ dataDirectory: directory, waveSpeedWebhookSecret: secret });
    const eventId = 'event-123';
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const body = JSON.stringify({ id: 'wavespeed-task-9', status: 'completed' });
    const signature = createHmac('sha256', 'fixture-secret').update(`${eventId}.${timestamp}.${body}`).digest('hex');
    const send = () => fetch(`${service!.origin}/v1/webhooks/wavespeed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': timestamp, 'webhook-signature': `v3,${signature}` },
      body,
    });
    const first = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, duplicate: false, eventId, providerTaskId: 'wavespeed-task-9' });
    const duplicate = await send();
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true });

    const invalid = await fetch(`${service.origin}/v1/webhooks/wavespeed`, {
      method: 'POST', headers: { 'webhook-id': 'bad', 'webhook-timestamp': timestamp, 'webhook-signature': 'v3,00'.padEnd(67, '0') }, body,
    });
    expect(invalid.status).toBe(401);
  });

  it('creates new immutable versions for explicit expansion and revision-checked patches', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-test-'));
    service = await startCompilerService({ dataDirectory: directory });
    const compileResponse = await fetch(`${service.origin}/v1/compiles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Sparse expansion fixture', seed: 7, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: false, dryRun: false }),
    });
    const { compileId } = await compileResponse.json() as { compileId: string };
    await fetch(`${service.origin}/v1/compiles/${compileId}/events`).then((result) => result.text());
    const worldId = `world-${compileId}`;
    const design = await fetch(`${service.origin}/v1/worlds/${worldId}/design`).then((response) => response.json()) as { regions: Array<{ id: string; name: string; description: string; polygon: Array<[number, number]>; adjacentTo: string[]; biome: string; elevation: { min: number; max: number }; density: number }> };
    const expansion = await fetch(`${service.origin}/v1/worlds/${worldId}/chunks/12/-11/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxCostUsd: 0, maxAssetGenerations: 0 }),
    });
    expect(expansion.status).toBe(201);
    expect(await expansion.json()).toMatchObject({ worldId, bundleVersion: 2, chunkId: '12:-11' });

    const patch = await fetch(`${service.origin}/v1/worlds/${worldId}/patches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'environment-1', worldId, baseRevision: 1, createdAt: new Date().toISOString(), author: 'test', operations: [{ op: 'set-environment', values: { timeOfDay: 21 } }, { op: 'add-terrain-edit', center: [12 * 256 + 128, -11 * 256 + 128], radius: 80, delta: 4 }, { op: 'replace-region', region: { ...design.regions[0]!, biome: 'regenerated-wetland', description: 'regenerated by fixture' } }, { op: 'set-region-density', regionId: design.regions[0]!.id, density: 0.15 }] }),
    });
    expect(patch.status).toBe(201);
    expect(await patch.json()).toMatchObject({ bundleVersion: 3, revision: 2 });
    const latest = await fetch(`${service.origin}/v1/worlds/${worldId}/bundle`).then((response) => response.json()) as { environment: { timeOfDay: number }; chunks: Array<{ id: string; source: { kind: string; uri?: string } }> };
    expect(latest.environment.timeOfDay).toBe(21);
    expect(latest.chunks.find((chunk) => chunk.id === '12:-11')?.source.kind).toBe('uri');
    const detailedUri = latest.chunks.find((chunk) => chunk.id === '12:-11')?.source.uri;
    expect(detailedUri).toBe('chunks/12_-11.json?version=3');
    const detailed = await fetch(new URL(detailedUri!, `${service.origin}/v1/worlds/${worldId}/bundle`)).then((response) => response.json()) as { id: string; placeholder: boolean; terrain: { samples: number } };
    expect(detailed).toMatchObject({ id: '12:-11', placeholder: false, terrain: { samples: 257 } });
    const nextAuthoring = await fetch(`${service.origin}/v1/worlds/${worldId}/authoring`).then((response) => response.json()) as { revision: number; terrain: { edits: unknown[] }; regions: Array<{ id: string; density: number; biome: string }> };
    expect(nextAuthoring.revision).toBe(2);
    expect(nextAuthoring.terrain.edits).toHaveLength(1);
    expect(nextAuthoring.regions.find((region) => region.id === design.regions[0]!.id)?.density).toBe(0.15);
    expect(nextAuthoring.regions.find((region) => region.id === design.regions[0]!.id)?.biome).toBe('regenerated-wetland');

    const conflicting = await fetch(`${service.origin}/v1/worlds/${worldId}/patches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'environment-stale', worldId, baseRevision: 1, createdAt: new Date().toISOString(), author: 'test', operations: [{ op: 'set-environment', values: { timeOfDay: 6 } }] }),
    });
    expect(conflicting.status).toBe(409);
  });

  it('serializes concurrent mutations of the same immutable world', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-concurrency-'));
    service = await startCompilerService({ dataDirectory: directory });
    const compileResponse = await fetch(`${service.origin}/v1/compiles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Concurrent sparse expansion', seed: 31, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: false, dryRun: false }),
    });
    const { compileId } = await compileResponse.json() as { compileId: string };
    await fetch(`${service.origin}/v1/compiles/${compileId}/events`).then((result) => result.text());
    const worldId = `world-${compileId}`;
    const expand = (x: number) => fetch(`${service!.origin}/v1/worlds/${worldId}/chunks/${x}/11/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxCostUsd: 0, maxAssetGenerations: 0 }),
    });
    const responses = await Promise.all([expand(12), expand(13)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const versions = await Promise.all(responses.map((response) => response.json() as Promise<{ bundleVersion: number }>));
    expect(versions.map((entry) => entry.bundleVersion).sort()).toEqual([2, 3]);
    const latest = await fetch(`${service.origin}/v1/worlds/${worldId}/bundle`).then((response) => response.json()) as { bundleVersion: number; chunks: Array<{ id: string }> };
    expect(latest.bundleVersion).toBe(3);
    expect(latest.chunks).toEqual(expect.arrayContaining([expect.objectContaining({ id: '12:11' }), expect.objectContaining({ id: '13:11' })]));
  });

  it('imports content-addressed GLBs only through an explicit reviewed rights gate', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-asset-'));
    service = await startCompilerService({ dataDirectory: directory });
    const compileResponse = await fetch(`${service.origin}/v1/compiles`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Imported asset fixture', seed: 19, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: true, dryRun: false }),
    });
    const { compileId } = await compileResponse.json() as { compileId: string };
    await fetch(`${service.origin}/v1/compiles/${compileId}/events`).then((result) => result.text());
    const worldId = `world-${compileId}`;
    const before = await fetch(`${service.origin}/v1/worlds/${worldId}/bundle`).then((response) => response.json()) as { prototypes: Array<{ id: string }>; sourceRevision: number };
    const prototypeId = before.prototypes[0]!.id;
    const asset = await texturedFixtureGlb();
    const denied = await fetch(`${service.origin}/v1/worlds/${worldId}/assets/${prototypeId}/import`, {
      method: 'POST', headers: { 'content-type': 'model/gltf-binary', 'x-worldengine-base-revision': String(before.sourceRevision), 'x-worldengine-license-name': 'Test license' }, body: asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.byteLength) as ArrayBuffer,
    });
    expect(denied.status).toBe(403);

    const imported = await fetch(`${service.origin}/v1/worlds/${worldId}/assets/${prototypeId}/import`, {
      method: 'POST',
      headers: {
        'content-type': 'model/gltf-binary',
        'x-worldengine-base-revision': String(before.sourceRevision),
        'x-worldengine-rights-affirmed': 'true',
        'x-worldengine-license-name': encodeURIComponent('Test commercial license'),
        'x-worldengine-file-name': encodeURIComponent('fixture.glb'),
      },
      body: asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.byteLength) as ArrayBuffer,
    });
    expect(imported.status).toBe(201);
    const result = await imported.json() as { contentHash: string; sourceContentHash: string; revision: number; assetUri: string; animationClips: string[]; textureFormat: string };
    expect(result).toMatchObject({ revision: 1, animationClips: ['Idle'], textureFormat: 'ktx2' });
    expect(result.contentHash).not.toBe(result.sourceContentHash);
    expect(result.assetUri).toBe(`assets/${result.contentHash}.glb`);

    const after = await fetch(`${service.origin}/v1/worlds/${worldId}/bundle`).then((response) => response.json()) as { bundleVersion: number; optimization: { textureFormat: string }; prototypes: Array<{ id: string; assetUri: string; contentHash: string; textureFormat: string; animationClips: string[] }>; provenance: Array<{ id: string; subjectId: string; kind: string; parentIds: string[]; reviewedAt?: string; license: { commercialUse: boolean } }> };
    expect(after.bundleVersion).toBe(2);
    expect(after.optimization.textureFormat).toBe('ktx2');
    expect(after.prototypes.find((prototype) => prototype.id === prototypeId)).toMatchObject({ assetUri: result.assetUri, contentHash: result.contentHash, textureFormat: 'ktx2', animationClips: ['Idle'] });
    const derivative = after.provenance.find((record) => record.subjectId === prototypeId && record.kind === 'edited')!;
    const source = after.provenance.find((record) => derivative.parentIds.includes(record.id))!;
    expect(source).toMatchObject({ subjectId: `${prototypeId}:upload-source`, kind: 'imported', reviewedAt: expect.any(String), license: expect.objectContaining({ commercialUse: true }) });
    const served = await fetch(new URL(result.assetUri, `${service.origin}/v1/worlds/${worldId}/bundle`));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('model/gltf-binary');
    const servedBytes = new Uint8Array(await served.arrayBuffer());
    expect(servedBytes).not.toEqual(asset);
    const servedDocument = await new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).readBinary(servedBytes);
    expect(servedDocument.getRoot().listTextures()[0]?.getMimeType()).toBe('image/ktx2');
    expect(validateKtx2(servedDocument.getRoot().listTextures()[0]!.getImage()!)).toEqual([]);
  });
});
