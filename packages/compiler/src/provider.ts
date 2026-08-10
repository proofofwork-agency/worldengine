import { createHash } from 'node:crypto';

export interface ProviderInvocation<TInput, TOutput> {
  provider: string;
  modelId: string;
  revision: string;
  input: TInput;
  settings: Record<string, unknown>;
  idempotencyKey: string;
}

export interface ProviderCapabilities {
  structuredOutput: boolean;
  imageInput: boolean;
  multiImageInput?: boolean;
  pbr3d?: boolean;
  segmentation?: boolean;
}

export interface ProviderAdapter<TInput = unknown, TOutput = unknown> {
  readonly provider: string;
  readonly modelId: string;
  readonly revision: string;
  checkCapabilities(): Promise<ProviderCapabilities>;
  estimate(input: TInput, settings: Record<string, unknown>): Promise<number>;
  invoke(request: ProviderInvocation<TInput, TOutput>, signal?: AbortSignal): Promise<TOutput>;
}

export function artifactCacheKey(request: Omit<ProviderInvocation<unknown, unknown>, 'idempotencyKey'>): string {
  return createHash('sha256').update(JSON.stringify({
    provider: request.provider,
    modelId: request.modelId,
    revision: request.revision,
    input: request.input,
    settings: request.settings,
  })).digest('hex');
}

export class ProviderRequestGuard {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  invokeOnce<T>(idempotencyKey: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(idempotencyKey);
    if (existing) return existing as Promise<T>;
    const result = operation().finally(() => this.inFlight.delete(idempotencyKey));
    this.inFlight.set(idempotencyKey, result);
    return result;
  }
}

export interface ProviderModelSelection {
  provider: string;
  modelId: string;
  revision: string;
}

export class ProviderExecutionRegistry {
  private readonly adapters = new Map<string, ProviderAdapter<never, unknown>>();
  private readonly capabilities = new Map<string, Promise<ProviderCapabilities>>();

  constructor(adapters: readonly ProviderAdapter<unknown, unknown>[] = []) {
    adapters.forEach((adapter) => this.register(adapter));
  }

  register<TInput, TOutput>(adapter: ProviderAdapter<TInput, TOutput>): void {
    const key = this.key(adapter);
    if (this.adapters.has(key)) throw new Error(`Provider adapter ${key} is already registered`);
    this.adapters.set(key, adapter as unknown as ProviderAdapter<never, unknown>);
  }

  has(selection: ProviderModelSelection): boolean {
    return this.adapters.has(this.key(selection));
  }

  async requireCapabilities(selection: ProviderModelSelection, required: { structuredOutput?: boolean; imageInput?: boolean; multiImageInput?: boolean; pbr3d?: boolean; segmentation?: boolean }): Promise<void> {
    const adapter = this.requireAdapter(selection);
    const key = this.key(selection);
    let pending = this.capabilities.get(key);
    if (!pending) {
      pending = adapter.checkCapabilities();
      this.capabilities.set(key, pending);
    }
    const available = await pending;
    if (required.structuredOutput && !available.structuredOutput) throw new Error(`${key} does not support required structured output`);
    if (required.imageInput && !available.imageInput) throw new Error(`${key} does not support required image input`);
    if (required.multiImageInput && !available.multiImageInput) throw new Error(`${key} does not support required multi-image input`);
    if (required.pbr3d && !available.pbr3d) throw new Error(`${key} does not support required PBR 3D output`);
    if (required.segmentation && !available.segmentation) throw new Error(`${key} does not support required segmentation`);
  }

  invoke<TInput, TOutput>(selection: ProviderModelSelection, input: TInput, settings: Record<string, unknown>, idempotencyKey: string, signal?: AbortSignal): Promise<TOutput> {
    const adapter = this.requireAdapter(selection) as unknown as ProviderAdapter<TInput, TOutput>;
    return adapter.invoke({ provider: selection.provider, modelId: selection.modelId, revision: selection.revision, input, settings, idempotencyKey }, signal);
  }

  private requireAdapter(selection: ProviderModelSelection): ProviderAdapter<never, unknown> {
    const adapter = this.adapters.get(this.key(selection));
    if (!adapter) throw new Error(`No execution adapter is configured for ${selection.provider}/${selection.modelId}@${selection.revision}`);
    return adapter;
  }

  private key(selection: ProviderModelSelection): string {
    return `${selection.provider.toLowerCase()}::${selection.modelId.toLowerCase()}::${selection.revision}`;
  }
}
