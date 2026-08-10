import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BlenderWorkerClient, LocalSam2SegmentationAdapter, type ProcessRunner } from './studio-workers.js';

function glbFixture(): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const document = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: positions.byteLength }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0 });
  const jsonLength = Math.ceil(document.length / 4) * 4; const binaryLength = Math.ceil(positions.byteLength / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength); const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true); view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.set(new TextEncoder().encode(document.padEnd(jsonLength, ' ')), 20); const binaryOffset = 20 + jsonLength; view.setUint32(binaryOffset, binaryLength, true); view.setUint32(binaryOffset + 4, 0x004e4942, true); bytes.set(new Uint8Array(positions.buffer), binaryOffset + 8);
  return bytes;
}

describe('Studio process workers', () => {
  it('runs SAM2 through a fixed JSON job and ingests only the mask file', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const runner: ProcessRunner = async (_command, args) => {
      const job = JSON.parse(await readFile(args[args.indexOf('--job') + 1]!, 'utf8')) as { outputPath: string; operation: string };
      expect(job.operation).toBe('segment-box'); await writeFile(job.outputPath, png); return { code: 0, stdout: '', stderr: '' };
    };
    const adapter = new LocalSam2SegmentationAdapter('sam2.1-hiera-small', 'commit+sha', 'python3', '/worker.py', '/checkpoint.pt', 'config.yaml', runner);
    const output = await adapter.invoke({ provider: adapter.provider, modelId: adapter.modelId, revision: adapter.revision, idempotencyKey: 'mask-1', settings: {}, input: { image: `data:image/png;base64,${Buffer.from(png).toString('base64')}`, box: { x: 1, y: 2, width: 3, height: 4 }, width: 8, height: 8 } });
    expect(output.images[0]?.base64).toBe(Buffer.from(png).toString('base64'));
  });

  it('accepts only the fixed Blender response manifest and exact GLB bytes', async () => {
    const source = glbFixture();
    const runner: ProcessRunner = async (_command, args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'Blender 5.1.1\n', stderr: '' };
      const job = JSON.parse(await readFile(args[args.indexOf('--job') + 1]!, 'utf8')) as { outputPath: string; resultPath: string };
      await writeFile(job.outputPath, source); await writeFile(job.resultPath, JSON.stringify({ workerVersion: 'fixture-1', renders: [], diagnostics: [{ severity: 'info', code: 'OK', message: 'refined' }] })); return { code: 0, stdout: '', stderr: '' };
    };
    const client = new BlenderWorkerClient('blender', '/worker.py', runner);
    await expect(client.checkCapabilities()).resolves.toMatchObject({ available: true, version: 'Blender 5.1.1' });
    const result = await client.refine(source, { operations: ['validate-mesh', 'export-glb'], renderResolution: 256 });
    expect(result.workerVersion).toBe('fixture-1'); expect(result.glb).toEqual(source);
  });
});
