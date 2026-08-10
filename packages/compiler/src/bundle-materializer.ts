import { createHash } from 'node:crypto';
import { VisualWorldBundleSchema, type VisualWorldBundle } from '@worldengine/schema';
import { generateReferenceChunkAsync } from '@worldengine/terrain';
import type { WorldStorage } from './storage.js';
import { validateRuntimeChunk } from './validation.js';

export interface BundleMaterializationProgress {
  completed: number;
  total: number;
  chunkId: string;
  bytesWritten: number;
}

export interface BundleMaterializationOptions {
  samples?: number;
  concurrency?: number;
  rowsPerTask?: number;
  onProgress?: (progress: BundleMaterializationProgress) => void;
}

/**
 * Writes every bounded manifest chunk before returning a manifest whose URI,
 * SHA-256, byte length, and dependency list describe those exact JSON bytes.
 * Callers publish the returned manifest only after this function succeeds.
 */
export async function materializeBundleChunks(
  input: VisualWorldBundle,
  storage: WorldStorage,
  options: BundleMaterializationOptions = {},
): Promise<VisualWorldBundle> {
  const bundle = VisualWorldBundleSchema.parse(input);
  const samples = options.samples ?? bundle.terrainSamples;
  const concurrency = options.concurrency ?? 2;
  const rowsPerTask = options.rowsPerTask ?? 8;
  if (!Number.isInteger(samples) || samples < 3) throw new Error('Materialized terrain samples must be an integer of at least three');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Materialization concurrency must be between one and sixteen');
  if (!Number.isInteger(rowsPerTask) || rowsPerTask < 1 || rowsPerTask > samples) throw new Error('Materialization rowsPerTask must be between one and the sample count');
  const chunks = new Array<VisualWorldBundle['chunks'][number]>(bundle.chunks.length);
  let nextIndex = 0;
  let completed = 0;
  let bytesWritten = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= bundle.chunks.length) return;
      const entry = bundle.chunks[index]!;
      const chunk = await generateReferenceChunkAsync(bundle, entry.coordinate, { samples, rowsPerTask });
      const errors = validateRuntimeChunk(bundle, chunk).filter((issue) => issue.severity === 'error');
      if (errors.length > 0) throw new Error(`Materialized chunk ${entry.id} failed validation: ${errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ')}`);
      const serialized = JSON.stringify(chunk);
      const byteLength = Buffer.byteLength(serialized);
      const contentHash = createHash('sha256').update(serialized).digest('hex');
      await storage.putChunk(bundle.worldId, bundle.bundleVersion, chunk);
      chunks[index] = {
        ...entry,
        source: { kind: 'uri', uri: `chunks/${entry.coordinate.x}_${entry.coordinate.z}.json`, contentHash, byteLength },
        dependencies: chunk.dependencies,
      };
      completed += 1;
      bytesWritten += byteLength;
      options.onProgress?.({ completed, total: bundle.chunks.length, chunkId: entry.id, bytesWritten });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, bundle.chunks.length)) }, worker));
  if (chunks.some((chunk) => chunk === undefined)) throw new Error('Bundle materialization completed without producing every chunk manifest entry');
  return VisualWorldBundleSchema.parse({ ...bundle, terrainSamples: samples, chunks });
}
