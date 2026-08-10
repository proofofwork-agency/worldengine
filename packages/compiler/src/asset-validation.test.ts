import { describe, expect, it } from 'vitest';
import { isSafeAssetUri, validateGlb, validateKtx2 } from './asset-validation.js';

function glb(document: unknown, binary = new Uint8Array()): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(document));
  const paddedLength = Math.ceil(text.length / 4) * 4;
  const binaryLength = Math.ceil(binary.length / 4) * 4;
  const bytes = new Uint8Array(20 + paddedLength + (binaryLength > 0 ? 8 + binaryLength : 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, paddedLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20); bytes.set(text, 20);
  if (binaryLength > 0) {
    const offset = 20 + paddedLength;
    view.setUint32(offset, binaryLength, true); view.setUint32(offset + 4, 0x004e4942, true);
    bytes.set(binary, offset + 8);
  }
  return bytes;
}

function triangleGlb(): Uint8Array {
  const positions = new Uint8Array(36);
  const view = new DataView(positions.buffer);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => view.setFloat32(index * 4, value, true));
  return glb({ asset: { version: '2.0' }, buffers: [{ byteLength: positions.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 }, positions);
}

describe('asset ingestion validation', () => {
  it('accepts a minimal glTF 2.0 GLB', () => {
    expect(validateGlb(triangleGlb())).toEqual([]);
  });

  it('rejects unsafe external references', () => {
    expect(validateGlb(glb({ asset: { version: '2.0' }, images: [{ uri: '../../secret.png' }] })).map((issue) => issue.code)).toContain('GLTF_UNSAFE_URI');
    expect(validateGlb(glb({ asset: { version: '2.0' }, images: [{ uri: 'javascript:alert(1)' }] })).map((issue) => issue.code)).toContain('GLTF_UNSAFE_URI');
    expect(isSafeAssetUri('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isSafeAssetUri('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isSafeAssetUri('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });

  it('rejects otherwise safe external resources that are not covered by the GLB hash', () => {
    const issues = validateGlb(glb({ asset: { version: '2.0' }, images: [{ uri: 'https://cdn.example/texture.png' }], buffers: [{ byteLength: 36, uri: 'geometry.bin' }] }));
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['GLTF_EXTERNAL_URI', 'GLTF_MESH_MISSING']));
    expect(issues.filter((issue) => issue.code === 'GLTF_EXTERNAL_URI')).toHaveLength(2);
  });

  it('requires a complete KTX2 container after recognizing the identifier', () => {
    expect(validateKtx2(new Uint8Array([0xab,0x4b,0x54,0x58,0x20,0x32,0x30,0xbb,0x0d,0x0a,0x1a,0x0a])).map((issue) => issue.code)).toContain('KTX2_STRUCTURE');
    expect(validateKtx2(new Uint8Array(12))).toHaveLength(1);
  });
});
