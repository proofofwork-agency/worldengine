import { describe, expect, it } from 'vitest';
import { PatchIdSchema, RegionIdSchema } from '@worldengine/schema';
import { measureCompositionPreservation, placeObjectFromComposition, rasterizeRegions, referenceCamerasForRegion, silhouetteFitMetrics, terrainContactMeasurement, validateVisualReviewPatch } from './composition.js';

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

  it('enforces composition, silhouette, camera and terrain-contact thresholds', () => {
    const source = new Uint8Array(4 * 4 * 4).fill(120); const candidate = new Uint8Array(source);
    for (let channel = 0; channel < 3; channel += 1) candidate[(1 * 4 + 1) * 4 + channel] = 255;
    const terrainMask = new Uint8Array(16).fill(255);
    expect(measureCompositionPreservation({ sourceRgba: source, candidateRgba: candidate, width: 4, height: 4, objectBoxes: [{ x: 1, y: 1, width: 1, height: 1 }], sourceTerrainMask: terrainMask, candidateTerrainMask: terrainMask, sourceLandmarks: [[1, 1]], candidateLandmarks: [[5, 1]] })).toMatchObject({ passed: true, structuralSimilarityOutsideObjects: 1, terrainMaskOverlap: 1, cameraLandmarkDriftPixels: 4 });
    expect(measureCompositionPreservation({ sourceRgba: source, candidateRgba: candidate, width: 4, height: 4, sourceLandmarks: [[1, 1]], candidateLandmarks: [[10, 1]] }).passed).toBe(false);
    const silhouette = new Uint8Array(16); silhouette.set([255, 255], 5);
    expect(silhouetteFitMetrics(silhouette, new Uint8Array(silhouette), 4, 4)).toMatchObject({ iou: 1, centerErrorPixels: 0, passed: true });
    expect(terrainContactMeasurement([[0, 0.019, 0]], () => 0, false).passed).toBe(true);
    expect(terrainContactMeasurement([[0, 0.03, 0]], () => 0, false).passed).toBe(false);
    expect(terrainContactMeasurement([[0, 0.049, 0]], () => 0, true).passed).toBe(true);
  });
});
