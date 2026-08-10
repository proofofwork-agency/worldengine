import {
  EntityIdSchema,
  PatchConflictError,
  PatchIdSchema,
  RuntimeChunkDocumentSchema,
  TransformSchema,
  VisualStatePatchSchema,
  WorldPatchSchema,
  chunkId,
  type ChunkId,
  type EntityId,
  type Transform,
  type Vec3,
  type VisualStatePatch,
  type WorldPatch,
} from '@worldengine/schema';
import { decodeFloat32, decodeUint8 } from '@worldengine/terrain';
import type {
  CameraView,
  RenderTarget,
  RendererBackend,
  RuntimeChunk,
  VisualFrame,
  VisualWorld,
  VisualWorldEngine,
  VisualWorldEvent,
  WorldBundleSource,
  WorldBundleSourceInput,
} from './contracts.js';
import { HttpWorldBundleSource } from './source.js';

const defaultView: CameraView = {
  position: [0, 180, 320], target: [0, 0, 0], up: [0, 1, 0], projection: 'perspective', fov: 50, near: 0.1, far: 10_000, aspect: 1,
};

function isSource(input: WorldBundleSourceInput): input is WorldBundleSource {
  return typeof input === 'object' && input !== null && 'loadManifest' in input && 'loadChunk' in input;
}

function transformToMatrix(transform: Transform): [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number] {
  const [x, y, z, w] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    transform.position[0], transform.position[1], transform.position[2], 1,
  ];
}

export class DefaultVisualWorldEngine implements VisualWorldEngine {
  private source?: WorldBundleSource;
  private world?: VisualWorld;
  private view = defaultView;
  private origin: Vec3 = [0, 0, 0];
  private readonly listeners = new Set<(event: VisualWorldEvent) => void>();
  private readonly chunks = new Map<ChunkId, RuntimeChunk>();
  private readonly pending = new Map<ChunkId, Promise<void>>();
  private readonly queued = new Set<ChunkId>();
  private loadQueue: ChunkId[] = [];
  private readonly desired = new Set<ChunkId>();
  private disposed = false;
  private initialized = false;

  constructor(
    private readonly backend: RendererBackend,
    private readonly target: RenderTarget,
    private readonly floatingOriginThreshold = 4096,
    private readonly maxConcurrentChunkLoads = 2,
  ) {
    if (!Number.isInteger(maxConcurrentChunkLoads) || maxConcurrentChunkLoads < 1) throw new Error('maxConcurrentChunkLoads must be a positive integer');
  }

  async load(input: WorldBundleSourceInput): Promise<VisualWorld> {
    this.assertActive();
    if (!this.initialized) {
      await this.backend.initialize(this.target);
      this.initialized = true;
    }
    this.desired.clear();
    this.queued.clear();
    this.loadQueue = [];
    for (const id of [...this.chunks.keys()]) this.unloadChunk(id);
    await Promise.allSettled(this.pending.values());
    this.source = isSource(input) ? input : new HttpWorldBundleSource(new URL(input));
    const manifest = await this.source.loadManifest();
    await this.backend.setWorld?.(manifest);
    const engine = this;
    this.world = {
      manifest,
      get loadedChunkIds() { return [...engine.chunks.keys()]; },
      get revision() { return engine.currentRevision; },
    };
    this.currentRevision = manifest.sourceRevision;
    this.emit({ type: 'world-loaded', bundle: manifest });
    return this.world;
  }

  private currentRevision = 0;

  setView(view: CameraView): void {
    this.assertActive();
    this.view = { ...view, position: [...view.position], target: [...view.target], up: [...view.up] };
  }

  streamAround(position: Vec3, radius = 768): void {
    this.assertReady();
    const manifest = this.world!.manifest;
    const minX = Math.floor((position[0] - radius) / manifest.chunkSize);
    const maxX = Math.floor((position[0] + radius) / manifest.chunkSize);
    const minZ = Math.floor((position[2] - radius) / manifest.chunkSize);
    const maxZ = Math.floor((position[2] + radius) / manifest.chunkSize);
    const candidates: Array<{ id: ChunkId; distance: number }> = [];
    const nextDesired = new Set<ChunkId>();
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const centerX = (x + 0.5) * manifest.chunkSize;
        const centerZ = (z + 0.5) * manifest.chunkSize;
        if (Math.hypot(centerX - position[0], centerZ - position[2]) <= radius + manifest.chunkSize * 0.72) {
          const id = chunkId(x, z);
          const distance = Math.hypot(centerX - position[0], centerZ - position[2]);
          nextDesired.add(id);
          candidates.push({ id, distance });
        }
      }
    }
    this.desired.clear();
    nextDesired.forEach((id) => this.desired.add(id));
    this.loadQueue = this.loadQueue.filter((id) => nextDesired.has(id));
    for (const id of [...this.queued]) if (!nextDesired.has(id)) this.queued.delete(id);
    candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    for (const candidate of candidates) this.enqueueChunk(candidate.id);
    this.pumpChunkQueue();
    const unloadRadius = radius + manifest.chunkSize * 1.5;
    for (const [id, chunk] of this.chunks) {
      const centerX = (chunk.coordinate.x + 0.5) * manifest.chunkSize;
      const centerZ = (chunk.coordinate.z + 0.5) * manifest.chunkSize;
      if (!nextDesired.has(id) && Math.hypot(centerX - position[0], centerZ - position[2]) > unloadRadius) this.unloadChunk(id);
    }
    if (Math.hypot(position[0] - this.origin[0], position[2] - this.origin[2]) >= this.floatingOriginThreshold) {
      this.origin = [position[0], 0, position[2]];
      this.emit({ type: 'origin-shifted', origin: this.origin });
    }
  }

  setEntityTransform(id: EntityId, transform: Transform): void {
    const validId = EntityIdSchema.parse(id);
    const validTransform = TransformSchema.parse(transform);
    for (const chunk of this.chunks.values()) {
      const entity = chunk.instances.find((instance) => instance.id === validId);
      if (entity) entity.matrix = transformToMatrix(validTransform);
    }
    void this.applyHostPatch({ op: 'set-transform', entityId: validId, transform: validTransform });
  }

  setEntityState(id: EntityId, patch: VisualStatePatch): void {
    const validId = EntityIdSchema.parse(id);
    const state = VisualStatePatchSchema.parse(patch);
    for (const chunk of this.chunks.values()) {
      const entity = chunk.instances.find((instance) => instance.id === validId);
      if (entity) entity.visualState = { ...entity.visualState, ...state };
    }
    void this.applyHostPatch({ op: 'set-visual-state', entityId: validId, state });
  }

  async applyPatch(input: WorldPatch): Promise<void> {
    this.assertReady();
    const patch = WorldPatchSchema.parse(input);
    if (patch.worldId !== this.world!.manifest.worldId) throw new Error(`Patch targets world ${patch.worldId}, but ${this.world!.manifest.worldId} is loaded`);
    if (patch.baseRevision !== this.currentRevision) throw new PatchConflictError(patch.baseRevision, this.currentRevision);
    const reloadOperations = patch.operations.filter((operation) => ['add-entity', 'remove-entity', 'replace-prototype', 'add-terrain-edit', 'set-region-density', 'replace-region'].includes(operation.op));
    if (reloadOperations.length > 0) throw new Error(`Live runtime patch contains ${reloadOperations.map((operation) => operation.op).join(', ')}; load the new immutable bundle version before applying structural or generated-content changes`);
    await this.backend.applyVisualPatch(patch);
    this.currentRevision += 1;
    for (const operation of patch.operations) {
      if (operation.op === 'invalidate-chunk') {
        const id = operation.chunkId;
        if (this.chunks.has(id)) {
          this.unloadChunk(id);
          if (this.desired.has(id)) this.enqueueChunk(id);
        }
      }
    }
    this.pumpChunkQueue();
  }

  update(frame: Omit<VisualFrame, 'view' | 'origin'>): void {
    this.assertReady();
    this.backend.render({ ...frame, view: this.view, origin: this.origin });
  }

  subscribe(listener: (event: VisualWorldEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.desired.clear();
    this.queued.clear();
    this.loadQueue = [];
    for (const id of [...this.chunks.keys()]) this.unloadChunk(id);
    await Promise.allSettled(this.pending.values());
    await this.backend.dispose();
    this.emit({ type: 'disposed' });
    this.listeners.clear();
  }

  private enqueueChunk(id: ChunkId): void {
    if (this.chunks.has(id) || this.pending.has(id) || this.queued.has(id)) return;
    this.queued.add(id);
    this.loadQueue.push(id);
  }

  private pumpChunkQueue(): void {
    while (this.pending.size < this.maxConcurrentChunkLoads && this.loadQueue.length > 0) {
      const id = this.loadQueue.shift()!;
      this.queued.delete(id);
      if (!this.desired.has(id) || this.chunks.has(id) || this.pending.has(id)) continue;
      this.startChunkLoad(id);
    }
  }

  private startChunkLoad(id: ChunkId): void {
    const isKnown = this.world!.manifest.chunks.some((chunk) => chunk.id === id);
    const load = isKnown ? this.source!.loadChunk(id) : this.source!.loadPlaceholder?.(id);
    if (!load) return;
    this.emit({ type: 'chunk-requested', chunkId: id, placeholder: !isKnown });
    const pending = load.then((document) => this.installChunk(document)).catch((value: unknown) => {
      const error = value instanceof Error ? value : new Error(String(value));
      this.emit({ type: 'chunk-error', chunkId: id, error });
    }).finally(() => {
      this.pending.delete(id);
      this.pumpChunkQueue();
    });
    this.pending.set(id, pending);
  }

  private async installChunk(input: unknown): Promise<void> {
    const document = RuntimeChunkDocumentSchema.parse(input);
    if (!this.desired.has(document.id)) return;
    const chunk: RuntimeChunk = {
      ...document,
      terrain: {
        samples: document.terrain.samples,
        heights: decodeFloat32(document.terrain.heights),
        minHeight: document.terrain.minHeight,
        maxHeight: document.terrain.maxHeight,
        ...(document.terrain.biomeWeights ? { biomeWeights: decodeUint8(document.terrain.biomeWeights, document.terrain.samples ** 2) } : {}),
        materialSplats: document.terrain.materialSplats.map((splat) => ({ materialSetId: splat.materialSetId, weights: decodeUint8(splat.weights, document.terrain.samples ** 2) })),
        textureDependencies: document.terrain.textureDependencies,
      },
    };
    await this.backend.loadChunk(chunk);
    if (!this.desired.has(chunk.id)) {
      this.backend.unloadChunk(chunk.id);
      return;
    }
    this.chunks.set(chunk.id, chunk);
    this.emit({ type: 'chunk-loaded', chunkId: chunk.id, chunk });
    for (const entity of chunk.instances) this.emit({ type: 'entity-available', entity, chunkId: chunk.id });
  }

  private unloadChunk(id: ChunkId): void {
    const chunk = this.chunks.get(id);
    if (!chunk) return;
    for (const entity of chunk.instances) this.emit({ type: 'entity-disposed', entityId: entity.id, chunkId: id });
    this.backend.unloadChunk(id);
    this.chunks.delete(id);
    this.emit({ type: 'chunk-unloaded', chunkId: id });
  }

  private async applyHostPatch(operation: WorldPatch['operations'][number]): Promise<void> {
    if (!this.world) return;
    await this.backend.applyVisualPatch({
      id: PatchIdSchema.parse(`host-${crypto.randomUUID()}`), worldId: this.world.manifest.worldId,
      baseRevision: this.currentRevision, createdAt: new Date().toISOString(), author: 'host', operations: [operation],
    });
  }

  private emit(event: VisualWorldEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('VisualWorldEngine has been disposed');
  }

  private assertReady(): void {
    this.assertActive();
    if (!this.world || !this.source) throw new Error('Load a world before using the engine');
  }
}
