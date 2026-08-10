import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VisualWorldBundleSchema } from '@worldengine/schema';
import { createReferenceBundle } from '@worldengine/terrain';
import { describe, expect, it } from 'vitest';
import { materializeBundleChunks, type BundleMaterializationProgress } from './bundle-materializer.js';
import { FileWorldStorage } from './storage.js';
import { validateBundleIntegrity, validateRuntimeChunk } from './validation.js';

describe('runtime bundle materialization', () => {
  it('writes validated chunks before returning exact content-hashed URI sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'worldengine-materialized-'));
    try {
      const source = createReferenceBundle(37);
      const bundle = VisualWorldBundleSchema.parse({ ...source, chunks: [source.chunks[0], source.chunks[17]] });
      const storage = new FileWorldStorage(directory);
      const progress: BundleMaterializationProgress[] = [];
      const materialized = await materializeBundleChunks(bundle, storage, { samples: 17, concurrency: 2, rowsPerTask: 4, onProgress: (event) => progress.push(event) });
      expect(materialized.terrainSamples).toBe(17);
      expect(materialized.chunks).toHaveLength(2);
      expect(progress.at(-1)).toMatchObject({ completed: 2, total: 2, bytesWritten: expect.any(Number) });
      expect(validateBundleIntegrity(materialized).issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      for (const entry of materialized.chunks) {
        if (entry.source.kind !== 'uri') throw new Error(`Expected materialized URI source for ${entry.id}`);
        expect(entry.source).toMatchObject({ kind: 'uri', uri: `chunks/${entry.coordinate.x}_${entry.coordinate.z}.json`, contentHash: expect.stringMatching(/^[a-f\d]{64}$/), byteLength: expect.any(Number) });
        const chunk = await storage.getChunk(materialized.worldId, materialized.bundleVersion, entry.coordinate.x, entry.coordinate.z);
        const serialized = JSON.stringify(chunk);
        expect(entry.source.contentHash).toBe(createHash('sha256').update(serialized).digest('hex'));
        expect(entry.source.byteLength).toBe(Buffer.byteLength(serialized));
        expect(entry.dependencies).toEqual(chunk.dependencies);
        expect(validateRuntimeChunk(materialized, chunk).filter((issue) => issue.severity === 'error')).toEqual([]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects unsafe worker settings before materialization', async () => {
    const bundle = createReferenceBundle(41);
    const storage = new FileWorldStorage(join(tmpdir(), 'worldengine-materializer-unused'));
    await expect(materializeBundleChunks(bundle, storage, { concurrency: 0 })).rejects.toThrow('concurrency');
  });
});
