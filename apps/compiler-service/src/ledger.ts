import { DatabaseSync } from 'node:sqlite';
import { CompileRequestSchema, GenerationArtifactSchema, GenerationAttemptSchema, RefinementDecisionSchema, type CompileEvent, type CompileRequest, type GenerationArtifact, type GenerationAttempt, type RefinementAction, type RefinementDecision, type VisualWorldBundle } from '@worldengine/schema';
import type { DagCheckpointStore, DagNodeResult } from '@worldengine/compiler';

export interface JobSummary { id: string; status: string; request: CompileRequest; createdAt: string; updatedAt: string }

export class JobLedger implements DagCheckpointStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        compile_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (compile_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS worlds (
        world_id TEXT PRIMARY KEY,
        latest_version INTEGER NOT NULL,
        latest_revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS patches (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        patch_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dag_nodes (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS webhook_receipts (
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (provider, event_id)
      );
      CREATE TABLE IF NOT EXISTS compile_artifacts (
        compile_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        PRIMARY KEY (compile_id, artifact_id)
      );
      CREATE TABLE IF NOT EXISTS generation_attempts (
        compile_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        attempt_json TEXT NOT NULL,
        PRIMARY KEY (compile_id, attempt_id)
      );
      CREATE TABLE IF NOT EXISTS refinement_decisions (
        compile_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        PRIMARY KEY (compile_id, decision_id)
      );
    `);
  }

  createJob(id: string, request: CompileRequest): void {
    const timestamp = new Date().toISOString();
    this.database.prepare('INSERT INTO jobs (id, status, request_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'queued', JSON.stringify(request), timestamp, timestamp);
  }

  appendEvent(event: CompileEvent): void {
    this.database.prepare('INSERT OR REPLACE INTO events (compile_id, sequence, event_json) VALUES (?, ?, ?)')
      .run(event.compileId, event.sequence, JSON.stringify(event));
    this.database.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
      .run(event.type, event.timestamp, event.compileId);
    if (event.type === 'cost') {
      const providerAttempts = event.data['providerAttempts'];
      if (Array.isArray(providerAttempts)) for (const raw of providerAttempts) {
        const attempt = GenerationAttemptSchema.parse(raw);
        if (attempt.compileId !== event.compileId) throw new Error(`Provider attempt ${attempt.id} belongs to a different compile`);
        this.recordAttempt(attempt);
      }
    }
    if (event.type === 'progress' || event.type === 'failed' || event.type === 'needs-attention' || event.type === 'cancelled' || event.type === 'completed') {
      const phase = event.phase === 'visual-review' ? 'review' : event.phase === 'composition' ? 'composition' : event.phase === 'placement' ? 'placement' : event.phase === 'terrain' ? 'terrain' : event.phase === 'optimization' ? 'asset-validation' : event.phase === 'complete' ? 'publication' : 'review';
      const silhouetteFailure = event.phase === 'region-refinement' && /silhouette/i.test(event.message);
      const plannedAction: RefinementAction | undefined = event.type === 'needs-attention' ? {
        id: `repair-${event.sequence}-${event.phase ?? 'review'}`,
        type: event.phase === 'region-map' || event.phase === 'requirements' ? 'regenerate-composition' : silhouetteFailure ? 'reconstruct-mesh' : event.phase === 'region-refinement' ? 'fit-support' : event.phase === 'optimization' ? 'reconstruct-mesh' : 'rerender',
        targetId: event.phase ?? 'compile', parameters: {}, reservedCostUsd: 0, reason: event.message,
      } : undefined;
      const attempt = GenerationAttemptSchema.parse({
        id: `attempt-${event.sequence}-${phase}`, compileId: event.compileId, phase, index: event.sequence,
        status: event.type === 'progress' || event.type === 'completed' ? 'passed' : event.type === 'needs-attention' ? 'rejected' : event.type,
        reservedCostUsd: 0, actualCostUsd: 0, artifactIds: [], ...(event.type === 'failed' || event.type === 'needs-attention' ? { rejectionReason: event.message } : {}),
        ...(plannedAction ? { plannedAction } : {}),
        startedAt: event.timestamp, completedAt: event.timestamp,
      });
      this.recordAttempt(attempt);
      if (plannedAction) this.recordDecision(RefinementDecisionSchema.parse({
        id: `decision-${event.sequence}-${event.phase ?? 'review'}`, compileId: event.compileId, attemptId: attempt.id, approved: false,
        diagnosis: [{ code: silhouetteFailure ? 'silhouette-mismatch' : event.phase === 'region-refinement' ? 'floating' : event.phase === 'optimization' ? 'mesh-invalid' : event.phase === 'region-map' || event.phase === 'requirements' ? 'composition-drift' : 'environment-mismatch', severity: 'error', targetId: event.phase ?? 'compile', message: event.message }],
        actions: [plannedAction], createdAt: event.timestamp,
      }));
    }
  }

  events(id: string): CompileEvent[] {
    const rows = this.database.prepare('SELECT event_json FROM events WHERE compile_id = ? ORDER BY sequence').all(id) as Array<{ event_json: string }>;
    return rows.map((row) => JSON.parse(row.event_json) as CompileEvent);
  }

  hasJob(id: string): boolean {
    return this.database.prepare('SELECT 1 AS found FROM jobs WHERE id = ?').get(id) !== undefined;
  }

  job(id: string): JobSummary | undefined {
    const row = this.database.prepare('SELECT id, status, request_json, created_at, updated_at FROM jobs WHERE id = ?').get(id) as { id: string; status: string; request_json: string; created_at: string; updated_at: string } | undefined;
    return row ? { id: row.id, status: row.status, request: CompileRequestSchema.parse(JSON.parse(row.request_json)), createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  listJobs(limit = 50): JobSummary[] {
    const rows = this.database.prepare('SELECT id, status, request_json, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))) as Array<{ id: string; status: string; request_json: string; created_at: string; updated_at: string }>;
    return rows.map((row) => ({ id: row.id, status: row.status, request: CompileRequestSchema.parse(JSON.parse(row.request_json)), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  recoverableJobs(): JobSummary[] {
    return this.listJobs(200).filter((job) => !['completed', 'failed', 'needs-attention', 'cancelled'].includes(job.status));
  }

  resumeJob(id: string, request: CompileRequest): void {
    const timestamp = new Date().toISOString();
    const result = this.database.prepare('UPDATE jobs SET status = ?, request_json = ?, updated_at = ? WHERE id = ?').run('queued', JSON.stringify(request), timestamp, id);
    if (result.changes !== 1) throw new Error(`Compile ${id} does not exist`);
  }

  resetDag(runId: string): void {
    this.database.prepare('DELETE FROM dag_nodes WHERE run_id = ?').run(runId);
  }

  recordArtifact(artifactInput: GenerationArtifact): void {
    const artifact = GenerationArtifactSchema.parse(artifactInput);
    this.database.prepare('INSERT OR REPLACE INTO compile_artifacts (compile_id, artifact_id, artifact_json) VALUES (?, ?, ?)').run(artifact.compileId, artifact.id, JSON.stringify(artifact));
  }

  artifacts(compileId: string): GenerationArtifact[] {
    const rows = this.database.prepare('SELECT artifact_json FROM compile_artifacts WHERE compile_id = ? ORDER BY artifact_id').all(compileId) as Array<{ artifact_json: string }>;
    return rows.map((row) => GenerationArtifactSchema.parse(JSON.parse(row.artifact_json)));
  }

  artifact(compileId: string, artifactId: string): GenerationArtifact | undefined {
    const row = this.database.prepare('SELECT artifact_json FROM compile_artifacts WHERE compile_id = ? AND artifact_id = ?').get(compileId, artifactId) as { artifact_json: string } | undefined;
    return row ? GenerationArtifactSchema.parse(JSON.parse(row.artifact_json)) : undefined;
  }

  recordAttempt(attemptInput: GenerationAttempt): void {
    const attempt = GenerationAttemptSchema.parse(attemptInput);
    this.database.prepare('INSERT OR REPLACE INTO generation_attempts (compile_id, attempt_id, attempt_json) VALUES (?, ?, ?)').run(attempt.compileId, attempt.id, JSON.stringify(attempt));
  }

  attempts(compileId: string): GenerationAttempt[] {
    const rows = this.database.prepare('SELECT attempt_json FROM generation_attempts WHERE compile_id = ? ORDER BY attempt_id').all(compileId) as Array<{ attempt_json: string }>;
    return rows.map((row) => GenerationAttemptSchema.parse(JSON.parse(row.attempt_json)));
  }

  recordDecision(decisionInput: RefinementDecision): void {
    const decision = RefinementDecisionSchema.parse(decisionInput);
    this.database.prepare('INSERT OR REPLACE INTO refinement_decisions (compile_id, decision_id, decision_json) VALUES (?, ?, ?)').run(decision.compileId, decision.id, JSON.stringify(decision));
  }

  decisions(compileId: string): RefinementDecision[] {
    const rows = this.database.prepare('SELECT decision_json FROM refinement_decisions WHERE compile_id = ? ORDER BY decision_id').all(compileId) as Array<{ decision_json: string }>;
    return rows.map((row) => RefinementDecisionSchema.parse(JSON.parse(row.decision_json)));
  }

  nodeOutput<T = unknown>(runId: string, nodeId: string): T | undefined {
    const row = this.database.prepare('SELECT result_json FROM dag_nodes WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as { result_json: string } | undefined;
    if (!row) return undefined;
    const result = JSON.parse(row.result_json) as DagNodeResult;
    return result.status === 'completed' ? result.output as T : undefined;
  }

  latestSequence(id: string): number {
    const row = this.database.prepare('SELECT MAX(sequence) AS sequence FROM events WHERE compile_id = ?').get(id) as { sequence: number | null };
    return row.sequence ?? -1;
  }

  async load(runId: string): Promise<readonly DagNodeResult[]> {
    const rows = this.database.prepare('SELECT result_json FROM dag_nodes WHERE run_id = ? ORDER BY node_id').all(runId) as Array<{ result_json: string }>;
    return rows.map((row) => JSON.parse(row.result_json) as DagNodeResult);
  }

  async save(runId: string, result: DagNodeResult): Promise<void> {
    this.database.prepare(`
      INSERT INTO dag_nodes (run_id, node_id, result_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, node_id) DO UPDATE SET result_json = excluded.result_json, updated_at = excluded.updated_at
    `).run(runId, result.id, JSON.stringify(result), new Date().toISOString());
  }

  recordBundle(bundle: VisualWorldBundle): void {
    this.database.prepare(`
      INSERT INTO worlds (world_id, latest_version, latest_revision, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(world_id) DO UPDATE SET latest_version = excluded.latest_version, latest_revision = excluded.latest_revision, updated_at = excluded.updated_at
    `).run(bundle.worldId, bundle.bundleVersion, bundle.sourceRevision, new Date().toISOString());
  }

  recordPatch(id: string, worldId: string, patch: unknown): void {
    this.database.prepare('INSERT INTO patches (id, world_id, patch_json, created_at) VALUES (?, ?, ?, ?)')
      .run(id, worldId, JSON.stringify(patch), new Date().toISOString());
  }

  recordWebhook(provider: string, eventId: string, payload: unknown): boolean {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO webhook_receipts (provider, event_id, payload_json, received_at) VALUES (?, ?, ?, ?)
    `).run(provider, eventId, JSON.stringify(payload), new Date().toISOString());
    return result.changes === 1;
  }

  close(): void {
    this.database.close();
  }
}
