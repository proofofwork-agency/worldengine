import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

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

export type ProviderInvocationPhase = 'terrain' | 'composition' | 'segmentation' | 'multiview' | 'reconstruction' | 'asset-validation' | 'placement' | 'scene-refinement' | 'review' | 'publication';

export interface ProviderInvocationAccountingRecord extends ProviderModelSelection {
  id: string;
  phase: ProviderInvocationPhase;
  index: number;
  status: 'passed' | 'failed' | 'cancelled';
  idempotencyKeyHash: string;
  reservedCostUsd: number;
  actualCostUsd: number;
  startedAt: string;
  completedAt: string;
  rejectionReason?: string;
}

export interface ProviderAccountingSession {
  readonly capUsd: number;
  readonly previousActualCostUsd: number;
  readonly unitCostUsd: (selection: ProviderModelSelection) => number;
  readonly attempts: ProviderInvocationAccountingRecord[];
  reservedCostUsd: number;
  actualCostUsd: number;
}

interface ProviderAccountingContext {
  session: ProviderAccountingSession;
  seen: Set<string>;
  runId: string;
}

export class ProviderCostCapError extends Error {
  readonly code = 'COST_CAP_EXCEEDED';

  constructor(message: string) {
    super(message);
    this.name = 'ProviderCostCapError';
  }
}

export function createProviderAccountingSession(input: {
  capUsd: number;
  previousActualCostUsd?: number;
  unitCostUsd(selection: ProviderModelSelection): number;
}): ProviderAccountingSession {
  if (!Number.isFinite(input.capUsd) || input.capUsd < 0) throw new Error('Provider accounting cap must be a finite non-negative amount');
  const previousActualCostUsd = input.previousActualCostUsd ?? 0;
  if (!Number.isFinite(previousActualCostUsd) || previousActualCostUsd < 0) throw new Error('Previous provider cost must be a finite non-negative amount');
  return { capUsd: input.capUsd, previousActualCostUsd, unitCostUsd: input.unitCostUsd, attempts: [], reservedCostUsd: 0, actualCostUsd: 0 };
}

export class ProviderExecutionRegistry {
  private readonly adapters = new Map<string, ProviderAdapter<never, unknown>>();
  private readonly capabilities = new Map<string, Promise<ProviderCapabilities>>();
  private readonly accounting = new AsyncLocalStorage<ProviderAccountingContext>();

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

  withAccounting<T>(session: ProviderAccountingSession, operation: () => Promise<T>): Promise<T> {
    return this.accounting.run({ session, seen: new Set(), runId: randomUUID() }, operation);
  }

  async invoke<TInput, TOutput>(selection: ProviderModelSelection, input: TInput, settings: Record<string, unknown>, idempotencyKey: string, signal?: AbortSignal, phase: ProviderInvocationPhase = 'review'): Promise<TOutput> {
    const adapter = this.requireAdapter(selection) as unknown as ProviderAdapter<TInput, TOutput>;
    const context = this.accounting.getStore();
    const accountingKey = `${this.key(selection)}::${idempotencyKey}`;
    let attempt: ProviderInvocationAccountingRecord | undefined;
    if (context && !context.seen.has(accountingKey)) {
      const unitCostUsd = context.session.unitCostUsd(selection);
      if (!Number.isFinite(unitCostUsd) || unitCostUsd < 0) throw new Error(`Provider policy returned an invalid unit cost for ${selection.provider}/${selection.modelId}@${selection.revision}`);
      const cumulativeReservedUsd = context.session.previousActualCostUsd + context.session.reservedCostUsd + unitCostUsd;
      if (cumulativeReservedUsd > context.session.capUsd + Number.EPSILON) {
        throw new ProviderCostCapError(`Provider action would reserve $${cumulativeReservedUsd.toFixed(2)} against cap $${context.session.capUsd.toFixed(2)}`);
      }
      context.seen.add(accountingKey);
      context.session.reservedCostUsd += unitCostUsd;
      const startedAt = new Date().toISOString();
      const idempotencyKeyHash = createHash('sha256').update(idempotencyKey).digest('hex');
      attempt = {
        id: `provider-${createHash('sha256').update(`${context.runId}:${accountingKey}`).digest('hex').slice(0, 24)}`,
        phase,
        index: context.session.attempts.length,
        status: 'failed',
        provider: selection.provider,
        modelId: selection.modelId,
        revision: selection.revision,
        idempotencyKeyHash,
        reservedCostUsd: unitCostUsd,
        actualCostUsd: 0,
        startedAt,
        completedAt: startedAt,
      };
      context.session.attempts.push(attempt);
    }
    try {
      const output = await adapter.invoke({ provider: selection.provider, modelId: selection.modelId, revision: selection.revision, input, settings, idempotencyKey }, signal);
      if (attempt && context) {
        attempt.status = 'passed';
        attempt.actualCostUsd = attempt.reservedCostUsd;
        attempt.completedAt = new Date().toISOString();
        context.session.actualCostUsd += attempt.actualCostUsd;
      }
      return output;
    } catch (value) {
      if (attempt && context) {
        attempt.status = signal?.aborted ? 'cancelled' : 'failed';
        // Reviewed policy unit prices are used as the conservative charged cost
        // because provider adapters do not expose authoritative invoice data.
        attempt.actualCostUsd = attempt.reservedCostUsd;
        attempt.completedAt = new Date().toISOString();
        attempt.rejectionReason = value instanceof Error ? value.message : String(value);
        context.session.actualCostUsd += attempt.actualCostUsd;
      }
      throw value;
    }
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
