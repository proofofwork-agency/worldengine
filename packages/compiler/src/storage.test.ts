import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReferenceBundle, generateReferenceChunk } from '@worldengine/terrain';
import { FileWorldStorage, S3WorldStorage, type S3CompatibleClient } from './storage.js';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

describe('world storage containment', () => {
  it('rejects unsafe world IDs, hashes, versions, and coordinates before path construction', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-storage-'));
    const storage = new FileWorldStorage(directory);
    await expect(storage.putBundle({ ...createReferenceBundle(), worldId: '../escape' })).rejects.toThrow('unsafe storage characters');
    await expect(storage.getBundle('../escape')).rejects.toThrow('unsafe storage characters');
    await expect(storage.getAsset('safe-world', '../asset')).rejects.toThrow('SHA-256');
    await expect(storage.putAsset('safe-world', 'a'.repeat(64), new Uint8Array([1]), 'model/gltf-binary')).rejects.toThrow('do not match declared SHA-256');
    await expect(storage.getChunk('safe-world', 0, 0, 0)).rejects.toThrow('positive integer');
    await expect(storage.getChunk('safe-world', 1, Number.NaN, 0)).rejects.toThrow('safe integer');
  });

  it('round-trips immutable manifests and binary artifacts through an S3-compatible client', async () => {
    const objects = new Map<string, Uint8Array>();
    const client: S3CompatibleClient = {
      supportsConditionalWrites: true,
      async putObject(input) {
        const key = `${input.bucket}/${input.key}`;
        if (input.ifNoneMatch === '*' && objects.has(key)) throw new Error('PreconditionFailed');
        objects.set(key, new Uint8Array(input.body));
      },
      async getObject(input) {
        const value = objects.get(`${input.bucket}/${input.key}`);
        if (!value) throw new Error('missing object');
        return new Uint8Array(value);
      },
    };
    const storage = new S3WorldStorage(client, 'world-bucket', 'tenant-a/worldengine');
    const bundle = createReferenceBundle();
    await expect(storage.putBundle(bundle)).resolves.toBe(`s3://world-bucket/tenant-a/worldengine/worlds/${bundle.worldId}/v${bundle.bundleVersion}/bundle.json`);
    await expect(storage.putBundle(bundle)).resolves.toContain('/bundle.json');
    await expect(storage.putBundle({ ...bundle, environment: { ...bundle.environment, timeOfDay: 3 } })).rejects.toThrow('Immutable S3 artifact');
    await expect(storage.getBundle(bundle.worldId)).resolves.toEqual(bundle);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    await storage.putAsset(bundle.worldId, contentHash, bytes, 'model/gltf-binary');
    await expect(storage.getAsset(bundle.worldId, contentHash)).resolves.toEqual(bytes);
    await expect(storage.getAsset('../escape', contentHash)).rejects.toThrow('unsafe storage characters');
  });

  it('makes local versioned JSON write-once while allowing byte-identical retries', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-immutable-'));
    const storage = new FileWorldStorage(directory);
    const bundle = createReferenceBundle(51);
    await storage.putBundle(bundle);
    await expect(storage.putBundle(bundle)).resolves.toContain('/bundle.json');
    await expect(storage.putBundle({ ...bundle, environment: { ...bundle.environment, timeOfDay: 4 } })).rejects.toThrow('Immutable artifact');
    const chunk = generateReferenceChunk(bundle, bundle.chunks[0]!.coordinate, { samples: 17 });
    await storage.putChunk(bundle.worldId, bundle.bundleVersion, chunk);
    await expect(storage.putChunk(bundle.worldId, bundle.bundleVersion, chunk)).resolves.toContain('/chunks/');
    await expect(storage.putChunk(bundle.worldId, bundle.bundleVersion, { ...chunk, placeholder: true })).rejects.toThrow('Immutable artifact');
  });
});
