import { describe, expect, it } from 'vitest';
import { FramePerformanceMonitor, ResourceBudget } from './performance.js';

describe('performance instrumentation', () => {
  it('computes p95 and reference-budget status', () => {
    const monitor = new FramePerformanceMonitor(100);
    for (let index = 0; index < 95; index += 1) monitor.record({ frameTimeMs: 16, mainThreadChunkTaskMs: 12, visibleInstances: 10_000, gpuMemoryBytes: 1_000_000_000 });
    for (let index = 0; index < 5; index += 1) monitor.record({ frameTimeMs: 20, mainThreadChunkTaskMs: 20, visibleInstances: 10_000, gpuMemoryBytes: 1_000_000_000 });
    expect(monitor.snapshot()).toMatchObject({ samples: 100, p95FrameTimeMs: 16, withinReferenceBudget: true, visibleInstances: 10_000 });
  });

  it('selects least-recently-used unpinned resources for eviction', () => {
    const budget = new ResourceBudget(100);
    budget.touch('pinned', 'geometry', 80, 0, true);
    budget.touch('old', 'texture', 40, 1);
    budget.touch('new', 'texture', 30, 2);
    expect(budget.evictionCandidates().map((resource) => resource.id)).toEqual(['old', 'new']);
  });
});
