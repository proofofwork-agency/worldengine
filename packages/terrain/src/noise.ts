import { random01 } from './random.js';

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function valueNoise2(seed: number, x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smooth(x - x0);
  const tz = smooth(z - z0);
  const top = mix(random01(seed, x0, z0), random01(seed, x0 + 1, z0), tx);
  const bottom = mix(random01(seed, x0, z0 + 1), random01(seed, x0 + 1, z0 + 1), tx);
  return mix(top, bottom, tz) * 2 - 1;
}

export function fbm2(seed: number, x: number, z: number, octaves = 5): number {
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  let normalization = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise2(seed + octave * 1013, x * frequency, z * frequency) * amplitude;
    normalization += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / normalization;
}
