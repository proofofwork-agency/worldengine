import { createHash } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AuthoringWorldSchema, RuntimeChunkDocumentSchema, VisualWorldBundleSchema, WorldDesignSpecSchema, migrateWorldFormatDocument, type AuthoringWorld, type RuntimeChunkDocument, type VisualWorldBundle, type WorldDesignSpec } from '@worldengine/schema';

function safeWorldId(value: string): string {
  if (!/^[a-z\d][a-z\d._:-]{0,199}$/i.test(value) || value.includes('..')) throw new Error('World ID contains unsafe storage characters');
  return value;
}

function safeVersion(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('Bundle version must be a positive integer');
  return value;
}

function safeContentHash(value: string): string {
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error('Content hash must be SHA-256');
  return value.toLowerCase();
}

function assertContentHash(contentHash: string, bytes: Uint8Array): void {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== contentHash) throw new Error(`Artifact bytes do not match declared SHA-256 ${contentHash}`);
}

function safeCoordinate(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Chunk coordinate must be a safe integer');
  return value;
}

function safeReferenceExtension(value: string): 'png' | 'jpg' | 'webp' {
  if (value !== 'png' && value !== 'jpg' && value !== 'webp') throw new Error('Unsupported reference extension');
  return value;
}

export type TerrainArtifactExtension = 'png' | 'ktx2' | 'f32' | 'bin';

function safeTerrainExtension(value: string): TerrainArtifactExtension {
  if (value !== 'png' && value !== 'ktx2' && value !== 'f32' && value !== 'bin') throw new Error('Unsupported terrain artifact extension');
  return value;
}

export interface WorldStorage {
  putBundle(bundle: VisualWorldBundle): Promise<string>;
  getBundle(worldId: string, version?: number): Promise<VisualWorldBundle>;
  putChunk(worldId: string, version: number, chunk: RuntimeChunkDocument): Promise<string>;
  getChunk(worldId: string, version: number, x: number, z: number): Promise<RuntimeChunkDocument>;
  putDesignSpec(worldId: string, version: number, designSpec: WorldDesignSpec): Promise<string>;
  getDesignSpec(worldId: string, version: number): Promise<WorldDesignSpec>;
  putAuthoringWorld(worldId: string, version: number, authoringWorld: AuthoringWorld): Promise<string>;
  getAuthoringWorld(worldId: string, version: number): Promise<AuthoringWorld>;
  putAsset(worldId: string, contentHash: string, bytes: Uint8Array, contentType: string): Promise<string>;
  getAsset(worldId: string, contentHash: string): Promise<Uint8Array>;
  putReference(worldId: string, contentHash: string, extension: 'png' | 'jpg' | 'webp', bytes: Uint8Array, contentType: string): Promise<string>;
  getReference(worldId: string, contentHash: string, extension: 'png' | 'jpg' | 'webp'): Promise<Uint8Array>;
  putTerrain(worldId: string, contentHash: string, extension: TerrainArtifactExtension, bytes: Uint8Array, contentType: string): Promise<string>;
  getTerrain(worldId: string, contentHash: string, extension: TerrainArtifactExtension): Promise<Uint8Array>;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

async function immutableJson(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = await readFile(path, 'utf8');
    if (existing === serialized) return;
    throw new Error(`Immutable artifact already exists with different bytes: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, serialized);
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(path, 'utf8');
    if (existing !== serialized) throw new Error(`Immutable artifact was concurrently created with different bytes: ${path}`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export class FileWorldStorage implements WorldStorage {
  constructor(private readonly root: string) {}

  async putBundle(bundle: VisualWorldBundle): Promise<string> {
    bundle = VisualWorldBundleSchema.parse(bundle);
    const worldId = safeWorldId(bundle.worldId);
    const versionPath = join(this.root, 'worlds', worldId, `v${safeVersion(bundle.bundleVersion)}`, 'bundle.json');
    await immutableJson(versionPath, bundle);
    await atomicJson(join(this.root, 'worlds', worldId, 'latest.json'), { version: bundle.bundleVersion });
    return versionPath;
  }

  async getBundle(worldId: string, version?: number): Promise<VisualWorldBundle> {
    worldId = safeWorldId(worldId);
    let selected = version;
    if (selected === undefined) selected = (JSON.parse(await readFile(join(this.root, 'worlds', worldId, 'latest.json'), 'utf8')) as { version: number }).version;
    selected = safeVersion(selected);
    return VisualWorldBundleSchema.parse(migrateWorldFormatDocument(JSON.parse(await readFile(join(this.root, 'worlds', worldId, `v${selected}`, 'bundle.json'), 'utf8'))));
  }

  async putChunk(worldId: string, version: number, chunk: RuntimeChunkDocument): Promise<string> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    chunk = RuntimeChunkDocumentSchema.parse(chunk);
    const x = safeCoordinate(chunk.coordinate.x); const z = safeCoordinate(chunk.coordinate.z);
    const path = join(this.root, 'worlds', worldId, `v${version}`, 'chunks', `${x}_${z}.json`);
    await immutableJson(path, chunk);
    return path;
  }

  async getChunk(worldId: string, version: number, x: number, z: number): Promise<RuntimeChunkDocument> {
    worldId = safeWorldId(worldId); version = safeVersion(version); x = safeCoordinate(x); z = safeCoordinate(z);
    return RuntimeChunkDocumentSchema.parse(migrateWorldFormatDocument(JSON.parse(await readFile(join(this.root, 'worlds', worldId, `v${version}`, 'chunks', `${x}_${z}.json`), 'utf8'))));
  }

  async putDesignSpec(worldId: string, version: number, designSpec: WorldDesignSpec): Promise<string> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    const path = join(this.root, 'worlds', worldId, `v${version}`, 'design.json');
    await immutableJson(path, WorldDesignSpecSchema.parse(designSpec));
    return path;
  }

  async getDesignSpec(worldId: string, version: number): Promise<WorldDesignSpec> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    return WorldDesignSpecSchema.parse(migrateWorldFormatDocument(JSON.parse(await readFile(join(this.root, 'worlds', worldId, `v${version}`, 'design.json'), 'utf8'))));
  }

  async putAuthoringWorld(worldId: string, version: number, authoringWorld: AuthoringWorld): Promise<string> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    const path = join(this.root, 'worlds', worldId, `v${version}`, 'authoring.json');
    await immutableJson(path, AuthoringWorldSchema.parse(authoringWorld));
    return path;
  }

  async getAuthoringWorld(worldId: string, version: number): Promise<AuthoringWorld> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    return AuthoringWorldSchema.parse(migrateWorldFormatDocument(JSON.parse(await readFile(join(this.root, 'worlds', worldId, `v${version}`, 'authoring.json'), 'utf8'))));
  }

  async putAsset(worldId: string, contentHash: string, bytes: Uint8Array, _contentType: string): Promise<string> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash);
    assertContentHash(contentHash, bytes);
    const path = join(this.root, 'worlds', worldId, 'assets', `${contentHash}.glb`);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
    return path;
  }

  async getAsset(worldId: string, contentHash: string): Promise<Uint8Array> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash);
    return new Uint8Array(await readFile(join(this.root, 'worlds', worldId, 'assets', `${contentHash}.glb`)));
  }

  async putReference(worldId: string, contentHash: string, extension: 'png' | 'jpg' | 'webp', bytes: Uint8Array, _contentType: string): Promise<string> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash); extension = safeReferenceExtension(extension);
    assertContentHash(contentHash, bytes);
    const path = join(this.root, 'worlds', worldId, 'references', `${contentHash}.${extension}`);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
    return path;
  }

  async getReference(worldId: string, contentHash: string, extension: 'png' | 'jpg' | 'webp'): Promise<Uint8Array> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash); extension = safeReferenceExtension(extension);
    return new Uint8Array(await readFile(join(this.root, 'worlds', worldId, 'references', `${contentHash}.${extension}`)));
  }

  async putTerrain(worldId: string, contentHash: string, extension: TerrainArtifactExtension, bytes: Uint8Array, _contentType: string): Promise<string> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash); extension = safeTerrainExtension(extension); assertContentHash(contentHash, bytes);
    const path = join(this.root, 'worlds', worldId, 'terrain', `${contentHash}.${extension}`); await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`; await writeFile(temporary, bytes); await rename(temporary, path); return path;
  }

  async getTerrain(worldId: string, contentHash: string, extension: TerrainArtifactExtension): Promise<Uint8Array> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash); extension = safeTerrainExtension(extension);
    return new Uint8Array(await readFile(join(this.root, 'worlds', worldId, 'terrain', `${contentHash}.${extension}`)));
  }
}

export interface S3CompatibleClient {
  readonly supportsConditionalWrites: true;
  putObject(input: { bucket: string; key: string; body: Uint8Array; contentType: string; ifNoneMatch?: '*' }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<Uint8Array>;
}

export class S3WorldStorage implements WorldStorage {
  constructor(private readonly client: S3CompatibleClient, private readonly bucket: string, private readonly prefix = 'worldengine') {
    if (client.supportsConditionalWrites !== true) throw new Error('S3 world storage requires If-None-Match conditional writes for immutable versions');
  }

  async putBundle(bundle: VisualWorldBundle): Promise<string> {
    bundle = VisualWorldBundleSchema.parse(bundle);
    const worldId = safeWorldId(bundle.worldId);
    const key = `${this.prefix}/worlds/${worldId}/v${safeVersion(bundle.bundleVersion)}/bundle.json`;
    await this.putImmutable(key, bundle);
    await this.put(`${this.prefix}/worlds/${worldId}/latest.json`, { version: bundle.bundleVersion });
    return `s3://${this.bucket}/${key}`;
  }

  async getBundle(worldId: string, version?: number): Promise<VisualWorldBundle> {
    worldId = safeWorldId(worldId);
    let selected = version;
    if (selected === undefined) {
      const latest = await this.get<{ version: number }>(`${this.prefix}/worlds/${worldId}/latest.json`);
      selected = latest.version;
    }
    selected = safeVersion(selected);
    return VisualWorldBundleSchema.parse(migrateWorldFormatDocument(await this.get<unknown>(`${this.prefix}/worlds/${worldId}/v${selected}/bundle.json`)));
  }

  async putChunk(worldId: string, version: number, chunk: RuntimeChunkDocument): Promise<string> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    chunk = RuntimeChunkDocumentSchema.parse(chunk);
    const x = safeCoordinate(chunk.coordinate.x); const z = safeCoordinate(chunk.coordinate.z);
    const key = `${this.prefix}/worlds/${worldId}/v${version}/chunks/${x}_${z}.json`;
    await this.putImmutable(key, chunk);
    return `s3://${this.bucket}/${key}`;
  }

  async getChunk(worldId: string, version: number, x: number, z: number): Promise<RuntimeChunkDocument> {
    worldId = safeWorldId(worldId); version = safeVersion(version); x = safeCoordinate(x); z = safeCoordinate(z);
    return RuntimeChunkDocumentSchema.parse(migrateWorldFormatDocument(await this.get<unknown>(`${this.prefix}/worlds/${worldId}/v${version}/chunks/${x}_${z}.json`)));
  }

  async putDesignSpec(worldId: string, version: number, designSpec: WorldDesignSpec): Promise<string> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    const key = `${this.prefix}/worlds/${worldId}/v${version}/design.json`;
    await this.putImmutable(key, WorldDesignSpecSchema.parse(designSpec));
    return `s3://${this.bucket}/${key}`;
  }

  async getDesignSpec(worldId: string, version: number): Promise<WorldDesignSpec> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    return WorldDesignSpecSchema.parse(migrateWorldFormatDocument(await this.get<unknown>(`${this.prefix}/worlds/${worldId}/v${version}/design.json`)));
  }

  async putAuthoringWorld(worldId: string, version: number, authoringWorld: AuthoringWorld): Promise<string> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    const key = `${this.prefix}/worlds/${worldId}/v${version}/authoring.json`;
    await this.putImmutable(key, AuthoringWorldSchema.parse(authoringWorld));
    return `s3://${this.bucket}/${key}`;
  }

  async getAuthoringWorld(worldId: string, version: number): Promise<AuthoringWorld> {
    worldId = safeWorldId(worldId); version = safeVersion(version);
    return AuthoringWorldSchema.parse(migrateWorldFormatDocument(await this.get<unknown>(`${this.prefix}/worlds/${worldId}/v${version}/authoring.json`)));
  }

  async putAsset(worldId: string, contentHash: string, bytes: Uint8Array, contentType: string): Promise<string> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash);
    assertContentHash(contentHash, bytes);
    const key = `${this.prefix}/worlds/${worldId}/assets/${contentHash}.glb`;
    await this.client.putObject({ bucket: this.bucket, key, body: bytes, contentType });
    return `s3://${this.bucket}/${key}`;
  }

  async getAsset(worldId: string, contentHash: string): Promise<Uint8Array> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash);
    return this.client.getObject({ bucket: this.bucket, key: `${this.prefix}/worlds/${worldId}/assets/${contentHash}.glb` });
  }

  async putReference(worldId: string, contentHash: string, extension: 'png' | 'jpg' | 'webp', bytes: Uint8Array, contentType: string): Promise<string> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash); extension = safeReferenceExtension(extension);
    assertContentHash(contentHash, bytes);
    const key = `${this.prefix}/worlds/${worldId}/references/${contentHash}.${extension}`;
    await this.client.putObject({ bucket: this.bucket, key, body: bytes, contentType });
    return `s3://${this.bucket}/${key}`;
  }

  async getReference(worldId: string, contentHash: string, extension: 'png' | 'jpg' | 'webp'): Promise<Uint8Array> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash); extension = safeReferenceExtension(extension);
    return this.client.getObject({ bucket: this.bucket, key: `${this.prefix}/worlds/${worldId}/references/${contentHash}.${extension}` });
  }

  async putTerrain(worldId: string, contentHash: string, extension: TerrainArtifactExtension, bytes: Uint8Array, contentType: string): Promise<string> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash); extension = safeTerrainExtension(extension); assertContentHash(contentHash, bytes);
    const key = `${this.prefix}/worlds/${worldId}/terrain/${contentHash}.${extension}`; await this.client.putObject({ bucket: this.bucket, key, body: bytes, contentType }); return `s3://${this.bucket}/${key}`;
  }

  async getTerrain(worldId: string, contentHash: string, extension: TerrainArtifactExtension): Promise<Uint8Array> {
    worldId = safeWorldId(worldId); contentHash = safeContentHash(contentHash); extension = safeTerrainExtension(extension);
    return this.client.getObject({ bucket: this.bucket, key: `${this.prefix}/worlds/${worldId}/terrain/${contentHash}.${extension}` });
  }

  private async put(key: string, value: unknown): Promise<void> {
    await this.client.putObject({ bucket: this.bucket, key, body: new TextEncoder().encode(JSON.stringify(value)), contentType: 'application/json' });
  }

  private async putImmutable(key: string, value: unknown): Promise<void> {
    const body = new TextEncoder().encode(JSON.stringify(value));
    try {
      await this.client.putObject({ bucket: this.bucket, key, body, contentType: 'application/json', ifNoneMatch: '*' });
    } catch (writeError) {
      try {
        const existing = await this.client.getObject({ bucket: this.bucket, key });
        if (Buffer.from(existing).equals(Buffer.from(body))) return;
        throw new Error(`Immutable S3 artifact already exists with different bytes: ${key}`);
      } catch (readError) {
        if (readError instanceof Error && readError.message.startsWith('Immutable S3 artifact')) throw readError;
        throw writeError;
      }
    }
  }

  private async get<T>(key: string): Promise<T> {
    const bytes = await this.client.getObject({ bucket: this.bucket, key });
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
}
