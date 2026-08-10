import { describe, expect, it } from 'vitest';
import { buildTerrainLodIndexPlan, selectDistanceLod } from './lod.js';

describe('distance LOD planning', () => {
  it('builds compact draw ranges for canonical terrain resolutions', () => {
    const plan = buildTerrainLodIndexPlan(257, [65, 33, 17], 256);
    expect(plan.levels.map((level) => level.samples)).toEqual([65, 33, 17]);
    expect(plan.levels.map((level) => level.count)).toEqual([64 * 64 * 6, 32 * 32 * 6, 16 * 16 * 6]);
    expect(plan.indices.length).toBe(plan.levels.reduce((sum, level) => sum + level.count, 0));
    expect(Math.max(...plan.indices)).toBeLessThan(257 * 257);
  });

  it('selects the furthest crossed threshold deterministically', () => {
    expect(selectDistanceLod([0, 80, 220], 79)).toBe(0);
    expect(selectDistanceLod([0, 80, 220], 80)).toBe(1);
    expect(selectDistanceLod([0, 80, 220], 900)).toBe(2);
  });
});
