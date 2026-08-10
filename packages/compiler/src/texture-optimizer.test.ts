import { Accessor, Document, NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { validateGlb, validateKtx2 } from './asset-validation.js';
import { transcodeGlbTexturesToKtx2, transcodeTextureToKtx2 } from './texture-optimizer.js';

async function texturedTriangleGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor().setType(Accessor.Type.VEC3!).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const texcoords = document.createAccessor().setType(Accessor.Type.VEC2!).setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer);
  const indices = document.createAccessor().setType(Accessor.Type.SCALAR!).setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer);
  const pixels = new Uint8Array(16 * 16 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = (index / 4) % 16 * 16;
    pixels[index + 1] = Math.floor(index / 64) * 16;
    pixels[index + 2] = 128;
    pixels[index + 3] = 255;
  }
  const png = await sharp(pixels, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
  const texture = document.createTexture('albedo').setImage(Uint8Array.from(png)).setMimeType('image/png');
  const material = document.createMaterial('pbr').setBaseColorTexture(texture);
  const primitive = document.createPrimitive().setAttribute('POSITION', positions).setAttribute('TEXCOORD_0', texcoords).setIndices(indices).setMaterial(material);
  document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));
  return new NodeIO().writeBinary(document);
}

describe('KTX2 texture optimization', () => {
  it('transcodes a standalone terrain channel to validated KTX2', async () => {
    const source = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 90, g: 120, b: 70, alpha: 1 } } }).png().toBuffer();
    const encoded = await transcodeTextureToKtx2(Uint8Array.from(source), { maxDimension: 64, perceptual: true, uastcQuality: 1 });
    expect(validateKtx2(encoded)).toEqual([]);
  });

  it('transcodes embedded PBR images to validated mipmapped Basis KTX2', async () => {
    const source = await texturedTriangleGlb();
    const optimized = await transcodeGlbTexturesToKtx2(source, { maxDimension: 64, uastcQuality: 1 });
    expect(optimized).toMatchObject({ textureFormat: 'ktx2', textureCount: 1, convertedTextures: 1 });
    expect(validateGlb(optimized.bytes)).toEqual([]);
    const document = await new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).readBinary(optimized.bytes);
    const texture = document.getRoot().listTextures()[0]!;
    expect(texture.getMimeType()).toBe('image/ktx2');
    expect(validateKtx2(texture.getImage()!)).toEqual([]);
  });

  it('leaves textureless GLBs byte-identical', async () => {
    const document = new Document(); const buffer = document.createBuffer();
    const positions = document.createAccessor().setType(Accessor.Type.VEC3!).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
    document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(document.createPrimitive().setAttribute('POSITION', positions))));
    const source = await new NodeIO().writeBinary(document);
    const optimized = await transcodeGlbTexturesToKtx2(source);
    expect(optimized.textureFormat).toBe('none');
    expect(optimized.bytes).toBe(source);
  });
});
