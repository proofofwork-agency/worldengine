import { createHash, randomUUID } from 'node:crypto';
import {
  ChunkCompileRequestSchema,
  CompileEventSchema,
  CompileRequestSchema,
  AuthoringWorldSchema,
  RegenerateRequestSchema,
  VisualWorldBundleSchema,
  WorldPatchSchema,
  WorldDesignSpecSchema,
  type ChunkCompileRequest,
  type CompileEvent,
  type CompileRequest,
  type RegenerateRequest,
  type VisualWorldBundle,
  type WorldCompiler,
} from '@worldengine/schema';
import { createReferenceBundle, generateReferenceChunk, generateReferenceChunkAsync, sampleWorldHeight } from '@worldengine/terrain';
import type { ArtifactCache } from './artifact-cache.js';
import type { BinaryArtifactStore } from './binary-artifact.js';
import { compileLocalWorldArtifacts, type CompiledWorldArtifacts } from './authoring-compiler.js';
import { prepareCloudCompile, reviewCloudArtifacts, type CloudPreparation, type StagedBinaryArtifact } from './cloud-pipeline.js';
import { CompileDagExecutor, type DagCheckpointStore, type DagNode } from './dag.js';
import { assertCostBudget, ProviderPolicyError, ProviderPolicyRegistry } from './legal.js';
import { planLocalWorldDesign } from './local-planner.js';
import { rasterizeRegions } from './composition.js';
import { assertValidBundle } from './validation.js';
import { ProviderExecutionRegistry } from './provider.js';
import { assertQualityProfileRequest } from './quality-profile.js';
import type { StudioWorkerRegistry } from './studio-workers.js';

export interface CompilerPipelineOptions {
  policies?: ProviderPolicyRegistry;
  artifactCache?: ArtifactCache;
  checkpoints?: DagCheckpointStore;
  providers?: ProviderExecutionRegistry;
  binaryArtifacts?: BinaryArtifactStore;
  studioWorkers?: StudioWorkerRegistry;
}

interface CachedCompileArtifacts extends CompiledWorldArtifacts { binaryArtifacts: StagedBinaryArtifact[] }

export class DeterministicWorldCompiler implements WorldCompiler {
  private readonly policies: ProviderPolicyRegistry;
  private readonly artifactCache: ArtifactCache | undefined;
  private readonly providers: ProviderExecutionRegistry;
  private readonly providerExecutionConfigured: boolean;
  private readonly binaryArtifacts: BinaryArtifactStore | undefined;
  private readonly studioWorkers: StudioWorkerRegistry | undefined;
  private readonly dag: CompileDagExecutor<CompileRequest>;

  constructor(options: CompilerPipelineOptions = {}) {
    this.policies = options.policies ?? new ProviderPolicyRegistry();
    this.artifactCache = options.artifactCache;
    this.providers = options.providers ?? new ProviderExecutionRegistry();
    this.providerExecutionConfigured = options.providers !== undefined;
    this.binaryArtifacts = options.binaryArtifacts;
    this.studioWorkers = options.studioWorkers;
    this.dag = new CompileDagExecutor(options.checkpoints);
  }

  compile(request: CompileRequest, compileId: string = randomUUID()): AsyncIterable<CompileEvent> {
    return this.runCompile(CompileRequestSchema.parse(request), compileId, new AbortController().signal);
  }

  compileWithSignal(request: CompileRequest, compileId: string, signal: AbortSignal): AsyncIterable<CompileEvent> {
    return this.runCompile(CompileRequestSchema.parse(request), compileId, signal);
  }

  regenerate(request: RegenerateRequest, compileId: string = randomUUID()): AsyncIterable<CompileEvent> {
    return this.runRegenerate(RegenerateRequestSchema.parse(request), compileId);
  }

  requestChunk(request: ChunkCompileRequest, compileId: string = randomUUID()): AsyncIterable<CompileEvent> {
    return this.runChunkCompile(ChunkCompileRequestSchema.parse(request), compileId);
  }

  private async *runRegenerate(request: RegenerateRequest, compileId: string): AsyncIterable<CompileEvent> {
    let sequence = 0;
    const emit = (type: CompileEvent['type'], phase: string, progress: number, message: string, data: Record<string, unknown> = {}) => CompileEventSchema.parse({ sequence: sequence++, compileId, type, phase, progress, message, timestamp: new Date().toISOString(), data });
    yield emit('queued', 'regenerate', 0, 'Regional regeneration queued', { worldId: request.worldId, baseRevision: request.baseRevision });
    if (request.maxAssetGenerations > 0) {
      yield emit('failed', 'validation', 1, 'Regional patch regeneration does not execute asset providers; use a confirmed full cloud compile to generate replacement assets', { code: 'ASSET_GENERATION_UNSUPPORTED' });
      return;
    }
    if (!request.designSpec || !request.bundle) {
      yield emit('failed', 'validation', 1, 'Standalone regeneration requires the current designSpec and bundle; service callers should use the revision-checked patch endpoint', { code: 'CANONICAL_ARTIFACTS_REQUIRED' });
      return;
    }
    const selected = request.designSpec.regions.filter((region) => request.regionIds.includes(region.id));
    if (selected.length !== request.regionIds.length || selected.length === 0) {
      yield emit('failed', 'validation', 1, 'Regeneration requires one or more known region IDs', { code: 'UNKNOWN_OR_EMPTY_REGION' });
      return;
    }
    yield emit('phase-started', 'validation', 0.2, 'Validated requested regions and immutable base revision', { regionIds: selected.map((region) => region.id) });
    const lower = request.prompt.toLowerCase();
    const operations: Array<Record<string, unknown>> = [];
    const affectedChunkIds = new Set<string>();
    for (const region of selected) {
      const biome = /desert|dune|arid/.test(lower) ? 'desert' : /snow|frozen|ice|tundra/.test(lower) ? 'frozen-tundra'
        : /volcan|lava|ash/.test(lower) ? 'volcanic' : /wetland|swamp|marsh/.test(lower) ? 'wetland'
          : /forest|wood|grove/.test(lower) ? 'temperate-forest' : /coast|shore|beach/.test(lower) ? 'coastal'
            : /grass|plain|meadow/.test(lower) ? 'grassland' : /mountain|highland|cliff|canyon/.test(lower) ? 'highland' : region.biome;
      const density = /\bsparse|empty|open\b/.test(lower) ? Math.max(0.05, region.density * 0.65) : /\bdense|lush|crowded|thick\b/.test(lower) ? Math.min(1, region.density * 1.25) : region.density;
      operations.push({ op: 'replace-region', region: { ...region, biome, density, description: `${region.description}\nRegenerated visual direction: ${request.prompt}`.trim() } });
      const minX = Math.min(...region.polygon.map((point) => point[0])); const maxX = Math.max(...region.polygon.map((point) => point[0]));
      const minZ = Math.min(...region.polygon.map((point) => point[1])); const maxZ = Math.max(...region.polygon.map((point) => point[1]));
      for (const chunk of request.bundle.chunks) if (chunk.bounds.max[0] >= minX && chunk.bounds.min[0] <= maxX && chunk.bounds.max[1] >= minZ && chunk.bounds.min[1] <= maxZ) affectedChunkIds.add(chunk.id);
    }
    for (const chunkId of affectedChunkIds) operations.push({ op: 'invalidate-chunk', chunkId });
    const patch = WorldPatchSchema.parse({ id: `regenerate-${compileId}`, worldId: request.worldId, baseRevision: request.baseRevision, createdAt: new Date().toISOString(), author: 'worldengine-compiler', operations });
    yield emit('artifact', 'patch', 0.9, 'Compiled regional prompt into a schema-valid canonical patch', { patch, affectedChunkIds: [...affectedChunkIds] });
    yield emit('completed', 'complete', 1, 'Regional regeneration patch completed', { patchId: patch.id, regionIds: request.regionIds });
  }

  private async *runChunkCompile(request: ChunkCompileRequest, compileId: string): AsyncIterable<CompileEvent> {
    let sequence = 0;
    const emit = (type: CompileEvent['type'], phase: string, progress: number, message: string, data: Record<string, unknown> = {}) => CompileEventSchema.parse({ sequence: sequence++, compileId, type, phase, progress, message, timestamp: new Date().toISOString(), data });
    yield emit('queued', 'chunk', 0, 'Explicit sparse chunk compile queued', { x: request.x, z: request.z });
    if (request.maxAssetGenerations > 0) {
      yield emit('failed', 'validation', 1, 'Sparse chunk materialization is deterministic and does not execute asset providers', { code: 'ASSET_GENERATION_UNSUPPORTED' });
      return;
    }
    if (!request.bundle) {
      yield emit('failed', 'validation', 1, 'Standalone chunk compilation requires the current bundle; service callers can resolve it by worldId', { code: 'CANONICAL_BUNDLE_REQUIRED' });
      return;
    }
    const chunk = await materializeDetailedChunkAsync(request.bundle, request.x, request.z);
    yield emit('artifact', 'chunk', 0.9, 'Materialized deterministic detailed chunk', { chunk });
    yield emit('completed', 'complete', 1, 'Explicit sparse chunk compile completed', { coordinate: { x: request.x, z: request.z }, chunkId: chunk.id });
  }

  private async *runCompile(request: CompileRequest, compileId: string, signal: AbortSignal): AsyncIterable<CompileEvent> {
    let sequence = 0;
    const emit = (type: CompileEvent['type'], phase: string, progress: number, message: string, data: Record<string, unknown> = {}): CompileEvent => CompileEventSchema.parse({
      sequence: sequence++, compileId, type, phase, progress, message, timestamp: new Date().toISOString(), data,
    });
    yield emit('queued', 'queue', 0, 'Compile accepted');
    try {
      assertQualityProfileRequest(request);
      this.policies.assertCompileAllowed(request);
      const estimate = this.policies.estimateMaximumCost(request);
      assertCostBudget(request, estimate);
      yield emit('cost', 'cost-gate', 0.04, request.dryRun ? 'Dry-run estimate complete' : 'Cost cap confirmed', { estimatedCostUsd: estimate, maxCostUsd: request.maxCostUsd });
      if (!request.dryRun && request.providerModels.length > 0 && (!this.providerExecutionConfigured || !this.binaryArtifacts)) throw new ProviderPolicyError('PROVIDER_EXECUTION_NOT_CONFIGURED', 'Reviewed provider models require explicitly configured provider execution and binary artifact registries');
      const promptHash = createHash('sha256').update(request.prompt).digest('hex');
      const cacheKey = createHash('sha256').update(JSON.stringify({
        format: 'worldengine-compile-v8',
        assetOptimization: { meshLods: 'meshoptimizer-1.2.0', textures: 'ktx2-encoder-0.6.0-basis-1b33fd5' },
        reviewDiagnostics: { glb: 'cpu-glb-diagnostic-1.0.0', placement: 'cpu-placement-diagnostic-1.1.0-camera-aligned' },
        execution: request.dryRun ? 'dry-run' : 'execute',
        prompt: request.prompt,
        seed: request.seed,
        maxAssetGenerations: request.maxAssetGenerations,
        maxReferenceImages: request.maxReferenceImages,
        qualityProfile: request.qualityProfile,
        heroRegionIds: request.heroRegionIds,
        refinementPolicy: request.refinementPolicy,
        providerModels: request.providerModels,
        designSpec: request.designSpec,
        assets: request.assetLibrary.map((asset) => [asset.id, asset.contentHash, asset.textureFormat, asset.lods.map((lod) => [lod.contentHash, lod.distance, lod.provenanceId])]),
      })).digest('hex');
      const cached = await this.artifactCache?.get<CachedCompileArtifacts>(cacheKey);
      if (cached) {
        const artifact: CompiledWorldArtifacts = { designSpec: WorldDesignSpecSchema.parse(cached.value.designSpec), authoringWorld: AuthoringWorldSchema.parse(cached.value.authoringWorld), bundle: assertValidBundle(cached.value.bundle) };
        const bundle = artifact.bundle;
        yield emit('artifact', 'cache', 0.96, 'Reused validated canonical artifacts from artifact cache', { ...artifact, binaryArtifacts: cached.value.binaryArtifacts ?? [], promptHash, cacheKey, cached: true });
        yield emit('completed', 'complete', 1, 'Compile completed from cache', { worldId: bundle.worldId, bundleVersion: bundle.bundleVersion });
        return;
      }
      const nodes: DagNode<CompileRequest>[] = [
        { id: 'requirements', run: async ({ shared, signal: nodeSignal }) => {
          nodeSignal.throwIfAborted();
          const localSpec = planLocalWorldDesign(shared);
          if (shared.dryRun || shared.providerModels.length === 0) return {
            request: shared, designSpec: localSpec, references: [], referenceProvenance: [], stagedArtifacts: [], generatedPrototypeIds: [], optimizationWarnings: [], compositionOverrides: [],
          } satisfies CloudPreparation;
          return prepareCloudCompile(shared, localSpec, this.providers, this.policies, this.binaryArtifacts!, nodeSignal, fetch, this.studioWorkers);
        } },
        { id: 'region-map', dependencies: ['requirements'], run: async ({ output, signal: nodeSignal }) => {
          nodeSignal.throwIfAborted();
          const spec = output<CloudPreparation>('requirements').designSpec;
          const mask = rasterizeRegions(spec.regions, spec.bounds, 256, 256);
          return { width: mask.width, height: mask.height, assignedPixels: [...mask.values].filter((value) => value !== 0).length, regionIds: mask.regionIds, roads: spec.features.filter((feature) => feature.kind === 'road').length, rivers: spec.features.filter((feature) => feature.kind === 'river').length, coastlines: spec.features.filter((feature) => feature.kind === 'coastline').length };
        } },
        { id: 'terrain', dependencies: ['region-map'], run: async ({ shared, output, signal: nodeSignal }) => {
          nodeSignal.throwIfAborted();
          const preparation = output<CloudPreparation>('requirements');
          return compileLocalWorldArtifacts(preparation.request, preparation.designSpec, new Date(), new Set(preparation.generatedPrototypeIds), { compositionOverrides: preparation.compositionOverrides });
        } },
        { id: 'composition', dependencies: ['terrain'], run: async ({ output }) => {
          const artifact = output<CompiledWorldArtifacts>('terrain');
          const byRegion = Object.fromEntries(artifact.designSpec.regions.map((region) => [region.id, artifact.authoringWorld.entities.filter((entity) => entity.regionId === region.id).length]));
          return { prototypeCount: artifact.bundle.prototypes.length, entityCount: artifact.authoringWorld.entities.length, byRegion, libraryAssets: artifact.bundle.provenance.filter((record) => record.kind === 'imported').length };
        } },
        { id: 'placement', dependencies: ['composition'], run: async ({ output, signal: nodeSignal }) => {
          const artifact = output<CompiledWorldArtifacts>('terrain');
          let contactErrors = 0;
          for (const entity of artifact.authoringWorld.entities) {
            nodeSignal.throwIfAborted();
            if (entity.visualState['proceduralScatter'] !== true && entity.visualState['compositionPlaced'] !== true) continue;
            const expected = sampleWorldHeight(artifact.bundle, entity.transform.position[0], entity.transform.position[2]);
            if (Math.abs(expected - entity.transform.position[1]) > 0.001) contactErrors += 1;
          }
          if (contactErrors > 0) throw new Error(`${contactErrors} procedural placements failed terrain contact validation`);
          return { deterministicInstances: artifact.authoringWorld.entities.length, terrainContactValidated: true };
        } },
        { id: 'visual-review', dependencies: ['placement'], run: async ({ output, signal: nodeSignal }) => {
          const artifact = await reviewCloudArtifacts(output<CompiledWorldArtifacts>('terrain'), output<CloudPreparation>('requirements'), request, this.providers, this.binaryArtifacts, nodeSignal);
          AuthoringWorldSchema.parse(artifact.authoringWorld);
          assertValidBundle(artifact.bundle);
          return artifact;
        } },
        { id: 'optimization', dependencies: ['visual-review'], run: async ({ output }) => {
          const artifact = output<CompiledWorldArtifacts>('visual-review');
          if (!artifact.bundle.optimization.instanceGroups || !artifact.bundle.optimization.occlusionMetadata) throw new Error('Local bundle optimization metadata is incomplete');
          return artifact;
        } },
      ];
      const results = await this.dag.execute(compileId, nodes, request, signal);
      const progressByPhase: Record<string, number> = { requirements: 0.14, 'region-map': 0.28, terrain: 0.42, composition: 0.56, placement: 0.7, 'visual-review': 0.82, optimization: 0.92 };
      for (const result of results) {
        if (result.status !== 'completed') throw new Error(`Compile DAG ${result.id} ${result.status}: ${result.error ?? 'unknown error'}`);
        yield emit('progress', result.id, progressByPhase[result.id] ?? 0.5, `Completed ${result.id}`, { checkpointed: true });
      }
      const rawArtifact = results.find((result) => result.id === 'optimization')?.output as CompiledWorldArtifacts | undefined;
      if (!rawArtifact) throw new Error('Compiler optimization produced no canonical artifacts');
      const artifact: CompiledWorldArtifacts = { designSpec: WorldDesignSpecSchema.parse(rawArtifact.designSpec), authoringWorld: AuthoringWorldSchema.parse(rawArtifact.authoringWorld), bundle: assertValidBundle(rawArtifact.bundle) };
      const bundle = artifact.bundle;
      const preparation = results.find((result) => result.id === 'requirements')?.output as CloudPreparation | undefined;
      const binaryArtifacts = preparation?.stagedArtifacts ?? [];
      await this.artifactCache?.put(cacheKey, { ...artifact, binaryArtifacts });
      yield emit('artifact', 'export', 0.96, 'Created canonical design, authoring, and immutable runtime artifacts', { ...artifact, binaryArtifacts, promptHash, cacheKey, cached: false, defaultsApplied: artifact.designSpec.defaultsApplied });
      yield emit('completed', 'complete', 1, 'Compile completed', { worldId: bundle.worldId, bundleVersion: bundle.bundleVersion });
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value));
      if (signal.aborted) yield emit('cancelled', 'cancelled', 1, 'Compile cancelled', {});
      else yield emit('failed', 'failed', 1, error.message, { errorName: error.name, code: 'code' in error ? (error as { code: unknown }).code : undefined });
    }
  }

}

export function materializeDetailedChunk(source: number | VisualWorldBundle, x: number, z: number, samples?: number) {
  const bundle = typeof source === 'number' ? createReferenceBundle(source) : VisualWorldBundleSchema.parse(source);
  return generateReferenceChunk(bundle, { x, z }, { samples: samples ?? bundle.terrainSamples });
}

export function materializeDetailedChunkAsync(source: number | VisualWorldBundle, x: number, z: number, samples?: number) {
  const bundle = typeof source === 'number' ? createReferenceBundle(source) : VisualWorldBundleSchema.parse(source);
  return generateReferenceChunkAsync(bundle, { x, z }, { samples: samples ?? bundle.terrainSamples });
}
