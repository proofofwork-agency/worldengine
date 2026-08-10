import { describe, expect, it } from 'vitest';
import { WaveSpeedTripoMultiviewAdapter, type MultiImageTo3DInput } from './http-adapters.js';

function minimalGlb(): Uint8Array {
  const document = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 12 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }], accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] });
  const jsonLength = Math.ceil(Buffer.byteLength(document) / 4) * 4; const totalLength = 12 + 8 + jsonLength + 8 + 12;
  const bytes = new Uint8Array(totalLength); const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, totalLength, true); view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength); bytes.set(Buffer.from(document), 20); const binaryHeader = 20 + jsonLength; view.setUint32(binaryHeader, 12, true); view.setUint32(binaryHeader + 4, 0x004e4942, true);
  return bytes;
}

function multiviewInput(): MultiImageTo3DInput {
  const source = (value: number) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, value]).toString('base64')}`;
  return { images: [{ source: source(5), orientation: 'perspective' }, { source: source(3), orientation: 'back' }, { source: source(1), orientation: 'front' }, { source: source(4), orientation: 'right' }, { source: source(2), orientation: 'left' }], pbr: true, geometryQuality: 'detailed', textureResolution: '4k', faceLimit: 250_000, seed: 17 };
}

function glbResponse(): Response {
  const bytes = minimalGlb(); return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { headers: { 'content-type': 'model/gltf-binary' } });
}

describe('WaveSpeed Tripo H3.1 multiview contract', () => {
  it('submits exactly four ordered cardinal images with fixed detailed PBR settings and idempotency', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input); requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/tripo3d/h3.1/multiview-to-3d')) return Response.json({ code: 200, data: { id: 'wave-1', status: 'completed', outputs: ['https://assets.example/model.glb'] } });
      if (url === 'https://assets.example/model.glb') return glbResponse();
      return new Response('not found', { status: 404 });
    };
    const adapter = new WaveSpeedTripoMultiviewAdapter('tripo3d/h3.1/multiview-to-3d', 'h3.1-pinned', 'key', fetcher as typeof fetch, 'https://api.wavespeed.ai/api/v3', 0);
    const invocation = { provider: 'wavespeed', modelId: adapter.modelId, revision: adapter.revision, input: multiviewInput(), settings: {}, idempotencyKey: 'wave-once' };
    const [first, second] = await Promise.all([adapter.invoke(invocation), adapter.invoke(invocation)]);
    expect(first).toEqual(second); expect(first.predictionId).toBe('wave-1');
    const submissions = requests.filter((request) => request.url.endsWith('/tripo3d/h3.1/multiview-to-3d'));
    expect(submissions).toHaveLength(1);
    const body = JSON.parse(String(submissions[0]!.init?.body)) as Record<string, unknown> & { images: string[] };
    expect(body.images).toEqual([multiviewInput().images[2]!.source, multiviewInput().images[4]!.source, multiviewInput().images[1]!.source, multiviewInput().images[3]!.source]);
    expect(body).toMatchObject({ pbr: true, geometry_quality: 'detailed', texture_quality: 'detailed', texture_resolution: '4k', texture_alignment: 'geometry', orientation: 'align_image', auto_size: false, quad: false, face_limit: 250_000, model_seed: 17, output_format: 'glb' });
    expect(submissions[0]!.init?.headers).toMatchObject({ 'x-idempotency-key': 'wave-once' });
  });

  it('fails closed for a missing cardinal view or a policy-bound override', async () => {
    const input = multiviewInput(); input.images = input.images.filter((image) => image.orientation !== 'right');
    const adapter = new WaveSpeedTripoMultiviewAdapter(undefined, 'pinned', 'key', async () => new Response() as never, undefined, 0);
    await expect(adapter.invoke({ provider: 'wavespeed', modelId: adapter.modelId, revision: adapter.revision, input, settings: {}, idempotencyKey: 'missing' })).rejects.toThrow('right image');
    await expect(adapter.invoke({ provider: 'wavespeed', modelId: adapter.modelId, revision: adapter.revision, input: multiviewInput(), settings: { auto_size: true }, idempotencyKey: 'override' })).rejects.toThrow('policy-bound fields: auto_size');
  });
});
