import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { ChunkIdSchema, EntityIdSchema, PrototypeIdSchema, VisualWorldBundleSchema } from '@worldengine/schema';
import { createReferenceBundle } from '@worldengine/terrain';
import type { RuntimeChunk } from '@worldengine/runtime';
import { ThreeRendererBackend } from './backend.js';

function chunkWithUnknownPrototype(): RuntimeChunk {
  return {
    format: 'RuntimeChunk',
    version: '1.1.0',
    id: ChunkIdSchema.parse('0:0'),
    coordinate: { x: 0, z: 0 },
    bounds: { min: [0, 0], max: [256, 256] },
    terrain: { samples: 3, heights: new Float32Array(9), minHeight: 0, maxHeight: 0 },
    instances: [{
      id: EntityIdSchema.parse('unknown-instance'),
      prototypeId: PrototypeIdSchema.parse('prototype-does-not-exist'),
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 32, 0, 32, 1],
      visualState: {},
    }],
    dependencies: [],
    occlusionCells: [],
    placeholder: false,
  };
}

function floatBytes(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function uint16Bytes(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return bytes;
}

function skeletalGlb(): Uint8Array {
  const binary: number[] = [];
  const push = (bytes: Uint8Array): { byteOffset: number; byteLength: number } => {
    while (binary.length % 4 !== 0) binary.push(0);
    const byteOffset = binary.length;
    binary.push(...bytes);
    return { byteOffset, byteLength: bytes.byteLength };
  };
  const views = [
    push(floatBytes([0, 0, 0, 1, 0, 0, 0, 1, 0])),
    push(uint16Bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    push(floatBytes([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])),
    push(uint16Bytes([0, 1, 2])),
    push(floatBytes([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])),
    push(floatBytes([0, 1])),
    push(floatBytes([0, 0, 0, 0, 0.25, 0])),
  ];
  while (binary.length % 4 !== 0) binary.push(0);
  const document = {
    asset: { version: '2.0', generator: 'worldengine-test' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'AnimatedMesh', mesh: 0, skin: 0 }, { name: 'RootBone' }],
    skins: [{ inverseBindMatrices: 4, skeleton: 1, joints: [1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, indices: 3 }] }],
    animations: [{ name: 'Wave', samplers: [{ input: 5, output: 6, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: views.map((view) => ({ buffer: 0, ...view })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: 1, type: 'MAT4' },
      { bufferView: 5, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 6, componentType: 5126, count: 2, type: 'VEC3' },
    ],
  };
  const encodedJson = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(encodedJson.byteLength / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + binary.length;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(encodedJson, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binary.length, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  glb.set(binary, binaryHeader + 8);
  return glb;
}

function multiMaterialStaticGlb(): Uint8Array {
  const binary = floatBytes([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const document = {
    asset: { version: '2.0', generator: 'worldengine-multi-material-test' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, translation: [-1.2, 0, 0] }, { mesh: 1, translation: [1.2, 0, 0] }],
    materials: [
      { name: 'red', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], roughnessFactor: 0.2 } },
      { name: 'green', pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1], roughnessFactor: 0.8 } },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
      { primitives: [{ attributes: { POSITION: 0 }, material: 1 }] },
    ],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  };
  const encodedJson = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(encodedJson.byteLength / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + binary.length;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(encodedJson, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binary.length, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  glb.set(binary, binaryHeader + 8);
  return glb;
}

describe('ThreeRendererBackend chunk transactions', () => {
  it('encodes terrain detail normals in tangent space and mip-filters repeating surfaces', async () => {
    const backend = new ThreeRendererBackend();
    await backend.setWorld(createReferenceBundle());
    const textures = backend as unknown as { terrainDetail: THREE.DataTexture; terrainNormal: THREE.DataTexture; waterNormal: THREE.DataTexture; water: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial> };
    expect(textures.terrainDetail.generateMipmaps).toBe(true);
    expect(textures.terrainNormal.generateMipmaps).toBe(true);
    expect(textures.waterNormal.generateMipmaps).toBe(true);
    expect(textures.terrainNormal.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    const pixels = textures.terrainNormal.image.data as Uint8Array;
    let green = 0; let blue = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) { green += pixels[offset + 1]!; blue += pixels[offset + 2]!; }
    expect(blue / (pixels.length / 4)).toBeGreaterThan(220);
    expect(green / (pixels.length / 4)).toBeLessThan(150);
    const waterPixels = textures.waterNormal.image.data as Uint8Array;
    let waterBlue = 0;
    for (let offset = 0; offset < waterPixels.length; offset += 4) waterBlue += waterPixels[offset + 2]!;
    expect(waterBlue / (waterPixels.length / 4)).toBeGreaterThan(245);
    expect(textures.waterNormal.repeat.toArray()).toEqual([36, 36]);
    expect(textures.water.material.roughness).toBeGreaterThanOrEqual(0.34);
    expect(textures.water.material.normalScale.x).toBeLessThanOrEqual(0.025);
    await backend.dispose();
  });

  it('raycasts the visible terrain into canonical world-space brush coordinates', async () => {
    const backend = new ThreeRendererBackend();
    await backend.setWorld(createReferenceBundle());
    const chunk: RuntimeChunk = { ...chunkWithUnknownPrototype(), instances: [], dependencies: [] };
    await backend.loadChunk(chunk);
    const camera = (backend as unknown as { camera: THREE.PerspectiveCamera }).camera;
    camera.fov = 50; camera.aspect = 1; camera.near = 0.1; camera.far = 2_000;
    camera.position.set(128, 320, 128); camera.lookAt(128, 0, 128); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    const point = backend.pickTerrain(50, 50, 100, 100);
    expect(point?.[0]).toBeCloseTo(128, 1);
    expect(point?.[1]).toBeCloseTo(0, 4);
    expect(point?.[2]).toBeCloseTo(128, 1);
    backend.unloadChunk(chunk.id);
    await backend.dispose();
  });

  it('fails early with an actionable error when a KTX2 bundle lacks a Basis transcoder path', async () => {
    const original = createReferenceBundle();
    const prototype = { ...original.prototypes[0]!, textureFormat: 'ktx2' as const };
    const bundle = VisualWorldBundleSchema.parse({ ...original, prototypes: [prototype, ...original.prototypes.slice(1)], optimization: { ...original.optimization, textureFormat: 'ktx2' } });
    await expect(new ThreeRendererBackend().setWorld(bundle)).rejects.toThrow('ktx2TranscoderPath');
  });

  it('releases terrain allocations when an asset group fails to load', async () => {
    const backend = new ThreeRendererBackend();
    await backend.setWorld(createReferenceBundle());
    const baseline = backend.getResourceStats().usedBytes;
    await expect(backend.loadChunk(chunkWithUnknownPrototype())).rejects.toThrow('Unknown prototype');
    expect(backend.getResourceStats().usedBytes).toBe(baseline);
    await backend.dispose();
  });

  it('loads a hash-verified skeletal GLB and accepts clip state patches', async () => {
    const bytes = skeletalGlb();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const assetUri = `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`;
    const original = createReferenceBundle();
    const prototype = { ...original.prototypes[0]!, assetUri, contentHash: hash, animationClips: ['Wave'] };
    const bundle = VisualWorldBundleSchema.parse({ ...original, prototypes: [prototype, ...original.prototypes.slice(1)] });
    const entityId = EntityIdSchema.parse('animated-instance');
    const chunk: RuntimeChunk = {
      ...chunkWithUnknownPrototype(),
      instances: [{ id: entityId, prototypeId: prototype.id, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 32, 0, 32, 1], visualState: { animationClip: 'Wave' } }],
    };
    const backend = new ThreeRendererBackend();
    await backend.setWorld(bundle);
    const baseline = backend.getResourceStats().usedBytes;
    await expect(backend.loadChunk(chunk)).resolves.toBeUndefined();
    await backend.applyVisualPatch({
      id: 'animation-patch' as never,
      worldId: bundle.worldId,
      baseRevision: 0,
      createdAt: new Date().toISOString(),
      author: 'test',
      operations: [{ op: 'set-visual-state', entityId, state: { animationClip: 'Wave', animationTime: 0.5, teamColor: '#ff0000' } }],
    });
    backend.unloadChunk(chunk.id);
    expect(backend.getResourceStats().usedBytes).toBe(baseline);
    await backend.dispose();
  });

  it('rejects a tampered external GLB before adding its chunk', async () => {
    const bytes = skeletalGlb();
    const assetUri = `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`;
    const original = createReferenceBundle();
    const prototype = { ...original.prototypes[0]!, assetUri, contentHash: '0'.repeat(64), animationClips: ['Wave'] };
    const bundle = VisualWorldBundleSchema.parse({ ...original, prototypes: [prototype, ...original.prototypes.slice(1)] });
    const chunk: RuntimeChunk = {
      ...chunkWithUnknownPrototype(),
      instances: [{ id: EntityIdSchema.parse('tampered-instance'), prototypeId: prototype.id, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 32, 0, 32, 1], visualState: {} }],
    };
    const backend = new ThreeRendererBackend();
    await backend.setWorld(bundle);
    const baseline = backend.getResourceStats().usedBytes;
    await expect(backend.loadChunk(chunk)).rejects.toThrow('content hash');
    expect(backend.getResourceStats().usedBytes).toBe(baseline);
    await backend.dispose();
  });

  it('preserves every static GLB mesh and its PBR material while instancing', async () => {
    const bytes = multiMaterialStaticGlb();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const assetUri = `data:model/gltf-binary;base64,${Buffer.from(bytes).toString('base64')}`;
    const original = createReferenceBundle();
    const prototype = { ...original.prototypes[0]!, assetUri, contentHash: hash, animationClips: [] };
    const bundle = VisualWorldBundleSchema.parse({ ...original, prototypes: [prototype, ...original.prototypes.slice(1)] });
    const chunk: RuntimeChunk = {
      ...chunkWithUnknownPrototype(),
      instances: [{ id: EntityIdSchema.parse('multi-material-instance'), prototypeId: prototype.id, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 32, 0, 32, 1], visualState: {} }],
    };
    const backend = new ThreeRendererBackend();
    await backend.setWorld(bundle);
    await backend.loadChunk(chunk);
    const scene = (backend as unknown as { scene: THREE.Scene }).scene;
    const meshes: THREE.InstancedMesh[] = [];
    scene.traverse((object) => { if (object instanceof THREE.InstancedMesh && object.name.startsWith(`instances:${prototype.id}`)) meshes.push(object); });
    expect(meshes).toHaveLength(2);
    expect(meshes.map((mesh) => (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)).map((material) => (material as THREE.MeshStandardMaterial).color.getHex()).sort((a, b) => a - b)).toEqual([0x00ff00, 0xff0000]);
    backend.unloadChunk(chunk.id);
    await backend.dispose();
  });

  it('renders canonical 257-sample terrain through the bounded 65/33/17 LOD mesh', async () => {
    const bundle = createReferenceBundle();
    const prototype = bundle.prototypes[0]!;
    const samples = 257;
    const heights = new Float32Array(samples * samples);
    for (let index = 0; index < heights.length; index += 1) heights[index] = Math.sin(index * 0.01) * 8;
    const instances = Array.from({ length: 20 }, (_, index) => ({
      id: EntityIdSchema.parse(`lod-instance-${index}`), prototypeId: prototype.id,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 16 + index * 8, 0, 32 + (index % 4) * 20, 1] as RuntimeChunk['instances'][number]['matrix'], visualState: {},
    }));
    const chunk: RuntimeChunk = {
      ...chunkWithUnknownPrototype(),
      terrain: { samples, heights, minHeight: -8, maxHeight: 8, biomeWeights: new Uint8Array(samples * samples) },
      instances,
      dependencies: [prototype.id],
    };
    const backend = new ThreeRendererBackend();
    await backend.setWorld(bundle);
    const baseline = backend.getResourceStats().usedBytes;
    await backend.loadChunk(chunk);
    const stats = backend.getResourceStats();
    expect(stats.usedBytes - baseline).toBeLessThan(2 * 1024 * 1024);
    expect(stats.maxChunkTaskMs).toBeLessThanOrEqual(50);
    backend.unloadChunk(chunk.id);
    await backend.dispose();
  });

  it('prepares ten thousand instanced visuals within the bounded chunk-task and memory budgets', async () => {
    const bundle = createReferenceBundle();
    const prototype = bundle.prototypes[0]!;
    const samples = 17;
    const instances = Array.from({ length: 10_000 }, (_, index) => ({
      id: EntityIdSchema.parse(`performance-instance-${index}`),
      prototypeId: prototype.id,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (index % 100) * 2.5, 0, Math.floor(index / 100) * 2.5, 1] as RuntimeChunk['instances'][number]['matrix'],
      visualState: {},
    }));
    const chunk: RuntimeChunk = {
      ...chunkWithUnknownPrototype(),
      terrain: { samples, heights: new Float32Array(samples * samples), minHeight: 0, maxHeight: 0, biomeWeights: new Uint8Array(samples * samples) },
      instances,
      dependencies: [prototype.id],
    };
    const backend = new ThreeRendererBackend();
    await backend.setWorld(bundle);
    const baseline = backend.getResourceStats().usedBytes;
    await backend.loadChunk(chunk);
    const stats = backend.getResourceStats();
    expect(stats.usedBytes - baseline).toBeLessThan(16 * 1024 * 1024);
    expect(stats.maxChunkTaskMs).toBeLessThanOrEqual(50);
    backend.unloadChunk(chunk.id);
    await backend.dispose();
  });
});
