import type {
  ChunkId,
  EntityId,
  RuntimeChunkDocument,
  RuntimeInstance,
  Transform,
  Vec3,
  VisualStatePatch,
  VisualWorldBundle,
  WorldPatch,
} from '@worldengine/schema';

export interface CameraView {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  projection: 'perspective' | 'orthographic';
  fov?: number;
  orthographicSize?: number;
  near: number;
  far: number;
  aspect: number;
}

export interface RenderTarget {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
  pixelRatio?: number;
}

export interface RuntimeTerrain {
  samples: number;
  heights: Float32Array;
  minHeight: number;
  maxHeight: number;
  biomeWeights?: Uint8Array;
}

export interface RuntimeChunk extends Omit<RuntimeChunkDocument, 'terrain'> {
  terrain: RuntimeTerrain;
}

export interface VisualFrame {
  deltaSeconds: number;
  elapsedSeconds: number;
  view: CameraView;
  origin: Vec3;
}

export interface RendererBackend {
  initialize(target: RenderTarget): Promise<void>;
  setWorld?(bundle: VisualWorldBundle): Promise<void> | void;
  loadChunk(chunk: RuntimeChunk): Promise<void>;
  unloadChunk(chunkId: ChunkId): void;
  applyVisualPatch(patch: WorldPatch): Promise<void>;
  render(frame: VisualFrame): void;
  dispose(): Promise<void>;
}

export interface WorldBundleSource {
  loadManifest(): Promise<VisualWorldBundle>;
  loadChunk(id: ChunkId): Promise<RuntimeChunkDocument>;
  loadPlaceholder?(id: ChunkId): Promise<RuntimeChunkDocument>;
}

export type WorldBundleSourceInput = WorldBundleSource | string | URL;

export type VisualWorldEvent =
  | { type: 'world-loaded'; bundle: VisualWorldBundle }
  | { type: 'chunk-requested'; chunkId: ChunkId; placeholder: boolean }
  | { type: 'chunk-loaded'; chunkId: ChunkId; chunk: RuntimeChunk }
  | { type: 'chunk-unloaded'; chunkId: ChunkId }
  | { type: 'chunk-error'; chunkId: ChunkId; error: Error }
  | { type: 'entity-available'; entity: RuntimeInstance; chunkId: ChunkId }
  | { type: 'entity-disposed'; entityId: EntityId; chunkId: ChunkId }
  | { type: 'origin-shifted'; origin: Vec3 }
  | { type: 'disposed' };

export interface VisualWorld {
  readonly manifest: VisualWorldBundle;
  readonly loadedChunkIds: readonly ChunkId[];
  readonly revision: number;
}

export interface VisualWorldEngine {
  load(source: WorldBundleSourceInput): Promise<VisualWorld>;
  setView(view: CameraView): void;
  streamAround(position: Vec3, radius?: number): void;
  setEntityTransform(id: EntityId, transform: Transform): void;
  setEntityState(id: EntityId, patch: VisualStatePatch): void;
  applyPatch(patch: WorldPatch): Promise<void>;
  update(frame: Omit<VisualFrame, 'view' | 'origin'>): void;
  subscribe(listener: (event: VisualWorldEvent) => void): () => void;
  dispose(): Promise<void>;
}
