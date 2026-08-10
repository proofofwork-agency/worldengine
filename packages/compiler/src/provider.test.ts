import { describe, expect, it } from 'vitest';
import {
  createProviderAccountingSession,
  ProviderCostCapError,
  ProviderExecutionRegistry,
  type ProviderAdapter,
  type ProviderInvocation,
} from './provider.js';

class FixtureAdapter implements ProviderAdapter<{ value: string }, string> {
  readonly provider = 'fixture';
  readonly modelId = 'accounted-model';
  readonly revision = 'r1';
  calls = 0;
  fail = false;

  async checkCapabilities() { return { structuredOutput: true, imageInput: false }; }
  async estimate() { return 0.25; }
  async invoke(request: ProviderInvocation<{ value: string }, string>) {
    this.calls += 1;
    if (this.fail) throw new Error('fixture provider rejected request');
    return request.input.value;
  }
}

describe('provider execution accounting', () => {
  it('reserves each unique idempotent action before execution and records revision, phase, and charged cost', async () => {
    const adapter = new FixtureAdapter();
    const registry = new ProviderExecutionRegistry([adapter]);
    const session = createProviderAccountingSession({ capUsd: 1, previousActualCostUsd: 0.25, unitCostUsd: () => 0.25 });
    const selection = { provider: adapter.provider, modelId: adapter.modelId, revision: adapter.revision };

    await registry.withAccounting(session, async () => {
      await registry.invoke(selection, { value: 'first' }, {}, 'stable-action', undefined, 'composition');
      await registry.invoke(selection, { value: 'same idempotent action' }, {}, 'stable-action', undefined, 'composition');
      await registry.invoke(selection, { value: 'second' }, {}, 'new-action', undefined, 'reconstruction');
    });

    expect(adapter.calls).toBe(3);
    expect(session).toMatchObject({ reservedCostUsd: 0.5, actualCostUsd: 0.5 });
    expect(session.attempts).toEqual([
      expect.objectContaining({ provider: 'fixture', modelId: 'accounted-model', revision: 'r1', phase: 'composition', status: 'passed', reservedCostUsd: 0.25, actualCostUsd: 0.25 }),
      expect.objectContaining({ provider: 'fixture', modelId: 'accounted-model', revision: 'r1', phase: 'reconstruction', status: 'passed', reservedCostUsd: 0.25, actualCostUsd: 0.25 }),
    ]);
    expect(session.attempts[0]?.idempotencyKeyHash).toMatch(/^[a-f\d]{64}$/);
  });

  it('fails before invoking a provider when the cumulative confirmed cap cannot reserve the next action', async () => {
    const adapter = new FixtureAdapter();
    const registry = new ProviderExecutionRegistry([adapter]);
    const session = createProviderAccountingSession({ capUsd: 0.49, previousActualCostUsd: 0.25, unitCostUsd: () => 0.25 });

    await expect(registry.withAccounting(session, () => registry.invoke(
      { provider: adapter.provider, modelId: adapter.modelId, revision: adapter.revision },
      { value: 'must not run' }, {}, 'over-budget', undefined, 'multiview',
    ))).rejects.toBeInstanceOf(ProviderCostCapError);

    expect(adapter.calls).toBe(0);
    expect(session).toMatchObject({ attempts: [], reservedCostUsd: 0, actualCostUsd: 0 });
  });

  it('preserves a failed provider attempt with a conservative charged cost', async () => {
    const adapter = new FixtureAdapter(); adapter.fail = true;
    const registry = new ProviderExecutionRegistry([adapter]);
    const session = createProviderAccountingSession({ capUsd: 0.25, unitCostUsd: () => 0.25 });

    await expect(registry.withAccounting(session, () => registry.invoke(
      { provider: adapter.provider, modelId: adapter.modelId, revision: adapter.revision },
      { value: 'fail' }, {}, 'failed-action', undefined, 'review',
    ))).rejects.toThrow('fixture provider rejected request');

    expect(session.attempts).toEqual([expect.objectContaining({ status: 'failed', actualCostUsd: 0.25, rejectionReason: 'fixture provider rejected request' })]);
  });
});
