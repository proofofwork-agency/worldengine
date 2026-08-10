import { describe, expect, it } from 'vitest';
import { frameDeltaSeconds } from './frame-timing.js';

describe('editor frame timing', () => {
  it('survives a first animation-frame timestamp preceding performance.now', () => {
    expect(frameDeltaSeconds(10.2, 10.8)).toBe(0);
    expect(frameDeltaSeconds(26.8, 10.8)).toBeCloseTo(0.016, 6);
  });

  it('caps resumed or backgrounded frames', () => {
    expect(frameDeltaSeconds(5_000, 100)).toBe(0.1);
    expect(frameDeltaSeconds(Number.NaN, 100)).toBe(0);
  });
});
