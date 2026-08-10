import { describe, expect, it } from 'vitest';
import { createReferenceBundle, generateChunkTerrain, generateReferenceChunk, generateReferenceChunkAsync, REFERENCE_TERRAIN, sampleWorldHeight, sha256Hex } from './index.js';

describe('deterministic terrain', () => {
  it('produces standards-compatible deterministic SHA-256 recipe IDs', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('generates identical output for identical input', () => {
    const options = { coordinate: { x: -2, z: 4 }, chunkSize: 256, samples: 17, source: REFERENCE_TERRAIN };
    expect(generateChunkTerrain(options).heights).toEqual(generateChunkTerrain(options).heights);
  });

  it('shares exact border samples between adjacent chunks', () => {
    const left = generateChunkTerrain({ coordinate: { x: 0, z: 0 }, chunkSize: 256, samples: 17, source: REFERENCE_TERRAIN });
    const right = generateChunkTerrain({ coordinate: { x: 1, z: 0 }, chunkSize: 256, samples: 17, source: REFERENCE_TERRAIN });
    for (let z = 0; z < 17; z += 1) expect(left.heights[z * 17 + 16]).toBe(right.heights[z * 17]);
  });

  it('places every reference instance on the deterministic terrain', () => {
    const bundle = createReferenceBundle();
    const chunk = generateReferenceChunk(bundle, { x: 0, z: 0 }, { samples: 17 });
    for (const instance of chunk.instances) {
      expect(instance.matrix[13]).toBeCloseTo(sampleWorldHeight(bundle, instance.matrix[12], instance.matrix[14]), 5);
    }
  });

  it('meets the complete 4 km reference-world acceptance fixture', () => {
    const bundle = createReferenceBundle();
    expect(bundle.chunks).toHaveLength(256);
    expect(bundle.prototypes).toHaveLength(20);
    let instances = 0;
    for (const entry of bundle.chunks) {
      const chunk = generateReferenceChunk(bundle, entry.coordinate, { samples: 17 });
      expect(chunk.id).toBe(entry.id);
      expect(chunk.placeholder).toBe(false);
      instances += chunk.instances.length;
      for (const instance of chunk.instances) {
        expect(instance.matrix[13]).toBeCloseTo(sampleWorldHeight(bundle, instance.matrix[12], instance.matrix[14]), 5);
      }
    }
    expect(instances).toBe(5_120);
  });

  it('uses semantic landmark overrides and keeps settlement scatter route-weighted', () => {
    const bundle = createReferenceBundle();
    const kindByPrototype = new Map(bundle.prototypes.map((prototype) => [prototype.id, prototype.tags[0]]));
    expect(bundle.authoredInstances.map((instance) => [instance.visualState['landmarkId'], kindByPrototype.get(instance.prototypeId)])).toEqual([
      ['sunken-ruin', 'ruin-wall'], ['east-watch', 'watchtower'], ['old-bridge', 'bridge'],
    ]);
    for (const landmark of bundle.authoredInstances) expect(landmark.matrix[13]).toBeCloseTo(sampleWorldHeight(bundle, landmark.matrix[12], landmark.matrix[14]), 5);
    const settlement = generateReferenceChunk(bundle, { x: 3, z: 0 }, { samples: 3 });
    const kinds = settlement.instances.map((instance) => kindByPrototype.get(instance.prototypeId));
    expect(kinds.filter((kind) => kind === 'wildflower').length).toBeGreaterThan(kinds.filter((kind) => ['cottage', 'market-stall', 'windmill'].includes(kind ?? '')).length);
    expect(kinds).not.toContain('boat');
  });

  it('applies deterministic regional density without changing stable existing IDs', () => {
    const bundle = createReferenceBundle();
    const baseline = generateReferenceChunk(bundle, { x: 0, z: 0 }, { samples: 9 });
    const denser = generateReferenceChunk(bundle, { x: 0, z: 0 }, { samples: 9, regionDensities: { wetlands: 1 } });
    expect(denser.instances.length).toBeGreaterThan(baseline.instances.length);
    expect(denser.instances.slice(0, baseline.instances.length).map((instance) => instance.id)).toEqual(baseline.instances.map((instance) => instance.id));
  });

  it('emits biome splats, feature-conditioned terrain, dependencies, and occlusion cells', () => {
    const bundle = createReferenceBundle();
    const chunk = generateReferenceChunk(bundle, { x: 0, z: 0 }, { samples: 17 });
    expect(chunk.terrain.biomeWeights).toBeTruthy();
    expect(atob(chunk.terrain.biomeWeights!).length).toBe(17 * 17);
    expect(chunk.dependencies.length).toBeGreaterThan(0);
    expect(chunk.occlusionCells).toHaveLength(16);
    expect(chunk.occlusionCells.flatMap((cell) => cell.instanceIds).sort()).toEqual(chunk.instances.map((instance) => instance.id).sort());
    const river = bundle.features.find((feature) => feature.kind === 'river')!;
    const point = river.points[3]!;
    const withoutFeatures = { ...bundle, features: [] };
    expect(sampleWorldHeight(bundle, point[0], point[1])).toBeLessThan(sampleWorldHeight(withoutFeatures, point[0], point[1]));
  });

  it('cooperatively generates canonical terrain without changing its deterministic artifact', async () => {
    const bundle = createReferenceBundle();
    const coordinate = { x: 1, z: -2 };
    let yields = 0;
    const cooperative = await generateReferenceChunkAsync(bundle, coordinate, {
      rowsPerTask: 8,
      yieldControl: async () => { yields += 1; },
    });
    const synchronous = generateReferenceChunk(bundle, coordinate);
    expect(cooperative).toEqual(synchronous);
    expect(yields).toBe(32);
  });
});
