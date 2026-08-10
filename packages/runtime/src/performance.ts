export interface FramePerformanceSample {
  frameTimeMs: number;
  mainThreadChunkTaskMs?: number;
  visibleInstances?: number;
  gpuMemoryBytes?: number;
}

export interface PerformanceSnapshot {
  samples: number;
  averageFrameTimeMs: number;
  p95FrameTimeMs: number;
  framesPerSecond: number;
  maxChunkTaskMs: number;
  visibleInstances: number;
  gpuMemoryBytes: number;
  withinReferenceBudget: boolean;
}

export class FramePerformanceMonitor {
  private readonly samples: FramePerformanceSample[] = [];

  constructor(private readonly capacity = 600) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Performance sample capacity must be positive');
  }

  record(sample: FramePerformanceSample): void {
    if (!Number.isFinite(sample.frameTimeMs) || sample.frameTimeMs < 0) throw new Error('Frame time must be finite and non-negative');
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
  }

  snapshot(): PerformanceSnapshot {
    if (this.samples.length === 0) return { samples: 0, averageFrameTimeMs: 0, p95FrameTimeMs: 0, framesPerSecond: 0, maxChunkTaskMs: 0, visibleInstances: 0, gpuMemoryBytes: 0, withinReferenceBudget: true };
    const frameTimes = this.samples.map((sample) => sample.frameTimeMs).sort((a, b) => a - b);
    const averageFrameTimeMs = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
    const p95FrameTimeMs = frameTimes[Math.min(frameTimes.length - 1, Math.ceil(frameTimes.length * 0.95) - 1)]!;
    const maxChunkTaskMs = Math.max(...this.samples.map((sample) => sample.mainThreadChunkTaskMs ?? 0));
    const latest = this.samples[this.samples.length - 1]!;
    const gpuMemoryBytes = latest.gpuMemoryBytes ?? 0;
    return {
      samples: this.samples.length, averageFrameTimeMs, p95FrameTimeMs,
      framesPerSecond: averageFrameTimeMs === 0 ? 0 : 1000 / averageFrameTimeMs,
      maxChunkTaskMs, visibleInstances: latest.visibleInstances ?? 0, gpuMemoryBytes,
      withinReferenceBudget: p95FrameTimeMs <= 16.7 && maxChunkTaskMs <= 50 && gpuMemoryBytes <= 1.5 * 1024 ** 3,
    };
  }
}

export type ResourceKind = 'geometry' | 'texture' | 'animation' | 'other';
export interface ResourceRecord { id: string; kind: ResourceKind; bytes: number; lastUsedFrame: number; pinned: boolean }

export class ResourceBudget {
  private readonly resources = new Map<string, ResourceRecord>();

  constructor(readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Resource budget must be positive');
  }

  touch(id: string, kind: ResourceKind, bytes: number, frame: number, pinned = false): void {
    if (bytes < 0 || !Number.isFinite(bytes)) throw new Error('Resource bytes must be finite and non-negative');
    this.resources.set(id, { id, kind, bytes, lastUsedFrame: frame, pinned });
  }

  remove(id: string): void { this.resources.delete(id); }
  get usedBytes(): number { return [...this.resources.values()].reduce((sum, resource) => sum + resource.bytes, 0); }

  evictionCandidates(): ResourceRecord[] {
    let excess = this.usedBytes - this.maxBytes;
    if (excess <= 0) return [];
    const selected: ResourceRecord[] = [];
    for (const resource of [...this.resources.values()].filter((item) => !item.pinned).sort((a, b) => a.lastUsedFrame - b.lastUsedFrame || b.bytes - a.bytes)) {
      selected.push(resource);
      excess -= resource.bytes;
      if (excess <= 0) break;
    }
    return selected;
  }
}
