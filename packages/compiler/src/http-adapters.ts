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

function normalizeOpenAiStructuredOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeOpenAiStructuredOutputSchema);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const schemaNode = 'type' in source || 'anyOf' in source || '$ref' in source || '$schema' in source;
  const normalized = Object.fromEntries(Object.entries(source)
    .filter(([key]) => !(schemaNode && (key === '$schema' || key === 'default' || key === 'format')))
    .map(([key, child]) => [key, normalizeOpenAiStructuredOutputSchema(child)]));
  if (Array.isArray(normalized['items'])) {
    const tupleItems = normalized['items'] as unknown[];
    if (tupleItems.length === 0) throw new Error('Structured-output tuple schemas must contain at least one item');
    const signatures = tupleItems.map((item) => JSON.stringify(item));
    if (!signatures.every((signature) => signature === signatures[0])) throw new Error('OpenAI structured outputs do not support heterogeneous tuple schemas');
    normalized['items'] = tupleItems[0];
    normalized['minItems'] = tupleItems.length;
    normalized['maxItems'] = tupleItems.length;
  }
  return normalized;
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
        response_format: { type: 'json_schema', json_schema: { name: request.input.schemaName, strict: true, schema: normalizeOpenAiStructuredOutputSchema(request.input.jsonSchema) } },
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

/**
 * OpenRouter's dedicated Images API is intentionally exposed as a separate
 * provider identity. This prevents an image model from being registered behind
 * the structured chat adapter merely because both use OPENROUTER_API_KEY.
 */
export class OpenRouterImageAdapter implements ProviderAdapter<ImageGenerationInput, GeneratedImageOutput> {
  readonly provider = 'openrouter-image';
  private readonly guard = new ProviderRequestGuard();

  constructor(
    readonly modelId: string,
    readonly revision: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = 'https://openrouter.ai/api/v1',
  ) {}

  async checkCapabilities(): Promise<{ structuredOutput: boolean; imageInput: boolean }> {
    const response = await this.fetcher(`${this.baseUrl}/images/models`, { headers: this.headers() });
    if (!response.ok) throw new Error(`OpenRouter image capability check failed: ${response.status}`);
    const body = await response.json() as { data?: Array<{ id?: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] } }> };
    const model = body.data?.find((candidate) => candidate.id?.toLowerCase() === this.modelId.toLowerCase());
    if (!model) throw new Error(`OpenRouter image model ${this.modelId} is unavailable`);
    const outputImage = model.architecture?.output_modalities?.includes('image') ?? false;
    return { structuredOutput: false, imageInput: outputImage && (model.architecture?.input_modalities?.includes('image') ?? false) };
  }

  async estimate(): Promise<number> {
    throw new Error('OpenRouter image cost must come from the reviewed provider profile');
  }

  async invoke(request: ProviderInvocation<ImageGenerationInput, GeneratedImageOutput>, signal?: AbortSignal): Promise<GeneratedImageOutput> {
    return this.guard.invokeOnce(request.idempotencyKey, () => this.invokeRequest(request, signal));
  }

  private async invokeRequest(request: ProviderInvocation<ImageGenerationInput, GeneratedImageOutput>, signal?: AbortSignal): Promise<GeneratedImageOutput> {
    rejectReservedSettings(request.settings, ['model', 'prompt', 'size', 'quality', 'background', 'n', 'input_references', 'inputImages', 'provider'], 'OpenRouter image');
    const input = ImageGenerationInputSchema.parse(request.input);
    // OpenRouter's current GPT Image 2 catalog accepts only `auto` or `opaque`
    // backgrounds. Preserve the renderer-neutral API while degrading an
    // unsupported transparent request to the provider's supported `auto` mode.
    const background = input.background === 'transparent' ? 'auto' : input.background;
    const inputReferences = input.inputImages.map((image) => {
      if (image.source.startsWith('data:')) {
        const match = image.source.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=]+)$/i);
        if (!match) throw new Error('OpenRouter image reference must be a base64 PNG, JPEG, or WebP data URL');
        const bytes = Buffer.from(match[2]!, 'base64');
        if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) throw new Error('OpenRouter image reference is empty or exceeds 50 MB');
      } else {
        assertSafeRemoteHttpsUrl(image.source, 'OpenRouter image reference URL');
      }
      return { type: 'image_url' as const, image_url: { url: image.source } };
    });
    const response = await this.fetcher(`${this.baseUrl}/images`, {
      method: 'POST', ...(signal ? { signal } : {}),
      headers: { ...this.headers(), 'content-type': 'application/json', 'x-idempotency-key': request.idempotencyKey },
      body: JSON.stringify({
        model: this.modelId,
        prompt: input.prompt,
        size: input.size,
        quality: input.quality,
        background,
        output_format: 'png',
        n: input.n,
        ...(inputReferences.length > 0 ? { input_references: inputReferences } : {}),
        provider: { allow_fallbacks: false },
        ...request.settings,
      }),
    });
    if (!response.ok) throw new Error(`OpenRouter image request failed: ${response.status} ${await response.text()}`);
    const body = await response.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
    const images = (body.data ?? []).map((image) => ({
      ...(image.b64_json ? { base64: image.b64_json } : {}),
      ...(image.url ? { url: image.url } : {}),
      ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {}),
    }));
    if (images.length === 0) throw new Error('OpenRouter returned no generated images');
    return { images };
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is required');
    return { authorization: `Bearer ${this.apiKey}` };
  }
}

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

export const MultiImageTo3DInputSchema = z.object({
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

/** WaveSpeed-hosted Tripo H3.1 multiview. Studio always submits only the
 * ordered front/left/back/right cardinal set. */
export class WaveSpeedTripoMultiviewAdapter implements ProviderAdapter<MultiImageTo3DInput, PredictionOutput> {
  readonly provider = 'wavespeed';
  private readonly guard = new ProviderRequestGuard();

  constructor(
    readonly modelId = 'tripo3d/h3.1/multiview-to-3d',
    readonly revision = 'operator-selects',
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.wavespeed.ai/api/v3',
    private readonly pollIntervalMs = 2_000,
  ) {}

  async checkCapabilities() { return { structuredOutput: false, imageInput: true, multiImageInput: true, pbr3d: true }; }
  async estimate(): Promise<number> { throw new Error('WaveSpeed multiview cost must come from the reviewed provider profile'); }
  async invoke(request: ProviderInvocation<MultiImageTo3DInput, PredictionOutput>, signal?: AbortSignal): Promise<PredictionOutput> {
    return this.guard.invokeOnce(request.idempotencyKey, () => this.invokeRequest(request, signal));
  }

  private async invokeRequest(request: ProviderInvocation<MultiImageTo3DInput, PredictionOutput>, signal?: AbortSignal): Promise<PredictionOutput> {
    if (!this.apiKey) throw new Error('WAVESPEED_API_KEY is required');
    const input = MultiImageTo3DInputSchema.parse(request.input);
    const images = cardinalViews(input).map((image) => image.source);
    rejectReservedSettings(request.settings, ['images', 'pbr', 'geometry_quality', 'texture_quality', 'texture_resolution', 'texture_alignment', 'orientation', 'auto_size', 'quad', 'face_limit', 'model_seed', 'output_format'], 'WaveSpeed Tripo multiview');
    const response = await this.fetcher(`${this.baseUrl}/${this.modelId}`, {
      method: 'POST', ...(signal ? { signal } : {}),
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'x-idempotency-key': request.idempotencyKey },
      body: JSON.stringify({
        images, pbr: true, geometry_quality: input.geometryQuality, texture_quality: 'detailed', texture_resolution: input.textureResolution,
        texture_alignment: 'geometry', orientation: 'align_image', auto_size: false, quad: false, face_limit: input.faceLimit,
        model_seed: input.seed, output_format: 'glb', ...request.settings,
      }),
    });
    if (!response.ok) throw new Error(`WaveSpeed multiview submission failed: ${response.status} ${await response.text()}`);
    const submitted = await response.json() as { code?: number; message?: string; data?: PredictionRecord };
    if (submitted.code !== undefined && submitted.code !== 200) throw new Error(submitted.message ?? 'WaveSpeed multiview submission failed');
    let prediction = submitted.data;
    if (!prediction?.id) throw new Error('WaveSpeed multiview response did not contain a prediction id');
    const resultUrl = assertSafeRemoteHttpsUrl(prediction.urls?.get ?? `${this.baseUrl}/predictions/${prediction.id}/result`, 'WaveSpeed result URL');
    if (resultUrl.origin !== new URL(this.baseUrl).origin) throw new Error('WaveSpeed result URL must remain on the configured API origin');
    while (!['completed', 'failed', 'cancelled', 'timeout'].includes(prediction.status)) {
      await abortableDelay(this.pollIntervalMs, signal);
      const result = await this.fetcher(resultUrl, { headers: { authorization: `Bearer ${this.apiKey}` }, ...(signal ? { signal } : {}) });
      if (!result.ok) throw new Error(`WaveSpeed multiview result query failed: ${result.status}`);
      const body = await result.json() as { data?: PredictionRecord };
      if (body.data) prediction = body.data;
    }
    if (prediction.status !== 'completed') throw new Error(`WaveSpeed multiview prediction ${prediction.status}: ${prediction.error ?? 'unknown error'}`);
    return { predictionId: prediction.id, outputs: await Promise.all((prediction.outputs ?? []).filter((output) => output.toLowerCase().endsWith('.glb')).map((output) => downloadGlb(output, this.fetcher, signal))) };
  }
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
