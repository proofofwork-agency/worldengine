import { Accessor, Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import { validateGlb } from './asset-validation.js';
import { generateMeshLods } from './asset-optimizer.js';

async function gridGlb(segments = 24): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = new Float32Array((segments + 1) * (segments + 1) * 3);
  for (let z = 0; z <= segments; z += 1) for (let x = 0; x <= segments; x += 1) {
    const index = (z * (segments + 1) + x) * 3;
    positions[index] = x; positions[index + 1] = Math.sin(x * 0.45) * Math.cos(z * 0.4) * 0.2; positions[index + 2] = z;
  }
  const indices = new Uint32Array(segments * segments * 6);
  let offset = 0;
  for (let z = 0; z < segments; z += 1) for (let x = 0; x < segments; x += 1) {
    const a = z * (segments + 1) + x; const b = a + 1; const c = a + segments + 1; const d = c + 1;
    indices.set([a, c, b, b, c, d], offset); offset += 6;
  }
  const position = document.createAccessor('position').setType(Accessor.Type.VEC3!).setArray(positions).setBuffer(buffer);
  const index = document.createAccessor('indices').setType(Accessor.Type.SCALAR!).setArray(indices).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute('POSITION', position).setIndices(index);
  const mesh = document.createMesh('grid').addPrimitive(primitive);
  const node = document.createNode('grid').setMesh(mesh);
  document.createScene('scene').addChild(node);
  return new NodeIO().writeBinary(document);
}

describe('generated mesh optimization', () => {
  it('creates independently validated, strictly decreasing GLB LODs', async () => {
    const source = await gridGlb();
    const levels = await generateMeshLods(source, { ratios: [0.5, 0.2], errors: [1, 1] });
    expect(levels).toHaveLength(2);
    expect(levels[0]!.renderVertices).toBeLessThan(levels[0]!.sourceRenderVertices);
    expect(levels[1]!.renderVertices).toBeLessThan(levels[0]!.renderVertices);
    expect(levels.every((level) => validateGlb(level.bytes).length === 0)).toBe(true);
  });

  it('rejects invalid or non-decreasing optimization settings', async () => {
    const source = await gridGlb(4);
    await expect(generateMeshLods(source, { ratios: [0.2, 0.5], errors: [0.01, 0.01] })).rejects.toThrow('strictly decreasing');
  });
});
