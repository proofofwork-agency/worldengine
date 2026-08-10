import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createLosslessAlphaCrop, mapAffinePoint } from './composition-artifacts.js';

describe('composition object crops', () => {
  it('creates a lossless alpha crop with an invertible composition affine', async () => {
    const image = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } } }).png().toBuffer();
    const maskPixels = new Uint8Array(100); for (let y = 3; y < 7; y += 1) for (let x = 2; x < 6; x += 1) maskPixels[y * 10 + x] = 255;
    const mask = await sharp(maskPixels, { raw: { width: 10, height: 10, channels: 1 } }).png().toBuffer();
    const crop = await createLosslessAlphaCrop(image, mask, { x: 2, y: 3, width: 4, height: 4 }, 10, 10);
    expect(crop.transform.sourceBox).toEqual({ x: 1, y: 2, width: 6, height: 6 });
    const cropPoint = mapAffinePoint(crop.transform.compositionToCrop, [4, 5]);
    expect(cropPoint).toEqual([3, 3]);
    expect(mapAffinePoint(crop.transform.cropToComposition, cropPoint)).toEqual([4, 5]);
    const decoded = await sharp(crop.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject({ width: 6, height: 6, channels: 4 });
    const alpha = [...decoded.data.filter((_value, index) => index % 4 === 3)];
    expect(alpha).toContain(0); expect(alpha).toContain(255);
  });
});
