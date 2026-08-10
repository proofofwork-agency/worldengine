import { describe, expect, it, vi } from 'vitest';
import { EntityIdSchema, PatchIdSchema, type ChunkId, type WorldPatch } from '@worldengine/schema';
import { createReferenceBundle, generateReferenceChunk } from '@worldengine/terrain';
import type { RendererBackend, RuntimeChunk, WorldBundleSource } from './contracts.js';
import { DefaultVisualWorldEngine } from './engine.js';
import { ProceduralWorldBundleSource } from './source.js';

function backend(): RendererBackend & { chunks: Map<ChunkId, RuntimeChunk> } {
  const chunks = new Map<ChunkId, RuntimeChunk>();
  return {
    chunks,
    initialize: vi.fn(async () => undefined),
    loadChunk: vi.fn(async (chunk) => { chunks.set(chunk.id, chunk); }),
    unloadChunk: vi.fn((id) => { chunks.delete(id); }),
    applyVisualPatch: vi.fn(async () => undefined),
    render: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
}

const target = { canvas: {} as HTMLCanvasElement, width: 800, height: 600 };

async function eventually(check: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { check(); return; } catch (value) { error = value; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  throw error;
}

describe('DefaultVisualWorldEngine', () => {
  it('streams chunks and emits entity lifecycle events', async () => {
    const renderer = backend();
    const engine = new DefaultVisualWorldEngine(renderer, target);
    const events: string[] = [];
    engine.subscribe((event) => events.push(event.type));
    await engine.load(new ProceduralWorldBundleSource(createReferenceBundle(), 17));
    engine.streamAround([0, 0, 0], 200);
    await eventually(() => expect(renderer.chunks.size).toBeGreaterThan(0));
    expect([...renderer.chunks.values()][0]!.terrain.biomeWeights).toHaveLength(17 * 17);
    expect(events).toContain('chunk-loaded');
    expect(events).toContain('entity-available');
    await engine.dispose();
    expect(events).toContain('entity-disposed');
  });

  it('rejects conflicting patches', async () => {
    const engine = new DefaultVisualWorldEngine(backend(), target);
    const world = await engine.load(new ProceduralWorldBundleSource(createReferenceBundle(), 9));
    const patch: WorldPatch = {
      id: PatchIdSchema.parse('conflict'), worldId: world.manifest.worldId, baseRevision: 99,
      createdAt: new Date().toISOString(), author: 'test',
      operations: [{ op: 'set-visual-state', entityId: EntityIdSchema.parse('missing'), state: { visible: false } }],
    };
    await expect(engine.applyPatch(patch)).rejects.toThrow('expected revision 99');
    await engine.dispose();
  });

  it('rejects wrong-world and structural live patches before mutating the renderer', async () => {
    const renderer = backend();
    const engine = new DefaultVisualWorldEngine(renderer, target);
    const world = await engine.load(new ProceduralWorldBundleSource(createReferenceBundle(), 9));
    const base = {
      id: PatchIdSchema.parse('invalid-live-patch'), baseRevision: world.revision,
      createdAt: new Date().toISOString(), author: 'test',
    };
    await expect(engine.applyPatch({ ...base, worldId: 'another-world', operations: [{ op: 'set-environment', values: { weather: 'rain' } }] })).rejects.toThrow('another-world');
    await expect(engine.applyPatch({ ...base, worldId: world.manifest.worldId, operations: [{ op: 'remove-entity', entityId: EntityIdSchema.parse('entity-0-0-0') }] })).rejects.toThrow('new immutable bundle');
    expect(renderer.applyVisualPatch).not.toHaveBeenCalled();
    await engine.dispose();
  });

  it('streams a non-billable sparse placeholder beyond the reference boundary', async () => {
    const renderer = backend();
    const engine = new DefaultVisualWorldEngine(renderer, target);
    await engine.load(new ProceduralWorldBundleSource(createReferenceBundle(), 9));
    engine.streamAround([12 * 256, 0, -11 * 256], 80);
    await eventually(() => expect(renderer.chunks.size).toBeGreaterThan(0));
    const placeholders = [...renderer.chunks.values()].filter((chunk) => chunk.placeholder);
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders.every((chunk) => chunk.instances.length === 0 && chunk.terrain.samples === 33)).toBe(true);
    await engine.dispose();
  });

  it('forwards host-authoritative transform and visual-state changes', async () => {
    const renderer = backend();
    const engine = new DefaultVisualWorldEngine(renderer, target);
    await engine.load(new ProceduralWorldBundleSource(createReferenceBundle(), 9));
    engine.streamAround([0, 0, 0], 80);
    await eventually(() => expect(renderer.chunks.size).toBeGreaterThan(0));
    const entity = [...renderer.chunks.values()][0]!.instances[0]!;
    engine.setEntityTransform(entity.id, { position: [4, 5, 6], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    engine.setEntityState(entity.id, { visible: false, teamColor: '#ff0000', damage: 0.5 });
    expect(renderer.applyVisualPatch).toHaveBeenCalledTimes(2);
    expect(renderer.applyVisualPatch).toHaveBeenLastCalledWith(expect.objectContaining({ operations: [expect.objectContaining({ op: 'set-visual-state', entityId: entity.id })] }));
    await engine.dispose();
  });

  it('prioritizes nearby chunks and bounds concurrent chunk work', async () => {
    const manifest = createReferenceBundle();
    const calls: ChunkId[] = [];
    const releases: Array<() => void> = [];
    const source: WorldBundleSource = {
      async loadManifest() { return manifest; },
      loadChunk(id) {
        calls.push(id);
        const entry = manifest.chunks.find((chunk) => chunk.id === id)!;
        return new Promise((resolve) => releases.push(() => resolve(generateReferenceChunk(manifest, entry.coordinate, { samples: 9 }))));
      },
    };
    const engine = new DefaultVisualWorldEngine(backend(), target, 4_096, 2);
    await engine.load(source);
    engine.streamAround([0, 0, 0], 300);
    expect(calls).toHaveLength(2);
    expect(calls.every((id) => {
      const [x, z] = id.split(':').map(Number);
      return Math.hypot((x! + 0.5) * 256, (z! + 0.5) * 256) < 200;
    })).toBe(true);
    const disposing = engine.dispose();
    releases.forEach((release) => release());
    await disposing;
  });
});
