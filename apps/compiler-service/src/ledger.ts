import { DatabaseSync } from 'node:sqlite';
import { CompileRequestSchema, type CompileEvent, type CompileRequest, type VisualWorldBundle } from '@worldengine/schema';
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
    return this.listJobs(200).filter((job) => !['completed', 'failed', 'cancelled'].includes(job.status));
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
