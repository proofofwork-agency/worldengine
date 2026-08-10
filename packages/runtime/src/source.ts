import { RuntimeChunkDocumentSchema, VisualWorldBundleSchema, migrateWorldFormatDocument, type ChunkId, type RuntimeChunkDocument, type TerrainEdit, type VisualWorldBundle } from '@worldengine/schema';
import { generateReferenceChunkAsync } from '@worldengine/terrain';
import type { WorldBundleSource } from './contracts.js';

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function applyManifestInstanceOverrides(manifest: VisualWorldBundle, document: RuntimeChunkDocument): RuntimeChunkDocument {
  const removed = new Set(manifest.removedEntityIds);
  const instances = document.instances.filter((instance) => !removed.has(instance.id));
  for (const override of manifest.authoredInstances) {
    const x = override.matrix[12];
    const z = override.matrix[14];
    if (x < document.bounds.min[0] || x >= document.bounds.max[0] || z < document.bounds.min[1] || z >= document.bounds.max[1]) continue;
    const index = instances.findIndex((instance) => instance.id === override.id);
    if (index >= 0) instances[index] = override;
    else instances.push(override);
  }
  const occlusionCells = document.occlusionCells.map((cell) => ({
    ...cell,
    instanceIds: instances.filter((instance) => instance.matrix[12] >= cell.bounds.min[0] && instance.matrix[12] < cell.bounds.max[0] && instance.matrix[14] >= cell.bounds.min[1] && instance.matrix[14] < cell.bounds.max[1]).map((instance) => instance.id),
  }));
  return RuntimeChunkDocumentSchema.parse({ ...document, instances, dependencies: [...new Set(instances.map((instance) => instance.prototypeId))].sort(), occlusionCells });
}

function assertManifestIdentity(bundle: VisualWorldBundle): void {
  const prototypeIds = new Set<string>();
  for (const prototype of bundle.prototypes) {
    if (prototypeIds.has(prototype.id)) throw new Error(`Duplicate prototype ID in manifest: ${prototype.id}`);
    prototypeIds.add(prototype.id);
  }
  const chunkIds = new Set<string>();
  for (const entry of bundle.chunks) {
    if (chunkIds.has(entry.id)) throw new Error(`Duplicate chunk ID in manifest: ${entry.id}`);
    chunkIds.add(entry.id);
    if (entry.id !== `${entry.coordinate.x}:${entry.coordinate.z}`) throw new Error(`Chunk ${entry.id} does not match its signed coordinate`);
    const expected = { min: [entry.coordinate.x * bundle.chunkSize, entry.coordinate.z * bundle.chunkSize], max: [(entry.coordinate.x + 1) * bundle.chunkSize, (entry.coordinate.z + 1) * bundle.chunkSize] };
    if (entry.bounds.min[0] !== expected.min[0] || entry.bounds.min[1] !== expected.min[1] || entry.bounds.max[0] !== expected.max[0] || entry.bounds.max[1] !== expected.max[1]) throw new Error(`Chunk ${entry.id} bounds do not match its coordinate and chunk size`);
    for (const dependency of entry.dependencies) if (!prototypeIds.has(dependency)) throw new Error(`Chunk ${entry.id} references missing prototype ${dependency}`);
  }
  for (const instance of bundle.authoredInstances) if (!prototypeIds.has(instance.prototypeId)) throw new Error(`Authored entity ${instance.id} references missing prototype ${instance.prototypeId}`);
}

export function resolveBundleAssetUris(bundleInput: VisualWorldBundle, manifestUrl: URL): VisualWorldBundle {
  const bundle = VisualWorldBundleSchema.parse(bundleInput);
  assertManifestIdentity(bundle);
  const resolveAsset = (assetUri: string): string => {
    if (assetUri.startsWith('primitive://')) return assetUri;
    const resolved = new URL(assetUri, manifestUrl);
    if (!['http:', 'https:'].includes(resolved.protocol) || resolved.username || resolved.password) throw new Error(`Unsafe asset URL: ${assetUri}`);
    return resolved.href;
  };
  return VisualWorldBundleSchema.parse({
    ...bundle,
    prototypes: bundle.prototypes.map((prototype) => ({
      ...prototype,
      assetUri: resolveAsset(prototype.assetUri),
      lods: prototype.lods.map((lod) => ({ ...lod, assetUri: resolveAsset(lod.assetUri) })),
    })),
  });
}

export class HttpWorldBundleSource implements WorldBundleSource {
  private manifest?: VisualWorldBundle;

  constructor(private readonly manifestUrl: URL, private readonly fetcher: typeof fetch = fetch) {}

  async loadManifest(): Promise<VisualWorldBundle> {
    const response = await this.fetcher(this.manifestUrl);
    if (!response.ok) throw new Error(`Unable to load world manifest: ${response.status} ${response.statusText}`);
    this.manifest = resolveBundleAssetUris(VisualWorldBundleSchema.parse(migrateWorldFormatDocument(await response.json())), this.manifestUrl);
    return this.manifest;
  }

  async loadChunk(id: ChunkId): Promise<RuntimeChunkDocument> {
    const manifest = this.manifest ?? await this.loadManifest();
    const entry = manifest.chunks.find((chunk) => chunk.id === id);
    if (!entry) return this.loadPlaceholder(id);
    if (entry.source.kind === 'procedural') return generateReferenceChunkAsync(manifest, entry.coordinate);
    const chunkUrl = new URL(entry.source.uri, this.manifestUrl);
    if (!['http:', 'https:'].includes(chunkUrl.protocol) || chunkUrl.username || chunkUrl.password) throw new Error(`Unsafe chunk URL for ${id}`);
    const response = await this.fetcher(chunkUrl);
    if (!response.ok) throw new Error(`Unable to load chunk ${id}: ${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== entry.source.byteLength) throw new Error(`Chunk ${id} byte length does not match its manifest`);
    if (/^[a-f\d]{64}$/i.test(entry.source.contentHash) && await sha256(bytes) !== entry.source.contentHash.toLowerCase()) throw new Error(`Chunk ${id} content hash does not match its manifest`);
    const document = RuntimeChunkDocumentSchema.parse(migrateWorldFormatDocument(JSON.parse(new TextDecoder().decode(bytes))));
    if (document.id !== id || document.coordinate.x !== entry.coordinate.x || document.coordinate.z !== entry.coordinate.z) throw new Error(`Chunk payload ${document.id} does not match requested manifest entry ${id}`);
    if (document.bounds.min[0] !== entry.bounds.min[0] || document.bounds.min[1] !== entry.bounds.min[1] || document.bounds.max[0] !== entry.bounds.max[0] || document.bounds.max[1] !== entry.bounds.max[1]) throw new Error(`Chunk payload ${id} bounds do not match its manifest entry`);
    return applyManifestInstanceOverrides(manifest, document);
  }

  async loadPlaceholder(id: ChunkId): Promise<RuntimeChunkDocument> {
    const manifest = this.manifest ?? await this.loadManifest();
    const [x, z] = id.split(':').map(Number);
    if (!Number.isInteger(x) || !Number.isInteger(z)) throw new Error(`Invalid chunk id: ${id}`);
    return generateReferenceChunkAsync(manifest, { x: x!, z: z! }, { samples: 33, instances: 0, placeholder: true });
  }
}

export class ProceduralWorldBundleSource implements WorldBundleSource {
  private terrainEdits: TerrainEdit[];
  private regionDensities: Record<string, number> = {};

  constructor(private readonly manifest: VisualWorldBundle, private readonly detailedSamples = 257) {
    VisualWorldBundleSchema.parse(manifest);
    this.terrainEdits = structuredClone(manifest.terrain?.edits ?? []);
  }

  async loadManifest(): Promise<VisualWorldBundle> {
    return this.manifest;
  }

  async loadChunk(id: ChunkId): Promise<RuntimeChunkDocument> {
    const entry = this.manifest.chunks.find((chunk) => chunk.id === id);
    if (!entry) return this.loadPlaceholder(id);
    return generateReferenceChunkAsync(this.manifest, entry.coordinate, { samples: this.detailedSamples, terrainEdits: this.terrainEdits, regionDensities: this.regionDensities });
  }

  async loadPlaceholder(id: ChunkId): Promise<RuntimeChunkDocument> {
    const [x, z] = id.split(':').map(Number);
    if (!Number.isInteger(x) || !Number.isInteger(z)) throw new Error(`Invalid chunk id: ${id}`);
    return generateReferenceChunkAsync(this.manifest, { x: x!, z: z! }, { samples: 33, instances: 0, placeholder: true, terrainEdits: this.terrainEdits });
  }

  setTerrainEdits(edits: TerrainEdit[]): void {
    this.terrainEdits = structuredClone(edits);
  }

  setRegionDensities(densities: Record<string, number>): void {
    this.regionDensities = structuredClone(densities);
  }
}
