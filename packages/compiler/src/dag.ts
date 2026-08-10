export type DagNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface DagNodeContext<TShared> {
  shared: TShared;
  signal: AbortSignal;
  output<T = unknown>(nodeId: string): T;
}

export interface DagNode<TShared, TOutput = unknown> {
  id: string;
  dependencies?: readonly string[];
  run(context: DagNodeContext<TShared>): Promise<TOutput>;
}

export interface DagNodeResult {
  id: string;
  status: DagNodeStatus;
  startedAt?: string;
  completedAt?: string;
  output?: unknown;
  error?: string;
}

export interface DagCheckpointStore {
  load(runId: string): Promise<readonly DagNodeResult[]>;
  save(runId: string, result: DagNodeResult): Promise<void>;
}

export class MemoryDagCheckpointStore implements DagCheckpointStore {
  private readonly runs = new Map<string, Map<string, DagNodeResult>>();

  async load(runId: string): Promise<readonly DagNodeResult[]> {
    return [...(this.runs.get(runId)?.values() ?? [])];
  }

  async save(runId: string, result: DagNodeResult): Promise<void> {
    const run = this.runs.get(runId) ?? new Map<string, DagNodeResult>();
    run.set(result.id, structuredClone(result));
    this.runs.set(runId, run);
  }
}

export class DagValidationError extends Error {
  override name = 'DagValidationError';
}

export class CompileDagExecutor<TShared> {
  constructor(private readonly store: DagCheckpointStore = new MemoryDagCheckpointStore()) {}

  async execute(runId: string, nodes: readonly DagNode<TShared>[], shared: TShared, signal: AbortSignal = new AbortController().signal): Promise<readonly DagNodeResult[]> {
    this.validate(nodes);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const results = new Map<string, DagNodeResult>();
    const prior = await this.store.load(runId);
    for (const result of prior) if (result.status === 'completed') results.set(result.id, result);

    while (results.size < nodes.length) {
      if (signal.aborted) {
        for (const node of nodes) if (!results.has(node.id)) {
          const cancelled: DagNodeResult = { id: node.id, status: 'cancelled', completedAt: new Date().toISOString(), error: 'Compile cancelled' };
          results.set(node.id, cancelled);
          await this.store.save(runId, cancelled);
        }
        break;
      }
      const runnable = nodes.filter((node) => !results.has(node.id) && (node.dependencies ?? []).every((dependency) => results.get(dependency)?.status === 'completed'));
      if (runnable.length === 0) {
        const blocked = nodes.filter((node) => !results.has(node.id));
        for (const node of blocked) {
          const skipped: DagNodeResult = { id: node.id, status: 'skipped', completedAt: new Date().toISOString(), error: 'Dependency did not complete' };
          results.set(node.id, skipped);
          await this.store.save(runId, skipped);
        }
        break;
      }
      for (const node of runnable) {
        const running: DagNodeResult = { id: node.id, status: 'running', startedAt: new Date().toISOString() };
        await this.store.save(runId, running);
        try {
          const output = await node.run({
            shared,
            signal,
            output: <T>(nodeId: string) => {
              const result = results.get(nodeId);
              if (result?.status !== 'completed') throw new Error(`DAG output ${nodeId} is unavailable`);
              return result.output as T;
            },
          });
          const completed: DagNodeResult = { ...running, status: 'completed', completedAt: new Date().toISOString(), output };
          results.set(node.id, completed);
          await this.store.save(runId, completed);
        } catch (error) {
          const failed: DagNodeResult = { ...running, status: signal.aborted ? 'cancelled' : 'failed', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
          results.set(node.id, failed);
          await this.store.save(runId, failed);
        }
      }
    }
    return nodes.map((node) => results.get(node.id) ?? { id: node.id, status: 'pending' });
  }

  private validate(nodes: readonly DagNode<TShared>[]): void {
    const ids = new Set<string>();
    for (const node of nodes) {
      if (ids.has(node.id)) throw new DagValidationError(`Duplicate DAG node ${node.id}`);
      ids.add(node.id);
    }
    for (const node of nodes) for (const dependency of node.dependencies ?? []) if (!ids.has(dependency)) throw new DagValidationError(`Node ${node.id} has unknown dependency ${dependency}`);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visit = (id: string) => {
      if (visiting.has(id)) throw new DagValidationError(`DAG contains a cycle at ${id}`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    nodes.forEach((node) => visit(node.id));
  }
}
