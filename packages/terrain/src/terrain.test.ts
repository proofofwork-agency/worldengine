import { describe, expect, it } from 'vitest';
import { RegionSpecSchema, TerrainPlanSchema } from '@worldengine/schema';
import { coDeformHeightfield, compileTerrainPlanChunk, createReferenceBundle, evaluateLandformOperator, generateChunkTerrain, generateReferenceChunk, generateReferenceChunkAsync, maximumHeightfieldSeamError, REFERENCE_SCATTER_INSTANCES_PER_CHUNK, REFERENCE_TERRAIN, sampleWorldHeight, sha256Hex } from './index.js';

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

  it('compiles every landform operator with exact world-space seams and normalized splats', () => {
    const region = RegionSpecSchema.parse({ id: 'planned', name: 'Planned', description: '', polygon: [[-512, -512], [512, -512], [512, 512], [-512, 512]], adjacentTo: [], biome: 'highland', elevation: { min: -20, max: 180 }, density: 0.5 });
    const kinds = ['ridge', 'peak', 'dune', 'terrace', 'erosion', 'riverbed', 'plateau'] as const;
    const operators = kinds.map((kind, index) => ({ kind, strength: 0.3, scaleMeters: 160 + index * 20, octaves: 3, offset: [index * 13, -index * 17] as [number, number], ...(kind === 'terrace' ? { terraceSteps: 8 } : {}) }));
    const plan = TerrainPlanSchema.parse({ maskBlendMeters: 64, regions: [{ regionId: region.id, operators, materialSetIds: ['rock'] }], materialSets: [{ id: 'rock', name: 'Rock', biome: 'highland', baseColorUri: 'terrain/rock-base.png', normalUri: 'terrain/rock-normal.png', roughnessUri: 'terrain/rock-rough.png', macroVariationUri: 'terrain/rock-macro.png', metersPerTile: 4 }] });
    expect(operators.map((operator) => evaluateLandformOperator(operator, 7, 21, -13)).every(Number.isFinite)).toBe(true);
    const options = { plan, regions: [region], seed: 7, chunkSize: 256, samples: 17, fallbackHeight: () => 0 };
    const left = compileTerrainPlanChunk({ ...options, coordinate: { x: 0, z: 0 } });
    const right = compileTerrainPlanChunk({ ...options, coordinate: { x: 1, z: 0 } });
    expect(maximumHeightfieldSeamError(left.heights, right.heights, 17, 'x')).toBe(0);
    expect(left.splats[0]!.weights.every((weight) => weight === 255)).toBe(true);
  });

  it('limits mesh-footprint co-deformation to the five-meter falloff', () => {
    const source = new Float32Array(11 * 11);
    const result = coDeformHeightfield({ heights: source, samples: 11, origin: [-6, -6], sizeMeters: 12, refinement: { footprint: [[-1, -1], [1, -1], [1, 1], [-1, 1]], targetHeight: 10, mode: 'flatten', supportMarginMeters: 2, falloffEndMeters: 5 } });
    expect(result[5 * 11 + 5]).toBe(10);
    expect(result[0]).toBe(0);
    expect(result[5 * 11]).toBe(0);
    expect(source.every((height) => height === 0)).toBe(true);
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
    expect(instances).toBeGreaterThanOrEqual(REFERENCE_SCATTER_INSTANCES_PER_CHUNK * 256);
  });

  it('uses semantic landmark overrides and keeps settlement scatter route-weighted', () => {
    const bundle = createReferenceBundle();
    const kindByPrototype = new Map(bundle.prototypes.map((prototype) => [prototype.id, prototype.tags[0]]));
    expect(bundle.authoredInstances.filter((instance) => instance.visualState['landmark'] === true).map((instance) => [instance.visualState['landmarkId'], kindByPrototype.get(instance.prototypeId)])).toEqual([
      ['sunken-ruin', 'ruin-wall'], ['east-watch', 'watchtower'], ['old-bridge', 'bridge'],
    ]);
    for (const landmark of bundle.authoredInstances.filter((instance) => instance.visualState['landmark'] === true)) expect(landmark.matrix[13]).toBeCloseTo(sampleWorldHeight(bundle, landmark.matrix[12], landmark.matrix[14]), 5);
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
    const baselineScatterIds = baseline.instances.filter((instance) => instance.visualState['semanticPlacement'] === true).map((instance) => instance.id);
    expect(denser.instances.filter((instance) => instance.visualState['semanticPlacement'] === true).slice(0, baselineScatterIds.length).map((instance) => instance.id)).toEqual(baselineScatterIds);
    expect(baseline.instances.filter((instance) => instance.visualState['authored'] === true).map((instance) => instance.id).every((id) => denser.instances.some((instance) => instance.id === id))).toBe(true);
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
