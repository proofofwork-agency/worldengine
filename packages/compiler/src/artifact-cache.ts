import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface CachedArtifact<T = unknown> {
  key: string;
  value: T;
  contentType: string;
  createdAt: string;
  byteLength: number;
}

export interface ArtifactCache {
  get<T>(key: string): Promise<CachedArtifact<T> | undefined>;
  put<T>(key: string, value: T, contentType?: string): Promise<CachedArtifact<T>>;
  has(key: string): Promise<boolean>;
}

export class FileArtifactCache implements ArtifactCache {
  constructor(private readonly root: string) {}

  async get<T>(key: string): Promise<CachedArtifact<T> | undefined> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as CachedArtifact<T>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async put<T>(key: string, value: T, contentType = 'application/json'): Promise<CachedArtifact<T>> {
    if (!/^[a-f\d]{32,128}$/i.test(key)) throw new Error('Artifact cache keys must be hexadecimal content hashes');
    const encoded = JSON.stringify(value);
    const artifact: CachedArtifact<T> = { key, value, contentType, createdAt: new Date().toISOString(), byteLength: Buffer.byteLength(encoded) };
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(artifact));
    await rename(temporary, path);
    return artifact;
  }

  async has(key: string): Promise<boolean> {
    try { await stat(this.path(key)); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private path(key: string): string {
    return join(this.root, key.slice(0, 2), `${key}.json`);
  }
}
