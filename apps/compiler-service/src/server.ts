import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ChunkCompileRequestSchema,
  CompileRequestSchema,
  AuthoringWorldSchema,
  VisualWorldBundleSchema,
  WorldDesignSpecSchema,
  WorldPatchSchema,
  QualityCertificationSchema,
  chunkId,
  type CompileEvent,
  type AuthoringWorld,
  type ProvenanceRecord,
  type ProviderTermsProfile,
  type VisualWorldBundle,
  type WorldDesignSpec,
} from '@worldengine/schema';
import { applyCanonicalPatch, assertValidGlb, DeterministicWorldCompiler, FileArtifactCache, FileBinaryArtifactStore, FileWorldStorage, generateMeshLods, materializeDetailedChunkAsync, ProviderExecutionRegistry, ProviderPolicyRegistry, providerProfileOperationalIssues, referenceProviderProfiles, renderQualityReportHtml, transcodeGlbTexturesToKtx2, type BinaryArtifactStore, type StudioWorkerRegistry, type WorldStorage } from '@worldengine/compiler';
import { JobLedger } from './ledger.js';

export interface CompilerServiceOptions {
  dataDirectory: string;
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  waveSpeedWebhookSecret?: string;
  providerProfiles?: readonly ProviderTermsProfile[];
  providerRegistry?: ProviderExecutionRegistry;
  studioWorkers?: StudioWorkerRegistry;
  /** Test/deployment injection point; defaults to local filesystem storage. */
  worldStorage?: WorldStorage;
}

export interface RunningCompilerService {
  origin: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

async function readBody(request: IncomingMessage, maximumBytes = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBytes) throw new HttpError(413, `Request body exceeds ${Math.round(maximumBytes / 1_000_000)} MB`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodedHeader(request: IncomingMessage, name: string): string | undefined {
  const value = header(request, name);
  if (!value) return undefined;
  try { return decodeURIComponent(value); } catch { throw new HttpError(400, `Header ${name} is not valid URI-encoded text`); }
}

function inspectGlb(bytes: Uint8Array): { animationClips: string[] } {
  assertValidGlb(bytes);
  if (bytes.byteLength < 20) throw new HttpError(400, 'Uploaded asset is not a complete GLB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new HttpError(400, 'Uploaded asset must be a glTF 2.0 GLB');
  if (view.getUint32(8, true) !== bytes.byteLength) throw new HttpError(400, 'GLB declared length does not match the upload');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength <= 0 || 20 + jsonLength > bytes.byteLength) throw new HttpError(400, 'GLB is missing its JSON chunk');
  let document: { meshes?: unknown[]; animations?: Array<{ name?: unknown }> };
  try { document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).replace(/\0+$/g, '').trim()) as typeof document; }
  catch { throw new HttpError(400, 'GLB JSON chunk is malformed'); }
  if (!Array.isArray(document.meshes) || document.meshes.length === 0) throw new HttpError(400, 'GLB must contain at least one mesh');
  return { animationClips: Array.isArray(document.animations) ? document.animations.map((animation, index) => typeof animation.name === 'string' && animation.name.length > 0 ? animation.name : `clip-${index}`) : [] };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  return body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

const benchmarkScenarioIds = new Set(['snow-future-valley', 'tropical-pirate-island', 'river-canyon-settlement', 'desert-battlefield', 'medieval-fantasy-valley']);

function imageUploadType(bytes: Uint8Array, declared: string | undefined): { contentType: 'image/png' | 'image/jpeg' | 'image/webp'; extension: 'png' | 'jpg' | 'webp' } {
  const type = declared?.split(';', 1)[0]?.trim().toLowerCase();
  if (type === 'image/png' && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { contentType: 'image/png', extension: 'png' };
  if (type === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (type === 'image/webp' && bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return { contentType: 'image/webp', extension: 'webp' };
  throw new HttpError(400, 'Quality evidence must be a correctly declared PNG, JPEG, or WebP image');
}

function isLocalEditorOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
    const privateIpv4 = ipv4 && ipv4.every((part) => part >= 0 && part <= 255) && (
      ipv4[0] === 10 || ipv4[0] === 127 || (ipv4[0] === 169 && ipv4[1] === 254)
      || (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31) || (ipv4[0] === 192 && ipv4[1] === 168)
    );
    const privateIpv6 = hostname === '::1' || /^f[cd][0-9a-f]{2}:/i.test(hostname) || /^fe[89ab][0-9a-f]:/i.test(hostname);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || Boolean(privateIpv4) || privateIpv6);
  } catch { return false; }
}

function verifyWaveSpeedWebhook(request: IncomingMessage, body: Buffer, secret: string, now = Date.now()): string | undefined {
  const eventId = header(request, 'webhook-id');
  const timestamp = header(request, 'webhook-timestamp');
  const signatureHeader = header(request, 'webhook-signature');
  if (!eventId || !timestamp || !signatureHeader) return undefined;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(now / 1_000 - timestampSeconds) > 300) return undefined;
  const signingSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const expected = createHmac('sha256', signingSecret).update(`${eventId}.${timestamp}.`).update(body).digest();
  const signatures = signatureHeader.split(/\s+/).map((value) => value.split(',', 2)).filter(([version, value]) => version === 'v3' && value);
  return signatures.some(([, value]) => {
    if (!value || !/^[a-f\d]{64}$/i.test(value)) return false;
    const received = Buffer.from(value, 'hex');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }) ? eventId : undefined;
}

function routeMatch(pathname: string, pattern: RegExp): RegExpMatchArray | undefined {
  return pathname.match(pattern) ?? undefined;
}

export async function persistStagedArtifacts(worldId: string, staged: unknown, binaryArtifacts: BinaryArtifactStore, storage: WorldStorage): Promise<void> {
  const entries = Array.isArray(staged) ? staged : [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') throw new Error('Compiler emitted invalid binary artifact metadata');
    const candidate = raw as { contentHash?: unknown; contentType?: unknown; byteLength?: unknown; uri?: unknown };
    if (typeof candidate.contentHash !== 'string' || !/^[a-f\d]{64}$/i.test(candidate.contentHash) || typeof candidate.contentType !== 'string' || typeof candidate.byteLength !== 'number' || typeof candidate.uri !== 'string') throw new Error('Compiler emitted invalid binary artifact metadata');
    const bytes = await binaryArtifacts.get(candidate.contentHash);
    if (bytes.byteLength !== candidate.byteLength || createHash('sha256').update(bytes).digest('hex') !== candidate.contentHash.toLowerCase()) throw new Error(`Staged artifact ${candidate.contentHash} failed integrity validation`);
    if (candidate.uri === `assets/${candidate.contentHash}.glb` && candidate.contentType === 'model/gltf-binary') await storage.putAsset(worldId, candidate.contentHash, bytes, candidate.contentType);
    else {
      const reference = candidate.uri.match(new RegExp(`^references/${candidate.contentHash}\\.(png|jpg|webp)$`));
      if (!reference || !['image/png', 'image/jpeg', 'image/webp'].includes(candidate.contentType)) throw new Error(`Compiler emitted unsupported artifact URI ${candidate.uri}`);
      await storage.putReference(worldId, candidate.contentHash, reference[1] as 'png' | 'jpg' | 'webp', bytes, candidate.contentType);
    }
  }
}

/**
 * Persists a complete immutable canonical snapshot and publishes its bundle
 * manifest last. WorldStorage.putBundle advances the latest-version pointer,
 * so it is the commit point and must never precede its referenced documents.
 */
export async function persistCanonicalSnapshot(
  storage: WorldStorage,
  bundle: VisualWorldBundle,
  designSpec: WorldDesignSpec,
  authoringWorld: AuthoringWorld,
): Promise<void> {
  const canonicalBundle = VisualWorldBundleSchema.parse(bundle);
  const canonicalDesign = WorldDesignSpecSchema.parse(designSpec);
  const canonicalAuthoring = AuthoringWorldSchema.parse(authoringWorld);
  await storage.putDesignSpec(canonicalBundle.worldId, canonicalBundle.bundleVersion, canonicalDesign);
  await storage.putAuthoringWorld(canonicalBundle.worldId, canonicalBundle.bundleVersion, canonicalAuthoring);
  await storage.putBundle(canonicalBundle);
}

export async function startCompilerService(options: CompilerServiceOptions): Promise<RunningCompilerService> {
  await mkdir(options.dataDirectory, { recursive: true });
  const storage = options.worldStorage ?? new FileWorldStorage(join(options.dataDirectory, 'storage'));
  const ledger = new JobLedger(join(options.dataDirectory, 'jobs.sqlite'));
  const providerProfiles = options.providerProfiles ?? referenceProviderProfiles;
  const policies = new ProviderPolicyRegistry(providerProfiles);
  const artifactCache = new FileArtifactCache(join(options.dataDirectory, 'cache'));
  const binaryArtifacts = new FileBinaryArtifactStore(join(options.dataDirectory, 'binary-artifacts'));
  const compiler = new DeterministicWorldCompiler({ policies, artifactCache, checkpoints: ledger, binaryArtifacts, ...(options.providerRegistry ? { providers: options.providerRegistry } : {}), ...(options.studioWorkers ? { studioWorkers: options.studioWorkers } : {}) });
  const eventBus = new EventEmitter();
  const controllers = new Map<string, AbortController>();
  const runningCompiles = new Map<string, Promise<void>>();
  const worldMutationTails = new Map<string, Promise<void>>();
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((origin) => new URL(origin).origin));
  let shuttingDown = false;

  const acquireWorldMutation = async (worldId: string): Promise<() => void> => {
    const previous = worldMutationTails.get(worldId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    worldMutationTails.set(worldId, tail);
    await previous.catch(() => undefined);
    return () => {
      releaseCurrent();
      if (worldMutationTails.get(worldId) === tail) worldMutationTails.delete(worldId);
    };
  };

  const runCompile = async (compileId: string, request: ReturnType<typeof CompileRequestSchema.parse>) => {
    if (controllers.has(compileId)) return;
    const controller = new AbortController();
    controllers.set(compileId, controller);
    const sequenceOffset = ledger.latestSequence(compileId) + 1;
    try {
      for await (let event of compiler.compileWithSignal(request, compileId, controller.signal)) {
        event = { ...event, sequence: event.sequence + sequenceOffset };
        if (shuttingDown && event.type === 'cancelled') break;
        if (event.type === 'artifact' && event.data['bundle'] && !request.dryRun) {
          const original = VisualWorldBundleSchema.parse(event.data['bundle']);
          const bundle = VisualWorldBundleSchema.parse({ ...original, id: `${compileId}-v1`, worldId: `world-${compileId}` });
          const designSpec = WorldDesignSpecSchema.parse(event.data['designSpec']);
          const authoringWorld = AuthoringWorldSchema.parse({ ...AuthoringWorldSchema.parse(event.data['authoringWorld']), id: `world-${compileId}-authoring` });
          await persistStagedArtifacts(bundle.worldId, event.data['binaryArtifacts'], binaryArtifacts, storage);
          await persistCanonicalSnapshot(storage, bundle, designSpec, authoringWorld);
          ledger.recordBundle(bundle);
          event = { ...event, data: { ...event.data, bundle, designSpec, authoringWorld } };
        }
        ledger.appendEvent(event);
        eventBus.emit(compileId, event);
      }
    } catch (value) {
      // Operator cancellation records its own terminal event. Graceful shutdown
      // intentionally leaves the job recoverable for the next service start.
      if (!controller.signal.aborted && !shuttingDown) {
        const existing = ledger.events(compileId);
        if (!existing.some((event) => ['completed', 'failed', 'cancelled'].includes(event.type))) {
          const error = value instanceof Error ? value : new Error(String(value));
          const event: CompileEvent = {
            sequence: ledger.latestSequence(compileId) + 1,
            compileId,
            type: 'failed',
            phase: 'publication',
            progress: 1,
            message: 'Compile failed while publishing canonical artifacts',
            timestamp: new Date().toISOString(),
            data: { errorName: error.name, code: 'CANONICAL_PUBLICATION_FAILED' },
          };
          ledger.appendEvent(event);
          eventBus.emit(compileId, event);
        }
      }
    } finally {
      controllers.delete(compileId);
    }
  };

  const launchCompile = (compileId: string, request: ReturnType<typeof CompileRequestSchema.parse>): void => {
    if (runningCompiles.has(compileId)) return;
    const running = runCompile(compileId, request).finally(() => runningCompiles.delete(compileId));
    runningCompiles.set(compileId, running);
  };

  const server = createServer(async (request, response) => {
    const requestOrigin = header(request, 'origin');
    const trustedBrowserOrigin = !requestOrigin || allowedOrigins.has(requestOrigin) || isLocalEditorOrigin(requestOrigin);
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type,x-worldengine-base-revision,x-worldengine-rights-affirmed,x-worldengine-license-name,x-worldengine-license-url,x-worldengine-attribution,x-worldengine-file-name,x-worldengine-certification-affirmed,x-worldengine-evidence-affirmed');
    response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (requestOrigin && trustedBrowserOrigin) {
      response.setHeader('access-control-allow-origin', requestOrigin);
      response.setHeader('vary', 'origin');
    }
    if (request.method === 'OPTIONS') {
      if (!trustedBrowserOrigin) { json(response, 403, { error: 'origin_not_allowed', message: 'Configure WORLDENGINE_ALLOWED_ORIGINS for this editor origin' }); return; }
      response.writeHead(204); response.end(); return;
    }
    let releaseWorldMutation: (() => void) | undefined;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname !== '/v1/webhooks/wavespeed' && !trustedBrowserOrigin) throw new HttpError(403, 'Browser origin is not allowed to mutate this compiler');
      if (request.method === 'POST') {
        const mutation = url.pathname.match(/^\/v1\/worlds\/([^/]+)\/(?:assets\/[^/]+\/import|chunks\/-?\d+\/-?\d+\/compile|patches|certifications|quality-evidence\/[^/]+)$/);
        if (mutation) releaseWorldMutation = await acquireWorldMutation(decodeURIComponent(mutation[1]!));
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        const blender = options.studioWorkers?.blender ? await options.studioWorkers.blender.checkCapabilities() : { available: false, issue: 'not-configured' };
        const providerStatuses = providerProfiles.map((profile) => {
          const operationalIssues = providerProfileOperationalIssues(profile);
          return {
            provider: profile.provider, modelId: profile.modelId, revision: profile.revision,
            termsFingerprint: profile.termsFingerprint, enabled: profile.enabled, accepted: profile.acceptedAt !== null,
            operational: operationalIssues.length === 0, operationalIssues,
            configured: options.providerRegistry?.has({ provider: profile.provider, modelId: profile.modelId, revision: profile.revision }) ?? false,
            cost: profile.cost,
          };
        });
        const providerReady = (provider: string) => providerStatuses.some((status) => status.provider.toLowerCase() === provider && status.operational && status.configured);
        const cheapMissing = ['openrouter', 'openai', 'wavespeed'].filter((provider) => !providerReady(provider));
        const studioMissing = ['openrouter', 'openai', 'sam2-local'].filter((provider) => !providerReady(provider));
        if (!providerReady('tripo') && !providerReady('meshy')) studioMissing.push('tripo-or-meshy');
        if (!blender.available) studioMissing.push('blender');
        json(response, 200, {
          status: 'ok', service: 'worldengine-compiler', version: '0.1.0',
          generation: {
            browserKeysAccepted: false,
            qualityProfiles: {
              local: { available: true, maxCostUsd: 0, maxHeroRegions: 0 },
              cheap: { available: cheapMissing.length === 0, maxCostUsd: 15, maxHeroRegions: 1, ...(cheapMissing.length > 0 ? { issue: `missing: ${cheapMissing.join(', ')}` } : {}) },
              studio: { available: studioMissing.length === 0, maxCostUsd: 100, maxHeroRegions: 5, ...(studioMissing.length > 0 ? { issue: `missing: ${studioMissing.join(', ')}` } : {}) },
            },
            blenderWorker: blender.available ? blender.version ?? 'available' : blender.issue ?? 'not-configured',
            providers: providerStatuses,
          },
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/webhooks/wavespeed') {
        if (!options.waveSpeedWebhookSecret) { json(response, 503, { error: 'webhook_not_configured' }); return; }
        const body = await readBody(request);
        const eventId = verifyWaveSpeedWebhook(request, body, options.waveSpeedWebhookSecret);
        if (!eventId) { json(response, 401, { error: 'invalid_webhook_signature' }); return; }
        const payload = body.length === 0 ? {} : JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        const providerTaskId = payload['id'] ?? (payload['data'] as Record<string, unknown> | undefined)?.['id'];
        if (typeof providerTaskId !== 'string' || providerTaskId.length === 0) { json(response, 400, { error: 'invalid_webhook_payload' }); return; }
        const accepted = ledger.recordWebhook('wavespeed', eventId, payload);
        json(response, 202, { accepted: true, duplicate: !accepted, eventId, providerTaskId });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/compiles') {
        const compileRequest = CompileRequestSchema.parse(await readJson(request));
        const compileId = randomUUID();
        ledger.createJob(compileId, compileRequest);
        launchCompile(compileId, compileRequest);
        json(response, 202, { compileId, events: `/v1/compiles/${compileId}/events` });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/compiles') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        json(response, 200, { jobs: ledger.listJobs(Number.isFinite(limit) ? limit : 50) });
        return;
      }
      const jobRoute = routeMatch(url.pathname, /^\/v1\/compiles\/([^/]+)$/);
      if (request.method === 'GET' && jobRoute) {
        const job = ledger.job(decodeURIComponent(jobRoute[1]!));
        if (!job) { json(response, 404, { error: 'compile_not_found' }); return; }
        json(response, 200, { ...job, events: ledger.events(job.id) });
        return;
      }
      const cancelRoute = routeMatch(url.pathname, /^\/v1\/compiles\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && cancelRoute) {
        const compileId = decodeURIComponent(cancelRoute[1]!);
        const job = ledger.job(compileId);
        if (!job) { json(response, 404, { error: 'compile_not_found' }); return; }
        if (['completed', 'failed', 'cancelled'].includes(job.status)) { json(response, 409, { error: 'compile_terminal', status: job.status }); return; }
        controllers.get(compileId)?.abort(new Error('Cancelled by operator'));
        const event: CompileEvent = { sequence: ledger.latestSequence(compileId) + 1, compileId, type: 'cancelled', phase: 'cancelled', progress: 1, message: 'Compile cancelled by operator', timestamp: new Date().toISOString(), data: {} };
        ledger.appendEvent(event);
        eventBus.emit(compileId, event);
        json(response, 202, { compileId, status: 'cancelled' });
        return;
      }
      const eventsRoute = routeMatch(url.pathname, /^\/v1\/compiles\/([^/]+)\/events$/);
      if (request.method === 'GET' && eventsRoute) {
        const compileId = decodeURIComponent(eventsRoute[1]!);
        if (!ledger.hasJob(compileId)) { json(response, 404, { error: 'compile_not_found' }); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
        const send = (event: CompileEvent) => response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        const lastEventId = Number(header(request, 'last-event-id') ?? -1);
        const history = ledger.events(compileId);
        const existing = history.filter((event) => !Number.isFinite(lastEventId) || event.sequence > lastEventId);
        existing.forEach(send);
        if (history.some((event) => ['completed', 'failed', 'cancelled'].includes(event.type))) { response.end(); return; }
        const listener = (event: CompileEvent) => {
          send(event);
          if (['completed', 'failed', 'cancelled'].includes(event.type)) { eventBus.off(compileId, listener); response.end(); }
        };
        eventBus.on(compileId, listener);
        request.on('close', () => eventBus.off(compileId, listener));
        return;
      }
      const bundleRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/bundle$/);
      if (request.method === 'GET' && bundleRoute) {
        const version = url.searchParams.has('version') ? Number(url.searchParams.get('version')) : undefined;
        const bundle = await storage.getBundle(decodeURIComponent(bundleRoute[1]!), version);
        json(response, 200, bundle);
        return;
      }
      const designRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/design$/);
      if (request.method === 'GET' && designRoute) {
        const worldId = decodeURIComponent(designRoute[1]!);
        const selected = url.searchParams.has('version') ? Number(url.searchParams.get('version')) : (await storage.getBundle(worldId)).bundleVersion;
        json(response, 200, await storage.getDesignSpec(worldId, selected));
        return;
      }
      const authoringRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/authoring$/);
      if (request.method === 'GET' && authoringRoute) {
        const worldId = decodeURIComponent(authoringRoute[1]!);
        const selected = url.searchParams.has('version') ? Number(url.searchParams.get('version')) : (await storage.getBundle(worldId)).bundleVersion;
        json(response, 200, await storage.getAuthoringWorld(worldId, selected));
        return;
      }
      const certificationRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/certifications$/);
      const qualityEvidenceRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/quality-evidence\/([^/]+)$/);
      if (request.method === 'POST' && qualityEvidenceRoute) {
        const worldId = decodeURIComponent(qualityEvidenceRoute[1]!);
        const scenarioId = decodeURIComponent(qualityEvidenceRoute[2]!);
        if (!benchmarkScenarioIds.has(scenarioId)) throw new HttpError(400, `Unknown benchmark scenario ${scenarioId}`);
        if (header(request, 'x-worldengine-evidence-affirmed') !== 'true') throw new HttpError(403, 'Benchmark evidence rights and authenticity affirmation is required');
        const bytes = new Uint8Array(await readBody(request, 25_000_000));
        const image = imageUploadType(bytes, header(request, 'content-type'));
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        const previous = await storage.getBundle(worldId);
        const designSpec = await storage.getDesignSpec(worldId, previous.bundleVersion);
        const authoringWorld = await storage.getAuthoringWorld(worldId, previous.bundleVersion);
        await storage.putReference(worldId, contentHash, image.extension, bytes, image.contentType);
        const referenceId = `quality-${scenarioId}-${contentHash.slice(0, 12)}`;
        const provenanceId = `provenance-${referenceId}`;
        const timestamp = new Date().toISOString();
        const reference = { id: referenceId, kind: 'quality-evidence' as const, uri: `references/${contentHash}.${image.extension}`, contentHash, contentType: image.contentType, benchmarkScenarioId: scenarioId, provenanceId };
        const provenance: ProvenanceRecord = { id: provenanceId, subjectId: referenceId, kind: 'imported', sourceUri: reference.uri, license: { name: 'Operator-affirmed WorldEngine benchmark capture', commercialUse: true }, createdAt: timestamp, contentHash, parentIds: [], reviewedAt: timestamp };
        const nextVersion = previous.bundleVersion + 1;
        const nextBundle = VisualWorldBundleSchema.parse({ ...previous, id: `${previous.worldId}-v${nextVersion}-quality-evidence`, bundleVersion: nextVersion, createdAt: timestamp, provenance: [...previous.provenance, provenance] });
        const nextAuthoring = AuthoringWorldSchema.parse({ ...authoringWorld, referenceImages: [...authoringWorld.referenceImages, reference], provenance: [...authoringWorld.provenance, provenance], updatedAt: timestamp });
        await persistCanonicalSnapshot(storage, nextBundle, designSpec, nextAuthoring);
        ledger.recordBundle(nextBundle);
        json(response, 201, { worldId, bundleVersion: nextVersion, scenarioId, referenceId, contentHash });
        return;
      }
      if (request.method === 'POST' && certificationRoute) {
        const worldId = decodeURIComponent(certificationRoute[1]!);
        if (header(request, 'x-worldengine-certification-affirmed') !== 'true') throw new HttpError(403, 'Manual benchmark evidence affirmation is required');
        const certification = QualityCertificationSchema.parse(await readJson(request));
        const previous = await storage.getBundle(worldId);
        const designSpec = await storage.getDesignSpec(worldId, previous.bundleVersion);
        const authoringWorld = await storage.getAuthoringWorld(worldId, previous.bundleVersion);
        if (certification.certified && (certification.qualityProfile !== 'studio' || previous.qualityProfile !== 'studio')) throw new HttpError(400, 'Only Studio worlds may receive 90% parity certification');
        const requiredCertificationRoles = new Set(['planner', 'reviewer', 'composition-image', 'object-detection', 'segmentation', 'multiview-image', 'image-to-3d']);
        if (certification.certified && [...requiredCertificationRoles].some((role) => !certification.providers.some((provider) => provider.role === role))) throw new HttpError(400, 'Certified reports require every Studio provider/worker role');
        if (certification.certified && certification.evidenceIds.length === 0) throw new HttpError(400, 'Certified reports require immutable evidence');
        if (certification.actualCostUsd > 100) throw new HttpError(400, 'Certification exceeds the USD 100 per-world cap');
        if (certification.certified && (certification.scenarios.length !== benchmarkScenarioIds.size || certification.scenarios.some((scenario) => !benchmarkScenarioIds.has(scenario.id)))) throw new HttpError(400, 'Certified reports require all five paper-derived scenarios');
        const requiredHardGates = new Set(['provider-policy', 'all-assets-reviewed', 'terrain-contact', 'free-viewpoint', 'runtime-performance', 'cost-cap', 'independent-raters']);
        if (certification.certified && [...requiredHardGates].some((id) => !certification.hardGates.some((gate) => gate.id === id && gate.passed))) throw new HttpError(400, 'Certified reports require every parity hard gate');
        const requiredStudioEvidence = new Set(['region-concept', 'object-mask', 'object-multiview', 'blender-rgb', 'blender-depth', 'blender-normal', 'blender-instance', 'placement-diagnostic']);
        if (certification.certified && [...requiredStudioEvidence].some((kind) => !authoringWorld.referenceImages.some((reference) => reference.kind === kind))) throw new HttpError(400, 'Certified reports require complete Studio image, mask, multiview, Blender-pass, and placement evidence');
        if (certification.certified && !authoringWorld.terrain.edits.some((edit) => edit.mode === 'flatten' || edit.mode === 'smooth')) throw new HttpError(400, 'Certified reports require local terrain support co-deformation');
        if (certification.certified && !authoringWorld.entities.some((entity) => entity.visualState['compositionDetected'] === true && entity.visualState['coDeformed'] === true)) throw new HttpError(400, 'Certified reports require detected composition placement with local co-deformation');
        if (certification.certified && authoringWorld.provenance.some((record) => (record.kind === 'generated' || record.kind === 'edited') && !record.reviewedAt)) throw new HttpError(400, 'Certified reports cannot contain unreviewed generated or edited provenance');
        for (const scenario of certification.scenarios) {
          if (!certification.certified) break;
          const evidence = new Set(authoringWorld.referenceImages.filter((reference) => reference.kind === 'quality-evidence' && reference.benchmarkScenarioId === scenario.id).map((reference) => reference.id));
          if (!scenario.evidenceIds.some((id) => evidence.has(id))) throw new HttpError(400, `Scenario ${scenario.id} requires its own affirmed quality-evidence capture`);
        }
        const knownEvidence = new Set([...authoringWorld.referenceImages.map((item) => item.id), ...authoringWorld.provenance.map((item) => item.id)]);
        const claimedEvidence = new Set([
          ...certification.evidenceIds,
          ...certification.dimensions.flatMap((item) => item.evidenceIds),
          ...certification.hardGates.flatMap((item) => item.evidenceIds),
          ...certification.scenarios.flatMap((item) => item.evidenceIds),
          ...certification.attempts.flatMap((item) => item.evidenceIds),
        ]);
        const unknownEvidence = [...claimedEvidence].filter((id) => !knownEvidence.has(id));
        if (unknownEvidence.length > 0) throw new HttpError(400, `Certification references unknown immutable evidence: ${unknownEvidence.slice(0, 5).join(', ')}`);
        for (const reference of authoringWorld.referenceImages.filter((item) => claimedEvidence.has(item.id))) {
          const match = reference.uri.match(new RegExp(`^references/${reference.contentHash}\\.(png|jpg|webp)$`));
          if (!match) throw new HttpError(400, `Evidence ${reference.id} has a non-immutable URI`);
          const bytes = await storage.getReference(worldId, reference.contentHash, match[1] as 'png' | 'jpg' | 'webp').catch(() => undefined);
          if (!bytes || createHash('sha256').update(bytes).digest('hex') !== reference.contentHash) throw new HttpError(400, `Evidence ${reference.id} is missing or failed SHA-256 validation`);
        }
        for (const provider of certification.providers) {
          const profile = providerProfiles.find((candidate) => candidate.provider === provider.provider && candidate.modelId === provider.modelId && candidate.revision === provider.revision);
          if (!profile || profile.termsFingerprint !== provider.termsFingerprint || !profile.enabled || profile.acceptedAt === null) throw new HttpError(400, `Certification provider policy is not currently accepted: ${provider.provider}/${provider.modelId}@${provider.revision}`);
        }
        const timestamp = new Date().toISOString();
        const nextBundle = VisualWorldBundleSchema.parse({ ...previous, id: `${previous.worldId}-v${previous.bundleVersion + 1}-quality`, bundleVersion: previous.bundleVersion + 1, createdAt: timestamp, qualityCertification: certification });
        const nextAuthoring = AuthoringWorldSchema.parse({ ...authoringWorld, qualityCertification: certification, updatedAt: timestamp });
        await persistCanonicalSnapshot(storage, nextBundle, designSpec, nextAuthoring);
        ledger.recordBundle(nextBundle);
        json(response, 201, { worldId, bundleVersion: nextBundle.bundleVersion, certified: certification.certified, weightedScore: certification.weightedScore });
        return;
      }
      const qualityReportRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/quality-report$/);
      if (request.method === 'GET' && qualityReportRoute) {
        const bundle = await storage.getBundle(decodeURIComponent(qualityReportRoute[1]!));
        if (!bundle.qualityCertification) { json(response, 404, { error: 'quality_report_not_found' }); return; }
        if (url.searchParams.get('format') === 'html') {
          const html = renderQualityReportHtml(bundle.qualityCertification);
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'x-content-type-options': 'nosniff' });
          response.end(html);
        } else json(response, 200, bundle.qualityCertification);
        return;
      }
      const assetRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/assets\/([a-f\d]{64})\.glb$/i);
      if (request.method === 'GET' && assetRoute) {
        const contentHash = assetRoute[2]!.toLowerCase();
        const bytes = await storage.getAsset(decodeURIComponent(assetRoute[1]!), contentHash);
        response.writeHead(200, {
          'content-type': 'model/gltf-binary',
          'content-length': bytes.byteLength,
          'cache-control': 'public, max-age=31536000, immutable',
          etag: `"${contentHash}"`,
          'x-content-type-options': 'nosniff',
          'access-control-allow-origin': '*',
        });
        response.end(bytes);
        return;
      }
      const assetImportRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/assets\/([^/]+)\/import$/);
      if (request.method === 'POST' && assetImportRoute) {
        const worldId = decodeURIComponent(assetImportRoute[1]!);
        const prototypeId = decodeURIComponent(assetImportRoute[2]!);
        if (header(request, 'x-worldengine-rights-affirmed') !== 'true') throw new HttpError(403, 'Asset rights affirmation is required');
        const licenseName = decodedHeader(request, 'x-worldengine-license-name');
        if (!licenseName) throw new HttpError(400, 'A license name is required');
        const baseRevision = Number(header(request, 'x-worldengine-base-revision'));
        if (!Number.isInteger(baseRevision) || baseRevision < 0) throw new HttpError(400, 'A valid base revision is required');
        const contentType = header(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (contentType !== 'model/gltf-binary' && contentType !== 'application/octet-stream') throw new HttpError(415, 'Asset import accepts only GLB content');
        const bytes = new Uint8Array(await readBody(request, 100_000_000));
        const inspected = inspectGlb(bytes);
        const sourceContentHash = createHash('sha256').update(bytes).digest('hex');
        const previous = await storage.getBundle(worldId);
        const designSpec = await storage.getDesignSpec(worldId, previous.bundleVersion);
        const authoringWorld = await storage.getAuthoringWorld(worldId, previous.bundleVersion);
        const currentPrototype = authoringWorld.prototypes.find((prototype) => prototype.id === prototypeId);
        if (!currentPrototype) throw new HttpError(404, `Unknown prototype ${prototypeId}`);
        const repeatedSource = authoringWorld.provenance.some((record) => record.subjectId === `${prototypeId}:upload-source` && record.contentHash.toLowerCase() === sourceContentHash);
        if (currentPrototype.assetHash === sourceContentHash || repeatedSource) {
          json(response, 200, { worldId, bundleVersion: previous.bundleVersion, revision: previous.sourceRevision, prototypeId, contentHash: currentPrototype.assetHash, sourceContentHash, assetUri: currentPrototype.assetUri, animationClips: currentPrototype.animationClips, textureFormat: currentPrototype.textureFormat, duplicate: true });
          return;
        }
        if (previous.sourceRevision !== baseRevision) { json(response, 409, { error: 'patch_conflict', expected: baseRevision, actual: previous.sourceRevision }); return; }
        const timestamp = new Date().toISOString();
        const optimizationWarnings: string[] = [];
        let optimizedAsset: Awaited<ReturnType<typeof transcodeGlbTexturesToKtx2>> = { bytes, textureFormat: 'source', textureCount: 0, convertedTextures: 0, sourceTextureBytes: 0, optimizedTextureBytes: 0 };
        try { optimizedAsset = await transcodeGlbTexturesToKtx2(bytes); }
        catch (error) { optimizationWarnings.push(`KTX2: ${(error as Error).message}`); }
        const contentHash = createHash('sha256').update(optimizedAsset.bytes).digest('hex');
        const provenanceId = `import-${prototypeId}-${contentHash.slice(0, 16)}`;
        const sourceProvenanceId = `${provenanceId}-upload-source`;
        const licenseUrl = decodedHeader(request, 'x-worldengine-license-url');
        const license = { name: licenseName, ...(licenseUrl ? { url: licenseUrl } : {}), commercialUse: true, ...(decodedHeader(request, 'x-worldengine-attribution') ? { attribution: decodedHeader(request, 'x-worldengine-attribution') } : {}) };
        const sourceProvenance: ProvenanceRecord[] = sourceContentHash !== contentHash ? [{
          id: sourceProvenanceId, subjectId: `${prototypeId}:upload-source`, kind: 'imported', sourceUri: `assets/${sourceContentHash}.glb`,
          license, createdAt: timestamp, contentHash: sourceContentHash, parentIds: [currentPrototype.provenanceId], reviewedAt: timestamp,
        }] : [];
        const provenance: ProvenanceRecord = sourceProvenance.length > 0 ? {
          id: provenanceId, subjectId: prototypeId, kind: 'edited', sourceUri: `assets/${contentHash}.glb`, provider: 'worldengine', modelId: 'ktx2-encoder', modelRevision: '0.6.0/basis-1b33fd5',
          license, createdAt: timestamp, contentHash, parentIds: [sourceProvenanceId], reviewedAt: timestamp,
        } : {
          id: provenanceId, subjectId: prototypeId, kind: 'imported', sourceUri: `assets/${contentHash}.glb`,
          license, createdAt: timestamp, contentHash, parentIds: [currentPrototype.provenanceId], reviewedAt: timestamp,
        };
        const boundsRadius = Math.max(Math.abs(currentPrototype.bounds.min[0]), Math.abs(currentPrototype.bounds.max[0]), Math.abs(currentPrototype.bounds.min[2]), Math.abs(currentPrototype.bounds.max[2]));
        const lods: typeof currentPrototype.lods = [];
        const lodProvenance: ProvenanceRecord[] = [];
        try {
          const optimized = await generateMeshLods(optimizedAsset.bytes);
          const baseDistance = Math.max(48, boundsRadius * 10);
          for (const [lodIndex, level] of optimized.entries()) {
            const lodHash = createHash('sha256').update(level.bytes).digest('hex');
            const lodUri = `assets/${lodHash}.glb`;
            const lodProvenanceId = `${provenanceId}-lod-${lodIndex + 1}`;
            await storage.putAsset(worldId, lodHash, level.bytes, 'model/gltf-binary');
            lods.push({ distance: baseDistance * (lodIndex === 0 ? 1 : 2.5), assetUri: lodUri, contentHash: lodHash, provenanceId: lodProvenanceId });
            lodProvenance.push({ ...provenance, id: lodProvenanceId, subjectId: `${prototypeId}:lod:${lodIndex + 1}`, kind: 'edited', sourceUri: lodUri, contentHash: lodHash, parentIds: [provenanceId], provider: 'worldengine', modelId: 'meshoptimizer', modelRevision: '1.2.0' });
          }
        } catch (error) {
          optimizationWarnings.push(`Mesh LOD: ${(error as Error).message}`);
        }
        const prototype = {
          ...currentPrototype,
          assetUri: `assets/${contentHash}.glb`,
          assetHash: contentHash,
          textureFormat: optimizedAsset.textureFormat,
          lods,
          animationClips: inspected.animationClips,
          provenanceId,
        };
        const patch = WorldPatchSchema.parse({
          id: `asset-${randomUUID()}`,
          worldId,
          baseRevision,
          createdAt: timestamp,
          author: 'worldengine-editor-asset-import',
          operations: [{ op: 'replace-prototype', prototype, provenance, sourceProvenance, lodProvenance }],
        });
        const patched = applyCanonicalPatch(designSpec, authoringWorld, previous, patch);
        if (sourceContentHash !== contentHash) await storage.putAsset(worldId, sourceContentHash, bytes, 'model/gltf-binary');
        await storage.putAsset(worldId, contentHash, optimizedAsset.bytes, 'model/gltf-binary');
        await persistCanonicalSnapshot(storage, patched.bundle, patched.designSpec, patched.authoringWorld);
        ledger.recordBundle(patched.bundle);
        ledger.recordPatch(patch.id, worldId, patch);
        json(response, 201, { worldId, bundleVersion: patched.bundle.bundleVersion, revision: patched.bundle.sourceRevision, prototypeId, contentHash, sourceContentHash, assetUri: prototype.assetUri, animationClips: prototype.animationClips, textureFormat: prototype.textureFormat, lodCount: lods.length, ...(optimizationWarnings.length > 0 ? { optimizationWarnings } : {}) });
        return;
      }
      const referenceRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/references\/([a-f\d]{64})\.(png|jpg|webp)$/i);
      if (request.method === 'GET' && referenceRoute) {
        const extension = referenceRoute[3]!.toLowerCase() as 'png' | 'jpg' | 'webp';
        const contentHash = referenceRoute[2]!.toLowerCase();
        const bytes = await storage.getReference(decodeURIComponent(referenceRoute[1]!), contentHash, extension);
        response.writeHead(200, {
          'content-type': extension === 'png' ? 'image/png' : extension === 'jpg' ? 'image/jpeg' : 'image/webp',
          'content-length': bytes.byteLength,
          'cache-control': 'public, max-age=31536000, immutable',
          etag: `"${contentHash}"`,
          'x-content-type-options': 'nosniff',
          'access-control-allow-origin': '*',
        });
        response.end(bytes);
        return;
      }
      const chunkPayloadRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/chunks\/(-?\d+)_(-?\d+)\.json$/);
      if (request.method === 'GET' && chunkPayloadRoute) {
        const version = Number(url.searchParams.get('version'));
        if (!Number.isInteger(version) || version < 1) { json(response, 400, { error: 'chunk_version_required' }); return; }
        const chunk = await storage.getChunk(decodeURIComponent(chunkPayloadRoute[1]!), version, Number(chunkPayloadRoute[2]), Number(chunkPayloadRoute[3]));
        json(response, 200, chunk);
        return;
      }
      const chunkRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/chunks\/(-?\d+)\/(-?\d+)\/compile$/);
      if (request.method === 'POST' && chunkRoute) {
        const worldId = decodeURIComponent(chunkRoute[1]!);
        const x = Number(chunkRoute[2]);
        const z = Number(chunkRoute[3]);
        const body = await readJson(request) as Record<string, unknown>;
        const expansionRequest = ChunkCompileRequestSchema.parse({ ...body, worldId, x, z, explicit: true });
        if (expansionRequest.maxAssetGenerations > 0) throw new HttpError(400, 'Sparse chunk materialization does not execute asset providers');
        const previous = await storage.getBundle(worldId);
        const nextVersion = previous.bundleVersion + 1;
        const chunk = await materializeDetailedChunkAsync(previous, x, z);
        const uri = `chunks/${x}_${z}.json?version=${nextVersion}`;
        const id = chunkId(x, z);
        const serializedChunk = JSON.stringify(chunk);
        const entry = {
          id, coordinate: { x, z }, bounds: chunk.bounds,
          source: { kind: 'uri' as const, uri, contentHash: createHash('sha256').update(serializedChunk).digest('hex'), byteLength: Buffer.byteLength(serializedChunk) }, dependencies: chunk.dependencies,
        };
        const bundle: VisualWorldBundle = VisualWorldBundleSchema.parse({
          ...previous, id: `${worldId}-v${nextVersion}`, bundleVersion: nextVersion, createdAt: new Date().toISOString(), sourceRevision: previous.sourceRevision + 1,
          chunks: [...previous.chunks.filter((item) => item.id !== id), entry],
        });
        const designSpec = await storage.getDesignSpec(worldId, previous.bundleVersion);
        const previousAuthoring = await storage.getAuthoringWorld(worldId, previous.bundleVersion);
        const authoringWorld = AuthoringWorldSchema.parse({
          ...previousAuthoring,
          revision: bundle.sourceRevision,
          updatedAt: bundle.createdAt,
          chunkOverrides: [...previousAuthoring.chunkOverrides.filter((override) => override.coordinate.x !== x || override.coordinate.z !== z), { coordinate: { x, z }, dataUri: uri }],
        });
        await storage.putChunk(worldId, nextVersion, chunk);
        await persistCanonicalSnapshot(storage, bundle, designSpec, authoringWorld);
        ledger.recordBundle(bundle);
        json(response, 201, { worldId, bundleVersion: nextVersion, chunkId: id, bundle: `/v1/worlds/${worldId}/bundle?version=${nextVersion}` });
        return;
      }
      const patchRoute = routeMatch(url.pathname, /^\/v1\/worlds\/([^/]+)\/patches$/);
      if (request.method === 'POST' && patchRoute) {
        const worldId = decodeURIComponent(patchRoute[1]!);
        const patch = WorldPatchSchema.parse(await readJson(request));
        if (patch.worldId !== worldId) { json(response, 409, { error: 'world_id_mismatch' }); return; }
        const previous = await storage.getBundle(worldId);
        if (patch.baseRevision !== previous.sourceRevision) { json(response, 409, { error: 'patch_conflict', expected: patch.baseRevision, actual: previous.sourceRevision }); return; }
        const designSpec = await storage.getDesignSpec(worldId, previous.bundleVersion);
        const authoringWorld = await storage.getAuthoringWorld(worldId, previous.bundleVersion);
        const patched = applyCanonicalPatch(designSpec, authoringWorld, previous, patch);
        let bundle = patched.bundle;
        if (patched.invalidatesDetailedChunks) {
          const invalidated = new Set(patched.invalidatedChunkIds);
          const chunks = [];
          for (const entry of bundle.chunks) {
            if (entry.source.kind !== 'uri' || !invalidated.has(entry.id)) { chunks.push(entry); continue; }
            const detailed = await materializeDetailedChunkAsync(bundle, entry.coordinate.x, entry.coordinate.z);
            const serialized = JSON.stringify(detailed);
            const uri = `chunks/${entry.coordinate.x}_${entry.coordinate.z}.json?version=${bundle.bundleVersion}`;
            await storage.putChunk(worldId, bundle.bundleVersion, detailed);
            chunks.push({ ...entry, source: { kind: 'uri' as const, uri, contentHash: createHash('sha256').update(serialized).digest('hex'), byteLength: Buffer.byteLength(serialized) }, dependencies: detailed.dependencies });
          }
          bundle = VisualWorldBundleSchema.parse({ ...bundle, chunks });
        }
        await persistCanonicalSnapshot(storage, bundle, patched.designSpec, patched.authoringWorld);
        ledger.recordBundle(bundle);
        ledger.recordPatch(patch.id, worldId, patch);
        json(response, 201, { worldId, bundleVersion: bundle.bundleVersion, revision: bundle.sourceRevision });
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value));
      const status = error instanceof HttpError ? error.status : error.name === 'ZodError' || error instanceof SyntaxError ? 400 : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
      json(response, status, { error: status === 404 ? 'not_found' : status >= 400 && status < 500 ? 'invalid_request' : 'internal_error', message: error.message });
    } finally {
      releaseWorldMutation?.();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Compiler service did not bind a TCP port');
  for (const job of ledger.recoverableJobs()) launchCompile(job.id, job.request);
  return {
    origin: `http://${options.host ?? '127.0.0.1'}:${address.port}`,
    close: async () => {
      shuttingDown = true;
      eventBus.removeAllListeners();
      for (const controller of controllers.values()) controller.abort(new Error('Service shutting down'));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.allSettled(runningCompiles.values());
      ledger.close();
    },
  };
}
