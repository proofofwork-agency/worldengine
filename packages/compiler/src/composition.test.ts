import { describe, expect, it } from 'vitest';
import { PatchIdSchema, RegionIdSchema } from '@worldengine/schema';
import { placeObjectFromComposition, rasterizeRegions, referenceCamerasForRegion, validateVisualReviewPatch } from './composition.js';

const region = {
  id: RegionIdSchema.parse('square'), name: 'Square', description: '', polygon: [[-50,-50],[50,-50],[50,50],[-50,50]] as [number, number][],
  adjacentTo: [], biome: 'test', elevation: { min: 0, max: 20 }, density: 0.5,
};

describe('regional composition', () => {
  it('rasterizes canonical polygons deterministically', () => {
    const first = rasterizeRegions([region], { min: [-100, -100], max: [100, 100] }, 20, 20);
    const second = rasterizeRegions([region], { min: [-100, -100], max: [100, 100] }, 20, 20);
    expect(first.values).toEqual(second.values);
    expect([...first.values].filter(Boolean)).toHaveLength(100);
  });

  it('reverse-projects a screen object onto terrain contact', () => {
    const camera = { ...referenceCamerasForRegion(region, 1)[0]!, position: [0, 100, 100] as [number,number,number], target: [0, 0, 0] as [number,number,number] };
    const transform = placeObjectFromComposition({ id: 'tree', assetClass: 'tree', description: 'tree', screenBox: { x: 700, y: 350, width: 136, height: 160 }, desiredHeightMeters: 8, tags: [] }, camera, () => 0);
    expect(transform.position[1]).toBe(0);
    expect(transform.scale[0]).toBeGreaterThan(0);
  });

  it('accepts only revision-matched visual-only review patches', () => {
    const valid = { id: PatchIdSchema.parse('review-1'), worldId: 'world', baseRevision: 2, createdAt: new Date().toISOString(), author: 'reviewer', operations: [{ op: 'set-environment' as const, values: { fogDensity: 0.001 } }] };
    expect(validateVisualReviewPatch(valid, 'world', 2)).toEqual(valid);
    expect(() => validateVisualReviewPatch({ ...valid, baseRevision: 1 }, 'world', 2)).toThrow('stale');
    const structural = { ...valid, id: PatchIdSchema.parse('review-structural'), baseRevision: 2, operations: [{ op: 'invalidate-chunk' as const, chunkId: '0:0' }] };
    expect(() => validateVisualReviewPatch(structural, 'world', 2)).toThrow('may only adjust');
  });
});
