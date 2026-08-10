import { Accessor, Document, NodeIO } from '@gltf-transform/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { renderGlbDiagnostic } from './asset-diagnostic.js';

async function coloredCubeGlb(sceneVisible = true): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
    0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]);
  const position = document.createAccessor('cube-position').setType(Accessor.Type.VEC3!).setArray(positions).setBuffer(buffer);
  const index = document.createAccessor('cube-index').setType(Accessor.Type.SCALAR!).setArray(indices).setBuffer(buffer);
  const warm = document.createMaterial('warm').setBaseColorFactor([0.9, 0.32, 0.15, 1]);
  const cool = document.createMaterial('cool').setBaseColorFactor([0.1, 0.55, 0.95, 1]);
  const first = document.createMesh('first').addPrimitive(document.createPrimitive().setAttribute('POSITION', position).setIndices(index).setMaterial(warm));
  const second = document.createMesh('second').addPrimitive(document.createPrimitive().setAttribute('POSITION', position).setIndices(index).setMaterial(cool));
  const firstNode = document.createNode('first').setMesh(first).setTranslation([-1.2, 0, 0]);
  const secondNode = document.createNode('second').setMesh(second).setTranslation([1.2, 0.35, 0]).setScale([0.65, 1.1, 0.65]);
  if (sceneVisible) document.createScene('diagnostic-scene').addChild(firstNode).addChild(secondNode);
  return new NodeIO().writeBinary(document);
}

describe('GLB diagnostic rendering', () => {
  it('renders deterministic two-view evidence from all scene mesh parts and transforms', async () => {
    const glb = await coloredCubeGlb();
    const first = await renderGlbDiagnostic(glb, { width: 640, height: 320 });
    const second = await renderGlbDiagnostic(glb, { width: 640, height: 320 });
    expect(first).toMatchObject({ inputTriangles: 24, renderedTriangles: 24, views: 2 });
    expect(first.bytes).toEqual(second.bytes);
    expect([...first.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await expect(sharp(first.bytes).metadata()).resolves.toMatchObject({ format: 'png', width: 640, height: 320, channels: 4 });
    const { data } = await sharp(first.bytes).raw().toBuffer({ resolveWithObject: true });
    const warmPixels = Array.from({ length: data.length / 4 }, (_, index) => index * 4).filter((offset) => data[offset]! > data[offset + 2]! * 1.35).length;
    const coolPixels = Array.from({ length: data.length / 4 }, (_, index) => index * 4).filter((offset) => data[offset + 2]! > data[offset]! * 1.35).length;
    expect(warmPixels).toBeGreaterThan(100);
    expect(coolPixels).toBeGreaterThan(100);
  });

  it('fails closed when a GLB has meshes but no scene-visible geometry', async () => {
    await expect(renderGlbDiagnostic(await coloredCubeGlb(false), { width: 512, height: 256 })).rejects.toThrow('scene-visible triangle geometry');
  });
});
