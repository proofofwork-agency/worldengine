import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface BinaryArtifactReference {
  contentHash: string;
  contentType: string;
  byteLength: number;
}

export interface BinaryArtifactStore {
  put(bytes: Uint8Array, contentType: string): Promise<BinaryArtifactReference>;
  get(contentHash: string): Promise<Uint8Array>;
}

export class FileBinaryArtifactStore implements BinaryArtifactStore {
  constructor(private readonly root: string) {}

  async put(bytes: Uint8Array, contentType: string): Promise<BinaryArtifactReference> {
    if (bytes.byteLength === 0) throw new Error('Binary artifacts may not be empty');
    if (!contentType.includes('/')) throw new Error('Binary artifact content type is invalid');
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const path = this.path(contentHash);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, path);
    return { contentHash, contentType, byteLength: bytes.byteLength };
  }

  async get(contentHash: string): Promise<Uint8Array> {
    if (!/^[a-f\d]{64}$/i.test(contentHash)) throw new Error('Binary artifact hash must be SHA-256');
    return new Uint8Array(await readFile(this.path(contentHash.toLowerCase())));
  }

  private path(contentHash: string): string {
    return join(this.root, contentHash.slice(0, 2), `${contentHash}.bin`);
  }
}
