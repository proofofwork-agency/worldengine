import type { ChunkCoordinate, TerrainSource } from '@worldengine/schema';
import { fbm2 } from './noise.js';

export interface TerrainGenerationOptions {
  coordinate: ChunkCoordinate;
  chunkSize: number;
  samples: number;
  source: Extract<TerrainSource, { kind: 'procedural' }>;
}

export interface GeneratedTerrain {
  heights: Float32Array;
  minHeight: number;
  maxHeight: number;
}

export function sampleTerrainHeight(source: Extract<TerrainSource, { kind: 'procedural' }>, worldX: number, worldZ: number): number {
  const broad = fbm2(source.seed, worldX * source.frequency, worldZ * source.frequency, 5);
  const detail = fbm2(source.seed ^ 0xa5a5a5a5, worldX * source.frequency * 3.7, worldZ * source.frequency * 3.7, 3);
  let height = (broad * 0.82 + detail * 0.18) * source.amplitude;
  for (const edit of source.edits) {
    const distance = Math.hypot(worldX - edit.center[0], worldZ - edit.center[1]);
    if (distance < edit.radius) {
      const falloff = 0.5 + 0.5 * Math.cos(Math.PI * distance / edit.radius);
      if (edit.mode === 'flatten') height += (edit.targetHeight! - height) * falloff;
      else if (edit.mode === 'smooth') height += (edit.targetHeight! - height) * falloff * 0.5;
      else height += edit.delta * falloff;
    }
  }
  return height;
}

export function generateChunkTerrain(options: TerrainGenerationOptions): GeneratedTerrain {
  const { coordinate, chunkSize, samples, source } = options;
  const heights = new Float32Array(samples * samples);
  const spacing = chunkSize / (samples - 1);
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = Number.NEGATIVE_INFINITY;
  for (let z = 0; z < samples; z += 1) {
    const worldZ = coordinate.z * chunkSize + z * spacing;
    for (let x = 0; x < samples; x += 1) {
      const worldX = coordinate.x * chunkSize + x * spacing;
      const height = sampleTerrainHeight(source, worldX, worldZ);
      heights[z * samples + x] = height;
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
    }
  }
  return { heights, minHeight, maxHeight };
}
