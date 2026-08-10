import { describe, expect, it } from 'vitest';
import { DirectTripoMultiviewAdapter, MeshyMultiImageAdapter, type MultiImageTo3DInput } from './http-adapters.js';

function minimalGlb(): Uint8Array {
  const document = JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 12 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  });
  const jsonLength = Math.ceil(Buffer.byteLength(document) / 4) * 4;
  const totalLength = 12 + 8 + jsonLength + 8 + 12;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength); bytes.set(Buffer.from(document), 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, 12, true); view.setUint32(binaryHeader + 4, 0x004e4942, true);
  return bytes;
}

function multiviewInput(): MultiImageTo3DInput {
  const source = (value: number) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, value]).toString('base64')}`;
  return {
    images: [
      { source: source(5), orientation: 'perspective' },
      { source: source(3), orientation: 'back' },
      { source: source(1), orientation: 'front' },
      { source: source(4), orientation: 'right' },
      { source: source(2), orientation: 'left' },
    ],
    pbr: true, geometryQuality: 'detailed', textureResolution: '4k', faceLimit: 250_000, seed: 17,
  };
}

function glbResponse(): Response {
  const bytes = minimalGlb();
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, { headers: { 'content-type': 'model/gltf-binary' } });
}

describe('direct multiview provider contracts', () => {
  it('uses Tripo upload/sts and submits exactly four ordered cardinal file tokens', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let uploadIndex = 0;
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input); requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/upload/sts')) return Response.json({ code: 0, data: { image_token: `token-${++uploadIndex}` } });
      if (url.endsWith('/task') && init?.method === 'POST') return Response.json({ code: 0, data: { task_id: 'task-1' } });
      if (url.endsWith('/task/task-1')) return Response.json({ code: 0, data: { status: 'success', output: { pbr_model: 'https://assets.example/model.glb' } } });
      if (url === 'https://assets.example/model.glb') return glbResponse();
      return new Response('not found', { status: 404 });
    };
    const adapter = new DirectTripoMultiviewAdapter('multiview', 'v3.1-20260211', 'key', fetcher as typeof fetch, 'https://api.tripo3d.ai/v2/openapi', 0);
    const output = await adapter.invoke({ provider: 'tripo', modelId: 'multiview', revision: 'v3.1-20260211', input: multiviewInput(), settings: {}, idempotencyKey: 'tripo-once' });

    expect(output.predictionId).toBe('task-1');
    expect(requests.filter((request) => request.url.endsWith('/upload/sts'))).toHaveLength(4);
    expect(requests.some((request) => request.url.endsWith('/upload'))).toBe(false);
    const submission = requests.find((request) => request.url.endsWith('/task') && request.init?.method === 'POST')!;
    const body = JSON.parse(String(submission.init?.body)) as Record<string, unknown> & { files: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ type: 'multiview_to_model', model_version: 'v3.1-20260211', texture_quality: 'detailed', texture_alignment: 'geometry', orientation: 'align_image', face_limit: 250_000, model_seed: 17 });
    expect(body.files).toEqual([
      { type: 'png', file_token: 'token-1' }, { type: 'png', file_token: 'token-2' },
      { type: 'png', file_token: 'token-3' }, { type: 'png', file_token: 'token-4' },
    ]);
    expect(body.files.every((file) => !('orientation' in file))).toBe(true);
    expect(body).not.toHaveProperty('geometry_quality');
  });

  it('uses Meshy ai_model and limits reconstruction input to four cardinal images', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input); requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/multi-image-to-3d') && init?.method === 'POST') return Response.json({ result: 'meshy-1' });
      if (url.endsWith('/multi-image-to-3d/meshy-1')) return Response.json({ status: 'SUCCEEDED', model_urls: { glb: 'https://assets.example/meshy.glb' } });
      if (url === 'https://assets.example/meshy.glb') return glbResponse();
      return new Response('not found', { status: 404 });
    };
    const adapter = new MeshyMultiImageAdapter('multi-image-to-3d', 'meshy-6', 'key', fetcher as typeof fetch, 'https://api.meshy.ai/openapi/v1', 0);
    const output = await adapter.invoke({ provider: 'meshy', modelId: 'multi-image-to-3d', revision: 'meshy-6', input: multiviewInput(), settings: {}, idempotencyKey: 'meshy-once' });

    expect(output.predictionId).toBe('meshy-1');
    const submission = requests.find((request) => request.url.endsWith('/multi-image-to-3d') && request.init?.method === 'POST')!;
    const body = JSON.parse(String(submission.init?.body)) as Record<string, unknown> & { image_urls: string[] };
    expect(body.image_urls).toHaveLength(4);
    expect(body).toMatchObject({ ai_model: 'meshy-6', enable_pbr: true, texture_resolution: '4k', should_remesh: true, should_texture: true, topology: 'triangle', target_polycount: 250_000, target_formats: ['glb'], image_enhancement: false, remove_lighting: true });
    expect(body).not.toHaveProperty('model_type');
  });

  it('fails closed if a cardinal reconstruction view is absent', async () => {
    const input = multiviewInput();
    input.images = input.images.filter((image) => image.orientation !== 'right');
    const adapter = new MeshyMultiImageAdapter('multi-image-to-3d', 'meshy-6', 'key', async () => new Response() as never, undefined, 0);
    await expect(adapter.invoke({ provider: 'meshy', modelId: 'multi-image-to-3d', revision: 'meshy-6', input, settings: {}, idempotencyKey: 'missing-view' })).rejects.toThrow('right image');
  });

  it('does not let provider settings replace the reviewed model revision', async () => {
    const adapter = new MeshyMultiImageAdapter('multi-image-to-3d', 'meshy-6', 'key', async () => new Response() as never, undefined, 0);
    await expect(adapter.invoke({ provider: 'meshy', modelId: 'multi-image-to-3d', revision: 'meshy-6', input: multiviewInput(), settings: { ai_model: 'latest' }, idempotencyKey: 'model-override' })).rejects.toThrow('policy-bound fields: ai_model');
  });
});
