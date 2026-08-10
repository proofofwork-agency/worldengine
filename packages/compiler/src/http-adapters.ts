import { z } from 'zod';
import { ProviderRequestGuard, type ProviderAdapter, type ProviderInvocation } from './provider.js';
import { assertValidGlb } from './asset-validation.js';

function rejectReservedSettings(settings: Record<string, unknown>, reserved: readonly string[], provider: string): void {
  const conflicts = reserved.filter((key) => Object.prototype.hasOwnProperty.call(settings, key));
  if (conflicts.length > 0) throw new Error(`${provider} settings may not override policy-bound fields: ${conflicts.join(', ')}`);
}

export function assertSafeRemoteHttpsUrl(value: string, label: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const privateIpv4 = ipv4 && ipv4.every((part) => part >= 0 && part <= 255) && (
    ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0]! >= 224
    || (ipv4[0] === 100 && ipv4[1]! >= 64 && ipv4[1]! <= 127)
    || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168)
  );
  const privateIpv6 = hostname === '::' || hostname === '::1' || /^f[cd][0-9a-f]{2}:/i.test(hostname) || /^fe[89ab][0-9a-f]:/i.test(hostname);
  if (url.protocol !== 'https:' || url.username || url.password || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || privateIpv4 || privateIpv6) throw new Error(`${label} must be a public HTTPS URL without credentials`);
  return url;
}

export interface JsonPlanningInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }>;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
}

export class OpenRouterPlanningAdapter implements ProviderAdapter<JsonPlanningInput, unknown> {
  readonly provider = 'openrouter';
  private readonly guard = new ProviderRequestGuard();

  constructor(
    readonly modelId: string,
    readonly revision: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = 'https://openrouter.ai/api/v1',
  ) {}

  async checkCapabilities(): Promise<{ structuredOutput: boolean; imageInput: boolean }> {
    const [author, ...slugParts] = this.modelId.split('/');
    if (!author || slugParts.length === 0) return { structuredOutput: false, imageInput: false };
    const response = await this.fetcher(`${this.baseUrl}/model/${encodeURIComponent(author)}/${slugParts.map(encodeURIComponent).join('/')}`, { headers: this.headers() });
    if (!response.ok) throw new Error(`OpenRouter capability check failed: ${response.status}`);
    const body = await response.json() as { data?: { supported_parameters?: string[]; architecture?: { input_modalities?: string[] } } };
    const model = body.data ?? {};
    return {
      structuredOutput: model.supported_parameters?.includes('response_format') ?? false,
      imageInput: model.architecture?.input_modalities?.includes('image') ?? false,
    };
  }

  async estimate(): Promise<number> {
    throw new Error('OpenRouter cost must come from the reviewed provider profile and request token budget');
  }

  async invoke(request: ProviderInvocation<JsonPlanningInput, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.guard.invokeOnce(request.idempotencyKey, () => this.invokeRequest(request, signal));
  }

  private async invokeRequest(request: ProviderInvocation<JsonPlanningInput, unknown>, signal?: AbortSignal): Promise<unknown> {
    rejectReservedSettings(request.settings, ['model', 'messages', 'response_format', 'provider'], 'OpenRouter');
    const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: 'POST', ...(signal ? { signal } : {}),
      headers: { ...this.headers(), 'content-type': 'application/json', 'x-idempotency-key': request.idempotencyKey },
      body: JSON.stringify({
        model: this.modelId,
        messages: request.input.messages,
        response_format: { type: 'json_schema', json_schema: { name: request.input.schemaName, strict: true, schema: request.input.jsonSchema } },
        provider: { allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true },
        ...request.settings,
      }),
    });
    if (!response.ok) throw new Error(`OpenRouter request failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenRouter returned no structured content');
    return JSON.parse(content) as unknown;
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is required');
    return { authorization: `Bearer ${this.apiKey}` };
  }
}

const ImageGenerationInputSchema = z.object({
  prompt: z.string().min(1),
  size: z.enum(['1024x1024', '1536x1024', '1024x1536', 'auto']).default('1024x1024'),
  quality: z.enum(['low', 'medium', 'high', 'auto']).default('auto'),
  background: z.enum(['transparent', 'opaque', 'auto']).default('auto'),
  n: z.number().int().min(1).max(10).default(1),
  inputImages: z.array(z.object({ source: z.string().min(1), contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional() })).max(16).default([]),
});
export type ImageGenerationInput = z.infer<typeof ImageGenerationInputSchema>;
export interface GeneratedImageOutput { images: Array<{ base64?: string; url?: string; revisedPrompt?: string }> }

export class OpenAIImageAdapter implements ProviderAdapter<ImageGenerationInput, GeneratedImageOutput> {
  readonly provider = 'openai';
  private readonly guard = new ProviderRequestGuard();

  constructor(
    readonly modelId: string,
    readonly revision: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async checkCapabilities(): Promise<{ structuredOutput: boolean; imageInput: boolean }> {
    return { structuredOutput: false, imageInput: true };
  }

  async estimate(): Promise<number> {
    throw new Error('OpenAI image cost must come from the reviewed provider profile');
  }

  async invoke(request: ProviderInvocation<ImageGenerationInput, GeneratedImageOutput>, signal?: AbortSignal): Promise<GeneratedImageOutput> {
    return this.guard.invokeOnce(request.idempotencyKey, () => this.invokeRequest(request, signal));
  }

  private async invokeRequest(request: ProviderInvocation<ImageGenerationInput, GeneratedImageOutput>, signal?: AbortSignal): Promise<GeneratedImageOutput> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required');
    rejectReservedSettings(request.settings, ['model', 'prompt', 'size', 'quality', 'background', 'n', 'image', 'inputImages'], 'OpenAI image');
    const input = ImageGenerationInputSchema.parse(request.input);
    const commonHeaders = { authorization: `Bearer ${this.apiKey}`, 'idempotency-key': request.idempotencyKey };
    let response: Response;
    if (input.inputImages.length > 0) {
      const form = new FormData();
      form.append('model', this.revision || this.modelId);
      form.append('prompt', input.prompt); form.append('size', input.size); form.append('quality', input.quality); form.append('background', input.background); form.append('n', String(input.n));
      for (const [key, value] of Object.entries(request.settings)) if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') form.append(key, String(value));
      for (let index = 0; index < input.inputImages.length; index += 1) {
        const image = input.inputImages[index]!;
        let bytes: Uint8Array;
        let contentType = image.contentType;
        if (image.source.startsWith('data:')) {
          const match = image.source.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=]+)$/i);
          if (!match) throw new Error('OpenAI edit input must be a base64 PNG, JPEG, or WebP data URL');
          if (!contentType) {
            const detected = match[1]!.toLowerCase();
            if (detected === 'image/png' || detected === 'image/jpeg' || detected === 'image/webp') contentType = detected;
          }
          bytes = new Uint8Array(Buffer.from(match[2]!, 'base64'));
        } else {
          const source = assertSafeRemoteHttpsUrl(image.source, 'OpenAI edit input URL');
          const fetched = await this.fetcher(source, { ...(signal ? { signal } : {}) });
          if (!fetched.ok) throw new Error(`Unable to download OpenAI edit input: ${fetched.status}`);
          bytes = new Uint8Array(await fetched.arrayBuffer());
          const declared = fetched.headers.get('content-type')?.split(';', 1)[0];
          if (!contentType && (declared === 'image/png' || declared === 'image/jpeg' || declared === 'image/webp')) contentType = declared;
        }
        if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) throw new Error('OpenAI edit input is empty or exceeds 50 MB');
        const upload = new Uint8Array(bytes.byteLength); upload.set(bytes);
        form.append('image[]', new Blob([upload.buffer], { type: contentType ?? 'image/png' }), `input-${index}.${contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/webp' ? 'webp' : 'png'}`);
      }
      response = await this.fetcher(`${this.baseUrl}/images/edits`, { method: 'POST', ...(signal ? { signal } : {}), headers: commonHeaders, body: form });
    } else {
      const { inputImages: _inputImages, ...generationInput } = input;
      response = await this.fetcher(`${this.baseUrl}/images/generations`, {
        method: 'POST', ...(signal ? { signal } : {}), headers: { ...commonHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.revision || this.modelId, ...generationInput, ...request.settings }),
      });
    }
    if (!response.ok) throw new Error(`OpenAI image request failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
    return { images: (body.data ?? []).map((image) => ({
      ...(image.b64_json ? { base64: image.b64_json } : {}),
      ...(image.url ? { url: image.url } : {}),
      ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {}),
    })) };
  }
}

const TripoInputSchema = z.object({
  image: z.string().url(), texture: z.boolean().default(true), pbr: z.boolean().default(true),
  texture_quality: z.enum(['standard', 'detailed']).default('standard'),
  geometry_quality: z.enum(['standard', 'detailed']).default('standard'),
  texture_alignment: z.enum(['original_image', 'geometry']).default('original_image'),
  orientation: z.enum(['default', 'align_image']).default('default'), auto_size: z.boolean().default(false), quad: z.boolean().default(false),
  face_limit: z.number().int().min(1000).max(2_000_000).optional(), model_seed: z.number().int().optional(), texture_seed: z.number().int().optional(),
});
export type TripoImageTo3DInput = z.infer<typeof TripoInputSchema>;
export interface PredictionOutput { predictionId: string; outputs: Array<{ sourceUrl: string; bytes: Uint8Array; contentType: string }> }

export class WaveSpeedTripoAdapter implements ProviderAdapter<TripoImageTo3DInput, PredictionOutput> {
  readonly provider = 'wavespeed';
  private readonly guard = new ProviderRequestGuard();

  constructor(
    readonly modelId = 'tripo3d/h3.1/image-to-3d',
    readonly revision = 'operator-selects',
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.wavespeed.ai/api/v3',
    private readonly pollIntervalMs = 2_000,
  ) {}

  async checkCapabilities(): Promise<{ structuredOutput: boolean; imageInput: boolean }> {
    return { structuredOutput: false, imageInput: true };
  }

  async estimate(input: TripoImageTo3DInput): Promise<number> {
    const valid = TripoInputSchema.parse(input);
    let cost = valid.texture ? (valid.texture_quality === 'detailed' ? 0.4 : 0.3) : 0.2;
    if (valid.geometry_quality === 'detailed') cost += 0.2;
    if (valid.quad) cost += 0.05;
    return cost;
  }

  async invoke(request: ProviderInvocation<TripoImageTo3DInput, PredictionOutput>, signal?: AbortSignal): Promise<PredictionOutput> {
    return this.guard.invokeOnce(request.idempotencyKey, () => this.invokeRequest(request, signal));
  }

  private async invokeRequest(request: ProviderInvocation<TripoImageTo3DInput, PredictionOutput>, signal?: AbortSignal): Promise<PredictionOutput> {
    if (!this.apiKey) throw new Error('WAVESPEED_API_KEY is required');
    const input = TripoInputSchema.parse(request.input);
    rejectReservedSettings(request.settings, Object.keys(input), 'WaveSpeed Tripo');
    const response = await this.fetcher(`${this.baseUrl}/${this.modelId}`, {
      method: 'POST', ...(signal ? { signal } : {}),
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'x-idempotency-key': request.idempotencyKey },
      body: JSON.stringify({ ...input, ...request.settings }),
    });
    if (!response.ok) throw new Error(`WaveSpeed submission failed: ${response.status} ${await response.text()}`);
    const submitted = await response.json() as { code?: number; message?: string; data?: PredictionRecord };
    if (submitted.code !== undefined && submitted.code !== 200) throw new Error(submitted.message ?? 'WaveSpeed submission failed');
    let prediction = submitted.data;
    if (!prediction?.id) throw new Error('WaveSpeed response did not contain a prediction id');
    const resultUrl = assertSafeRemoteHttpsUrl(prediction.urls?.get ?? `${this.baseUrl}/predictions/${prediction.id}/result`, 'WaveSpeed result URL');
    if (resultUrl.origin !== new URL(this.baseUrl).origin) throw new Error('WaveSpeed result URL must remain on the configured API origin');
    while (!['completed', 'failed', 'cancelled', 'timeout'].includes(prediction.status)) {
      await abortableDelay(this.pollIntervalMs, signal);
      const result = await this.fetcher(resultUrl, { headers: { authorization: `Bearer ${this.apiKey}` }, ...(signal ? { signal } : {}) });
      if (!result.ok) throw new Error(`WaveSpeed result query failed: ${result.status}`);
      const body = await result.json() as { data?: PredictionRecord };
      if (body.data) prediction = body.data;
    }
    if (prediction.status !== 'completed') throw new Error(`WaveSpeed prediction ${prediction.status}: ${prediction.error ?? 'unknown error'}`);
    const outputs = await Promise.all((prediction.outputs ?? []).map(async (sourceUrl) => {
      const parsedUrl = assertSafeRemoteHttpsUrl(sourceUrl, 'WaveSpeed output URL');
      const download = await this.fetcher(parsedUrl, signal ? { signal } : {});
      if (!download.ok) throw new Error(`Unable to ingest WaveSpeed output: ${download.status}`);
      const declaredLength = Number(download.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > 512 * 1024 * 1024) throw new Error('WaveSpeed output exceeds the 512 MB ingestion limit');
      const bytes = new Uint8Array(await download.arrayBuffer());
      if (bytes.byteLength > 512 * 1024 * 1024) throw new Error('WaveSpeed output exceeds the 512 MB ingestion limit');
      const contentType = download.headers.get('content-type') ?? 'application/octet-stream';
      if (sourceUrl.toLowerCase().endsWith('.glb') || contentType === 'model/gltf-binary') assertValidGlb(bytes);
      return { sourceUrl, bytes, contentType };
    }));
    return { predictionId: prediction.id, outputs };
  }
}

interface PredictionRecord { id: string; status: string; outputs?: string[]; urls?: { get?: string }; error?: string }

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
  });
}

const MultiImageTo3DInputSchema = z.object({
  images: z.array(z.object({ source: z.string().min(1), orientation: z.enum(['front', 'left', 'back', 'right', 'perspective']) })).min(2).max(5),
  pbr: z.literal(true).default(true),
  geometryQuality: z.enum(['standard', 'detailed']).default('detailed'),
  textureResolution: z.enum(['2k', '4k']).default('4k'),
  faceLimit: z.number().int().min(10_000).max(2_000_000).default(250_000),
  seed: z.number().int().nonnegative(),
});
export type MultiImageTo3DInput = z.infer<typeof MultiImageTo3DInputSchema>;

const cardinalOrientations = ['front', 'left', 'back', 'right'] as const;

function cardinalViews(input: MultiImageTo3DInput): Array<MultiImageTo3DInput['images'][number]> {
  return cardinalOrientations.map((orientation) => {
    const image = input.images.find((candidate) => candidate.orientation === orientation);
    if (!image) throw new Error(`Multiview reconstruction requires exactly one ${orientation} image`);
    return image;
  });
}

async function downloadGlb(source: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<{ sourceUrl: string; bytes: Uint8Array; contentType: string }> {
  const url = assertSafeRemoteHttpsUrl(source, '3D provider GLB output URL');
  const response = await fetcher(url, signal ? { signal } : {});
  if (!response.ok) throw new Error(`Unable to ingest 3D provider output: ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > 512 * 1024 * 1024) throw new Error('3D provider output exceeds 512 MB');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 512 * 1024 * 1024) throw new Error('3D provider output exceeds 512 MB');
  assertValidGlb(bytes);
  return { sourceUrl: url.href, bytes, contentType: 'model/gltf-binary' };
}

/** Direct Tripo multiview adapter. The exact model revision is supplied by the
 * reviewed operator policy; aliases such as "latest" are rejected upstream. */
export class DirectTripoMultiviewAdapter implements ProviderAdapter<MultiImageTo3DInput, PredictionOutput> {
  readonly provider = 'tripo';
  private readonly guard = new ProviderRequestGuard();

  constructor(
    readonly modelId: string,
    readonly revision: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.tripo3d.ai/v2/openapi',
    private readonly pollIntervalMs = 2_000,
  ) {}

  async checkCapabilities() { return { structuredOutput: false, imageInput: true, multiImageInput: true, pbr3d: true }; }
  async estimate(): Promise<number> { throw new Error('Tripo cost must come from the reviewed provider profile'); }
  async invoke(request: ProviderInvocation<MultiImageTo3DInput, PredictionOutput>, signal?: AbortSignal): Promise<PredictionOutput> {
    return this.guard.invokeOnce(request.idempotencyKey, () => this.invokeRequest(request, signal));
  }

  private async invokeRequest(request: ProviderInvocation<MultiImageTo3DInput, PredictionOutput>, signal?: AbortSignal): Promise<PredictionOutput> {
    if (!this.apiKey) throw new Error('TRIPO_API_KEY is required');
    const input = MultiImageTo3DInputSchema.parse(request.input);
    rejectReservedSettings(request.settings, ['type', 'files', 'model_version', 'pbr', 'texture', 'texture_quality', 'texture_alignment', 'orientation', 'face_limit', 'model_seed'], 'Tripo');
    const files = [] as Array<{ type: 'jpg' | 'png'; file_token: string }>;
    for (const image of cardinalViews(input)) {
      const form = new FormData();
      let bytes: Uint8Array;
      let mime = 'image/png';
      if (image.source.startsWith('data:')) {
        const match = image.source.match(/^data:(image\/(?:png|jpeg));base64,([a-z\d+/=]+)$/i);
        if (!match) throw new Error('Tripo multiview input must be a PNG/JPEG data URL or public HTTPS URL');
        mime = match[1]!.toLowerCase(); bytes = new Uint8Array(Buffer.from(match[2]!, 'base64'));
      } else {
        const source = assertSafeRemoteHttpsUrl(image.source, 'Tripo multiview input URL');
        const downloaded = await this.fetcher(source, signal ? { signal } : {});
        if (!downloaded.ok) throw new Error(`Unable to ingest Tripo input: ${downloaded.status}`);
        bytes = new Uint8Array(await downloaded.arrayBuffer()); mime = downloaded.headers.get('content-type')?.split(';', 1)[0] ?? mime;
      }
      const uploadBytes = new Uint8Array(bytes); form.append('file', new Blob([uploadBytes.buffer], { type: mime }), mime === 'image/jpeg' ? 'view.jpg' : 'view.png');
      const upload = await this.fetcher(`${this.baseUrl}/upload/sts`, { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` }, body: form, ...(signal ? { signal } : {}) });
      if (!upload.ok) throw new Error(`Tripo upload failed: ${upload.status} ${await upload.text()}`);
      const body = await upload.json() as { code?: number; message?: string; data?: { image_token?: string } };
      if (body.code !== undefined && body.code !== 0) throw new Error(body.message ?? `Tripo upload failed with code ${body.code}`);
      const token = body.data?.image_token;
      if (!token) throw new Error('Tripo upload returned no file token');
      files.push({ type: mime === 'image/jpeg' ? 'jpg' : 'png', file_token: token });
    }
    const submitted = await this.fetcher(`${this.baseUrl}/task`, {
      method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'x-idempotency-key': request.idempotencyKey }, ...(signal ? { signal } : {}),
      body: JSON.stringify({
        type: 'multiview_to_model', files, model_version: this.revision,
        pbr: true, texture: true, texture_quality: input.textureResolution === '4k' ? 'detailed' : 'standard',
        texture_alignment: 'geometry', orientation: 'align_image', face_limit: input.faceLimit, model_seed: input.seed,
        ...request.settings,
      }),
    });
    if (!submitted.ok) throw new Error(`Tripo submission failed: ${submitted.status} ${await submitted.text()}`);
    const submission = await submitted.json() as { code?: number; message?: string; data?: { task_id?: string } };
    if (submission.code !== undefined && submission.code !== 0) throw new Error(submission.message ?? `Tripo submission failed with code ${submission.code}`);
    const taskId = submission.data?.task_id;
    if (!taskId) throw new Error('Tripo submission returned no task id');
    let result: { status?: string; output?: { model?: string; pbr_model?: string }; error?: string } = {};
    while (!['success', 'failed', 'cancelled', 'canceled'].includes(result.status ?? '')) {
      await abortableDelay(this.pollIntervalMs, signal);
      const poll = await this.fetcher(`${this.baseUrl}/task/${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${this.apiKey}` }, ...(signal ? { signal } : {}) });
      if (!poll.ok) throw new Error(`Tripo result query failed: ${poll.status}`);
      const body = await poll.json() as { data?: typeof result }; result = body.data ?? {};
    }
    if (result.status !== 'success') throw new Error(`Tripo task ${result.status}: ${result.error ?? 'unknown error'}`);
    const source = result.output?.pbr_model ?? result.output?.model;
    if (!source) throw new Error('Tripo task returned no GLB URL');
    return { predictionId: taskId, outputs: [await downloadGlb(source, this.fetcher, signal)] };
  }
}

export class MeshyMultiImageAdapter implements ProviderAdapter<MultiImageTo3DInput, PredictionOutput> {
  readonly provider = 'meshy';
  private readonly guard = new ProviderRequestGuard();

  constructor(
    readonly modelId: string,
    readonly revision: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.meshy.ai/openapi/v1',
    private readonly pollIntervalMs = 2_000,
  ) {}

  async checkCapabilities() { return { structuredOutput: false, imageInput: true, multiImageInput: true, pbr3d: true }; }
  async estimate(): Promise<number> { throw new Error('Meshy cost must come from the reviewed provider profile'); }
  async invoke(request: ProviderInvocation<MultiImageTo3DInput, PredictionOutput>, signal?: AbortSignal): Promise<PredictionOutput> {
    return this.guard.invokeOnce(request.idempotencyKey, () => this.invokeRequest(request, signal));
  }

  private async invokeRequest(request: ProviderInvocation<MultiImageTo3DInput, PredictionOutput>, signal?: AbortSignal): Promise<PredictionOutput> {
    if (!this.apiKey) throw new Error('MESHY_API_KEY is required');
    const input = MultiImageTo3DInputSchema.parse(request.input);
    rejectReservedSettings(request.settings, ['image_urls', 'ai_model', 'enable_pbr', 'texture_resolution', 'should_remesh', 'should_texture', 'topology', 'target_polycount', 'target_formats', 'image_enhancement', 'remove_lighting'], 'Meshy');
    const response = await this.fetcher(`${this.baseUrl}/multi-image-to-3d`, {
      method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'x-idempotency-key': request.idempotencyKey }, ...(signal ? { signal } : {}),
      body: JSON.stringify({
        image_urls: cardinalViews(input).map((image) => image.source), ai_model: this.revision,
        enable_pbr: true, texture_resolution: input.textureResolution, should_remesh: true, should_texture: true,
        topology: 'triangle', target_polycount: input.faceLimit, target_formats: ['glb'], image_enhancement: false, remove_lighting: true,
        ...request.settings,
      }),
    });
    if (!response.ok) throw new Error(`Meshy submission failed: ${response.status} ${await response.text()}`);
    const submitted = await response.json() as { result?: string; id?: string };
    const taskId = submitted.result ?? submitted.id;
    if (!taskId) throw new Error('Meshy submission returned no task id');
    let result: { status?: string; model_urls?: { glb?: string }; task_error?: { message?: string } } = {};
    while (!['SUCCEEDED', 'FAILED', 'CANCELED'].includes(result.status ?? '')) {
      await abortableDelay(this.pollIntervalMs, signal);
      const poll = await this.fetcher(`${this.baseUrl}/multi-image-to-3d/${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${this.apiKey}` }, ...(signal ? { signal } : {}) });
      if (!poll.ok) throw new Error(`Meshy result query failed: ${poll.status}`);
      result = await poll.json() as typeof result;
    }
    if (result.status !== 'SUCCEEDED') throw new Error(`Meshy task ${result.status}: ${result.task_error?.message ?? 'unknown error'}`);
    if (!result.model_urls?.glb) throw new Error('Meshy task returned no GLB URL');
    return { predictionId: taskId, outputs: [await downloadGlb(result.model_urls.glb, this.fetcher, signal)] };
  }
}
