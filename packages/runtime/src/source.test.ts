import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createReferenceBundle, generateReferenceChunk } from '@worldengine/terrain';
import { HttpWorldBundleSource, resolveBundleAssetUris } from './source.js';

describe('HTTP world bundle source', () => {
  it('resolves renderer assets against the immutable manifest URL and rejects unsafe schemes', () => {
    const original = createReferenceBundle();
    const external = {
      ...original,
      prototypes: original.prototypes.map((prototype, index) => index === 0 ? {
        ...prototype,
        assetUri: 'assets/tree.glb',
        contentHash: 'a'.repeat(64),
        lods: [{ distance: 120, assetUri: 'assets/tree-lod.glb', contentHash: 'b'.repeat(64), provenanceId: 'tree-lod-provenance' }],
      } : prototype),
    };
    const resolved = resolveBundleAssetUris(external, new URL('https://world.test/v1/worlds/demo/bundle'));
    expect(resolved.prototypes[0]).toMatchObject({ assetUri: 'https://world.test/v1/worlds/demo/assets/tree.glb', lods: [{ assetUri: 'https://world.test/v1/worlds/demo/assets/tree-lod.glb' }] });
    expect(() => resolveBundleAssetUris({ ...external, prototypes: external.prototypes.map((prototype, index) => index === 0 ? { ...prototype, assetUri: 'javascript:alert(1)' } : prototype) }, new URL('https://world.test/bundle'))).toThrow('Unsafe asset URL');
  });

  it('resolves every compiled terrain dependency and rejects unsafe terrain schemes', () => {
    const original = createReferenceBundle();
    const region = original.regions[0]!;
    const material = { id: 'terrain-rock', name: 'Rock', biome: region.biome, baseColorUri: 'terrain/base.ktx2', normalUri: 'terrain/normal.ktx2', roughnessUri: 'terrain/roughness.ktx2', macroVariationUri: 'terrain/macro.ktx2', metersPerTile: 4 };
    const terrainPlan = { schemaVersion: '1.0.0' as const, maskBlendMeters: 128, regions: [{ regionId: region.id, operators: [{ kind: 'ridge' as const, strength: 0.5, scaleMeters: 400, octaves: 4, offset: [0, 0] as [number, number] }], materialSetIds: [material.id] }], materialSets: [material], scatterRecipes: [], featureIds: [], referenceCameras: [] };
    const compiled = {
      ...original,
      terrain: { kind: 'compiled-heightfield' as const, seed: original.seed, heightfieldUri: 'terrain/height.f32', contentHash: 'a'.repeat(64), samples: 257, encoding: 'float32' as const, terrainPlan, materialSets: [material], splatMapUris: ['terrain/splat.bin'], edits: [], footprintEdits: [] },
      chunks: original.chunks.map((entry) => ({ ...entry, source: { kind: 'compiled-heightfield' as const, seed: original.seed, generator: 'worldengine-terrain-v2' as const, contentHash: entry.source.contentHash, heightfieldDependency: 'terrain/height.f32', splatDependencies: ['terrain/splat.bin'], textureDependencies: [material.baseColorUri, material.normalUri, material.roughnessUri, material.macroVariationUri] } })),
    };
    const resolved = resolveBundleAssetUris(compiled, new URL('https://world.test/v1/worlds/demo/bundle'));
    expect(resolved.terrain?.kind).toBe('compiled-heightfield');
    if (resolved.terrain?.kind !== 'compiled-heightfield') throw new Error('Expected compiled terrain');
    expect(resolved.terrain.materialSets[0]?.baseColorUri).toBe('https://world.test/v1/worlds/demo/terrain/base.ktx2');
    expect(resolved.chunks[0]?.source).toMatchObject({ heightfieldDependency: 'https://world.test/v1/worlds/demo/terrain/height.f32', textureDependencies: ['https://world.test/v1/worlds/demo/terrain/base.ktx2', 'https://world.test/v1/worlds/demo/terrain/normal.ktx2', 'https://world.test/v1/worlds/demo/terrain/roughness.ktx2', 'https://world.test/v1/worlds/demo/terrain/macro.ktx2'] });
    const unsafe = { ...compiled, terrain: { ...compiled.terrain, materialSets: [{ ...material, normalUri: 'javascript:alert(1)' }] } };
    expect(() => resolveBundleAssetUris(unsafe, new URL('https://world.test/v1/worlds/demo/bundle'))).toThrow('Unsafe asset URL');
  });

  it('loads a versioned URI chunk only when byte length and SHA-256 match', async () => {
    const original = createReferenceBundle();
    const chunk = generateReferenceChunk(original, { x: 0, z: 0 }, { samples: 9 });
    const moved = structuredClone(chunk.instances[0]!);
    moved.matrix[12] += 10;
    const payload = JSON.stringify(chunk);
    const hash = createHash('sha256').update(payload).digest('hex');
    const manifest = {
      ...original,
      authoredInstances: [moved],
      removedEntityIds: [chunk.instances[1]!.id],
      chunks: original.chunks.map((entry) => entry.id === '0:0' ? {
        ...entry,
        source: { kind: 'uri' as const, uri: 'chunks/0_0.json?version=2', contentHash: hash, byteLength: new TextEncoder().encode(payload).byteLength },
      } : entry),
    };
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/bundle')
      ? new Response(JSON.stringify(manifest), { status: 200 })
      : new Response(payload, { status: 200 })) as typeof fetch;
    const source = new HttpWorldBundleSource(new URL('https://world.test/v1/worlds/demo/bundle'), fetcher);
    await source.loadManifest();
    const loaded = await source.loadChunk('0:0' as never);
    expect(loaded).toMatchObject({ id: '0:0', placeholder: false });
    expect(loaded.instances.find((instance) => instance.id === moved.id)?.matrix[12]).toBe(moved.matrix[12]);
    expect(loaded.instances.some((instance) => instance.id === chunk.instances[1]!.id)).toBe(false);
    expect(fetcher).toHaveBeenLastCalledWith(new URL('https://world.test/v1/worlds/demo/chunks/0_0.json?version=2'));
  });

  it('rejects a tampered URI chunk', async () => {
    const original = createReferenceBundle();
    const manifest = {
      ...original,
      chunks: original.chunks.map((entry) => entry.id === '0:0' ? {
        ...entry,
        source: { kind: 'uri' as const, uri: 'chunks/0_0.json?version=2', contentHash: '0'.repeat(64), byteLength: 2 },
      } : entry),
    };
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/bundle')
      ? new Response(JSON.stringify(manifest), { status: 200 })
      : new Response('{}', { status: 200 })) as typeof fetch;
    const source = new HttpWorldBundleSource(new URL('https://world.test/v1/worlds/demo/bundle'), fetcher);
    await source.loadManifest();
    await expect(source.loadChunk('0:0' as never)).rejects.toThrow('content hash');
  });

  it('binds a valid content-hashed payload to the requested manifest chunk identity', async () => {
    const original = createReferenceBundle();
    const wrong = generateReferenceChunk(original, { x: 1, z: 0 }, { samples: 9 });
    const payload = JSON.stringify(wrong);
    const manifest = {
      ...original,
      chunks: original.chunks.map((entry) => entry.id === '0:0' ? {
        ...entry,
        source: { kind: 'uri' as const, uri: 'chunks/0_0.json?version=2', contentHash: createHash('sha256').update(payload).digest('hex'), byteLength: new TextEncoder().encode(payload).byteLength },
      } : entry),
    };
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/bundle')
      ? new Response(JSON.stringify(manifest), { status: 200 })
      : new Response(payload, { status: 200 })) as typeof fetch;
    const source = new HttpWorldBundleSource(new URL('https://world.test/v1/worlds/demo/bundle'), fetcher);
    await source.loadManifest();
    await expect(source.loadChunk('0:0' as never)).rejects.toThrow('does not match requested manifest entry');
  });

  it('rejects duplicate manifest identities before streaming', () => {
    const original = createReferenceBundle();
    expect(() => resolveBundleAssetUris({ ...original, chunks: [original.chunks[0]!, original.chunks[0]!] }, new URL('https://world.test/bundle'))).toThrow('Duplicate chunk ID');
    expect(() => resolveBundleAssetUris({ ...original, prototypes: [original.prototypes[0]!, original.prototypes[0]!] }, new URL('https://world.test/bundle'))).toThrow('Duplicate prototype ID');
  });
});
