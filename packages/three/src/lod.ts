export interface TerrainLodRange { distance: number; start: number; count: number; samples: number }
export interface TerrainLodIndexPlan { indices: number[]; levels: TerrainLodRange[] }

export function buildTerrainLodIndexPlan(samples: number, requestedSamples: readonly number[], chunkSize: number): TerrainLodIndexPlan {
  if (!Number.isInteger(samples) || samples < 3) throw new Error('Terrain samples must be an integer of at least three');
  const targets = [...new Set(requestedSamples.filter((target) => Number.isInteger(target) && target >= 3 && target <= samples && (samples - 1) % (target - 1) === 0))].sort((a, b) => b - a);
  if (targets.length === 0) targets.push(samples);
  const indices: number[] = [];
  const levels = targets.map((target, level) => {
    const start = indices.length;
    const step = (samples - 1) / (target - 1);
    for (let z = 0; z < samples - 1; z += step) for (let x = 0; x < samples - 1; x += step) {
      const a = z * samples + x;
      const b = a + step;
      const c = (z + step) * samples + x;
      const d = c + step;
      indices.push(a, c, b, b, c, d);
    }
    return { distance: level * chunkSize * 2.25, start, count: indices.length - start, samples: target };
  });
  return { indices, levels };
}

export function selectDistanceLod(distances: readonly number[], distance: number): number {
  let selected = 0;
  for (let index = 1; index < distances.length; index += 1) if (distance >= distances[index]!) selected = index;
  return selected;
}
