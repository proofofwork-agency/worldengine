import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompileRequestSchema } from '@worldengine/schema';
import { FileArtifactCache } from './artifact-cache.js';
import { CompileDagExecutor, DagValidationError, MemoryDagCheckpointStore } from './dag.js';
import { OpenAIImageAdapter, OpenRouterPlanningAdapter, WaveSpeedTripoAdapter } from './http-adapters.js';
import { DeterministicWorldCompiler } from './pipeline.js';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

describe('durable compile DAG', () => {
  it('checkpoints completed nodes and resumes without rerunning them', async () => {
    const store = new MemoryDagCheckpointStore();
    const executor = new CompileDagExecutor<{ calls: string[] }>(store);
    const nodes = [
      { id: 'a', run: async ({ shared }: { shared: { calls: string[] } }) => { shared.calls.push('a'); return 2; } },
      { id: 'b', dependencies: ['a'], run: async ({ shared, output }: { shared: { calls: string[] }; output<T>(id: string): T }) => { shared.calls.push('b'); return output<number>('a') * 3; } },
    ];
    const first = { calls: [] as string[] };
    expect((await executor.execute('run', nodes, first))[1]?.output).toBe(6);
    const resumed = { calls: [] as string[] };
    expect((await executor.execute('run', nodes, resumed))[1]?.output).toBe(6);
    expect(resumed.calls).toEqual([]);
  });

  it('rejects cyclic graphs', async () => {
    const executor = new CompileDagExecutor();
    await expect(executor.execute('cycle', [
      { id: 'a', dependencies: ['b'], run: async () => null },
      { id: 'b', dependencies: ['a'], run: async () => null },
    ], {})).rejects.toBeInstanceOf(DagValidationError);
  });

  it('reuses validated compile artifacts by deterministic cache key', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-cache-'));
    const compiler = new DeterministicWorldCompiler({ artifactCache: new FileArtifactCache(directory) });
    const request = CompileRequestSchema.parse({ prompt: 'cached valley', seed: 10, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: false, dryRun: true });
    const first = []; for await (const event of compiler.compile(request, 'first')) first.push(event);
    const second = []; for await (const event of compiler.compile(request, 'second')) second.push(event);
    expect(first.find((event) => event.type === 'artifact')?.data['cached']).toBe(false);
    expect(second.find((event) => event.type === 'artifact')?.data['cached']).toBe(true);
  });

  it('never lets a dry-run satisfy an execution cache lookup and rejects a generation cap outside the selected profile', async () => {
    directory = await mkdtemp(join(tmpdir(), 'worldengine-cache-gate-'));
    const compiler = new DeterministicWorldCompiler({ artifactCache: new FileArtifactCache(directory) });
    const base = { prompt: 'cache-separated valley', seed: 11, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: false };
    const dryRun = CompileRequestSchema.parse({ ...base, dryRun: true });
    const execute = CompileRequestSchema.parse({ ...base, dryRun: false });
    const differentCap = CompileRequestSchema.parse({ ...base, dryRun: false, maxAssetGenerations: 1 });
    const dryEvents = []; for await (const event of compiler.compile(dryRun, 'dry-run')) dryEvents.push(event);
    const executeEvents = []; for await (const event of compiler.compile(execute, 'execute')) executeEvents.push(event);
    const repeatedEvents = []; for await (const event of compiler.compile(execute, 'execute-repeat')) repeatedEvents.push(event);
    const cappedEvents = []; for await (const event of compiler.compile(differentCap, 'different-cap')) cappedEvents.push(event);
    expect(dryEvents.find((event) => event.type === 'artifact')?.data['cached']).toBe(false);
    expect(executeEvents.find((event) => event.type === 'artifact')?.data['cached']).toBe(false);
    expect(repeatedEvents.find((event) => event.type === 'artifact')?.data['cached']).toBe(true);
    expect(cappedEvents.find((event) => event.type === 'artifact')).toBeUndefined();
    expect(cappedEvents.find((event) => event.type === 'failed')?.message).toContain('local profile allows at most 0 generated assets');
  });
});

describe('provider HTTP contracts', () => {
  it('enforces no-fallback ZDR structured planning through OpenRouter', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/model/')) return new Response(JSON.stringify({ data: { supported_parameters: ['response_format'], architecture: { input_modalities: ['text', 'image'] } } }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { provider: Record<string, unknown> };
      expect(body.provider).toMatchObject({ allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    }) as typeof fetch;
    const adapter = new OpenRouterPlanningAdapter('openai/test', 'r1', 'secret', fetcher, 'https://router.test');
    expect(await adapter.checkCapabilities()).toEqual({ structuredOutput: true, imageInput: true });
    expect(await adapter.invoke({ provider: 'openrouter', modelId: 'openai/test', revision: 'r1', idempotencyKey: 'key', input: { messages: [{ role: 'user', content: 'plan' }], schemaName: 'plan', jsonSchema: { type: 'object' } }, settings: {} })).toEqual({ ok: true });
  });

  it('uses the pinned OpenAI image revision and idempotency key', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'idempotency-key': 'image-key' });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-image-2-2026-04-21', background: 'transparent' });
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 });
    }) as typeof fetch;
    const adapter = new OpenAIImageAdapter('gpt-image-2', 'gpt-image-2-2026-04-21', 'secret', fetcher, 'https://openai.test');
    const invocation = { provider: 'openai', modelId: adapter.modelId, revision: adapter.revision, idempotencyKey: 'image-key', input: { prompt: 'isolated tree', size: '1024x1024' as const, quality: 'auto' as const, background: 'transparent' as const, n: 1, inputImages: [] }, settings: {} };
    const [first, duplicate] = await Promise.all([adapter.invoke(invocation), adapter.invoke(invocation)]);
    expect(first).toEqual({ images: [{ base64: 'aW1hZ2U=' }] });
    expect(duplicate).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never blindly retries a failed billable provider POST', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'temporary provider failure' } }), { status: 503 })) as typeof fetch;
    const adapter = new OpenAIImageAdapter('gpt-image-2', 'gpt-image-2-2026-04-21', 'secret', fetcher, 'https://openai.test');
    await expect(adapter.invoke({
      provider: 'openai', modelId: adapter.modelId, revision: adapter.revision, idempotencyKey: 'failed-image-key', settings: {},
      input: { prompt: 'isolated tree', size: '1024x1024', quality: 'auto', background: 'transparent', n: 1, inputImages: [] },
    })).rejects.toThrow('503');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses multipart image editing for terrain-conditioned compositions', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://openai.test/images/edits');
      expect(init?.headers).toMatchObject({ 'idempotency-key': 'terrain-edit-key' });
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('gpt-image-2-2026-04-21');
      expect(form.get('prompt')).toBe('preserve terrain and add a village');
      expect(form.getAll('image[]')).toHaveLength(1);
      return new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }), { status: 200 });
    }) as typeof fetch;
    const adapter = new OpenAIImageAdapter('gpt-image-2', 'gpt-image-2-2026-04-21', 'secret', fetcher, 'https://openai.test');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const output = await adapter.invoke({
      provider: 'openai', modelId: adapter.modelId, revision: adapter.revision, idempotencyKey: 'terrain-edit-key', settings: {},
      input: { prompt: 'preserve terrain and add a village', size: '1536x1024', quality: 'high', background: 'opaque', n: 1, inputImages: [{ source: `data:image/png;base64,${png}`, contentType: 'image/png' }] },
    });
    expect(output.images).toHaveLength(1);
  });

  it('submits WaveSpeed once, polls with GET, and immediately ingests output bytes', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/tripo3d/h3.1/image-to-3d')) return new Response(JSON.stringify({ code: 200, data: { id: 'prediction', status: 'created', urls: { get: 'https://wavespeed.test/result' } } }), { status: 200 });
      if (url.endsWith('/result')) { expect(init?.method).toBeUndefined(); return new Response(JSON.stringify({ data: { id: 'prediction', status: 'completed', outputs: ['https://cdn.test/model.bin'] } }), { status: 200 }); }
      return new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }) as typeof fetch;
    const adapter = new WaveSpeedTripoAdapter('tripo3d/h3.1/image-to-3d', 'r1', 'secret', fetcher, 'https://wavespeed.test', 0);
    const output = await adapter.invoke({ provider: 'wavespeed', modelId: adapter.modelId, revision: adapter.revision, idempotencyKey: '3d-key', input: { image: 'https://images.test/tree.png', texture: true, pbr: true, texture_quality: 'standard', geometry_quality: 'standard', texture_alignment: 'original_image', orientation: 'default', auto_size: false, quad: false }, settings: {} });
    expect(output.predictionId).toBe('prediction');
    expect([...output.outputs[0]!.bytes]).toEqual([0x67, 0x6c, 0x54, 0x46]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('never forwards the WaveSpeed bearer token to a cross-origin result URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 200, data: { id: 'prediction', status: 'created', urls: { get: 'https://attacker.test/result' } } }), { status: 200 })) as typeof fetch;
    const adapter = new WaveSpeedTripoAdapter('tripo3d/h3.1/image-to-3d', 'r1', 'secret', fetcher, 'https://wavespeed.test', 0);
    await expect(adapter.invoke({
      provider: 'wavespeed', modelId: adapter.modelId, revision: adapter.revision, idempotencyKey: 'cross-origin-result', settings: {},
      input: { image: 'https://images.test/tree.png', texture: true, pbr: true, texture_quality: 'standard', geometry_quality: 'standard', texture_alignment: 'original_image', orientation: 'default', auto_size: false, quad: false },
    })).rejects.toThrow('configured API origin');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
