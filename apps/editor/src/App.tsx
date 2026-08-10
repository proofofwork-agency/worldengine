import { useEffect, useMemo, useRef, useState } from 'react';
import { createReferenceBundle, createReferenceDesignSpec, REFERENCE_SCATTER_INSTANCES_PER_CHUNK } from '@worldengine/terrain';
import {
  AssetLibraryEntrySchema,
  AuthoringWorldSchema,
  CompileArtifactCatalogSchema,
  CompileReportSchema,
  PatchIdSchema,
  VisualWorldBundleSchema,
  WorldDesignSpecSchema,
  type AuthoringWorld,
  type CompileArtifactCatalog,
  type CompileReport,
  type RuntimeInstance,
  type QualityProfile,
  type TerrainEdit,
  type Transform,
  type VisualWorldBundle,
  type WorldDesignSpec,
  type WorldPatchOperation,
} from '@worldengine/schema';
import { resolveBundleAssetUris, type VisualWorldEngine, type VisualWorldEvent } from '@worldengine/runtime';
import { mountArtifactGlbViewer } from '@worldengine/three';
import { Icon, icons } from './icons.js';
import { RegionMap } from './RegionMap.js';
import { WorldViewport, type CameraMode, type ViewportStats } from './WorldViewport.js';
import { useHistoryState } from './useHistoryState.js';

const referenceBundle = createReferenceBundle();
const referenceDesign = createReferenceDesignSpec();
type LeftTab = 'world' | 'assets' | 'pipeline';
type RightTab = 'inspect' | 'diagnostics';
type Tool = 'select' | 'move' | 'rotate' | 'scale' | 'terrain' | 'region';
interface EditorState {
  prompt: string;
  time: number;
  weather: WorldDesignSpec['environment']['weather'];
  densities: Record<string, number>;
  terrainEdits: TerrainEdit[];
  assetReplacements: Record<string, { uri: string; previewUri: string; contentHash: string; fileName: string; byteLength: number; licenseName: string; licenseUrl?: string; attribution?: string; rightsAffirmed: true }>;
  entityTransforms: Record<string, Transform>;
  revision: number;
}
interface EditorSnapshot { id: string; name: string; createdAt: string; state: EditorState }
interface EditorJob { id: string; kind: 'compile' | 'regenerate' | 'expand'; status: string; createdAt: string; costUsd: number }
interface CompileWorkspace { id: string; status: CompileReport['status']; catalog?: CompileArtifactCatalog; report?: CompileReport }
interface PendingAssetImport { prototypeId: string; file: File; contentHash: string }
interface LoadedChunkSummary {
  id: string;
  coordinate: { x: number; z: number };
  terrainSamples: number;
  minHeight: number;
  maxHeight: number;
  instances: number;
  dependencies: number;
  occlusionCells: number;
  placeholder: boolean;
}
interface ProviderStatus {
  provider: string;
  modelId: string;
  revision: string;
  termsFingerprint: string;
  enabled: boolean;
  accepted: boolean;
  operational: boolean;
  operationalIssues: string[];
  configured: boolean;
  cost: { unit: string; usd: number };
}
interface CompilerHealth { generation?: { browserKeysAccepted: false; blenderWorker: string; qualityProfiles?: Record<QualityProfile, { available: boolean; maxCostUsd: number; maxHeroRegions: number; issue?: string }>; providers: ProviderStatus[] } }

const initialEditorState: EditorState = {
  prompt: referenceDesign.prompt,
  time: referenceDesign.environment.timeOfDay,
  weather: referenceDesign.environment.weather,
  densities: Object.fromEntries(referenceDesign.regions.map((region) => [region.id, region.density])),
  terrainEdits: [], assetReplacements: {}, entityTransforms: {}, revision: 0,
};

function matrixFromTransform(transform: Transform): RuntimeInstance['matrix'] {
  const [x, y, z, w] = transform.rotation;
  const [sx, sy, sz] = transform.scale;
  const x2 = x + x; const y2 = y + y; const z2 = z + z;
  const xx = x * x2; const xy = x * y2; const xz = x * z2;
  const yy = y * y2; const yz = y * z2; const zz = z * z2;
  const wx = w * x2; const wy = w * y2; const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    transform.position[0], transform.position[1], transform.position[2], 1,
  ];
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function compilerEndpoint(): string {
  const configured = import.meta.env['VITE_COMPILER_URL'] as string | undefined;
  const endpoint = new URL(configured ?? `${location.protocol}//${location.hostname}:8787`, location.href);
  const pageIsRemote = !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  if (configured && pageIsRemote && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) endpoint.hostname = location.hostname;
  return endpoint.href.replace(/\/$/, '');
}

function provenanceAncestors(records: VisualWorldBundle['provenance'], record: VisualWorldBundle['provenance'][number]): VisualWorldBundle['provenance'] {
  const byId = new Map(records.map((candidate) => [candidate.id, candidate]));
  const ancestors = new Map<string, VisualWorldBundle['provenance'][number]>();
  const queue = [...record.parentIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (ancestors.has(id)) continue;
    const candidate = byId.get(id);
    if (!candidate) continue;
    ancestors.set(id, candidate);
    queue.push(...candidate.parentIds);
  }
  return [...ancestors.values()];
}

function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [x, z] = polygon[index]!;
    const [previousX, previousZ] = polygon[previous]!;
    if ((z > point[1]) !== (previousZ > point[1]) && point[0] < ((previousX - x) * (point[1] - z)) / (previousZ - z) + x) inside = !inside;
  }
  return inside;
}

function ArtifactGlbPreview({ uri }: { uri: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!canvasRef.current) return;
    setError(undefined);
    const viewer = mountArtifactGlbViewer(canvasRef.current, uri, (cause) => setError(cause.message));
    return () => viewer.dispose();
  }, [uri]);
  return <div className="artifact-glb-viewer"><canvas ref={canvasRef} aria-label="Interactive GLB artifact viewer" />{error && <p>{error}</p>}<small>Drag to orbit · scroll to zoom</small></div>;
}

function CompileArtifactWorkspace({ workspace, endpoint, onResume }: { workspace: CompileWorkspace; endpoint: string; onResume: (newCap: number) => Promise<void> }) {
  const artifacts = workspace.catalog?.artifacts ?? [];
  const attempts = workspace.catalog?.attempts ?? [];
  const images = artifacts.filter((artifact) => artifact.contentType.startsWith('image/'));
  const glbs = artifacts.filter((artifact) => artifact.contentType === 'model/gltf-binary');
  const artifactUrl = (id: string) => `${endpoint}/v1/compiles/${encodeURIComponent(workspace.id)}/artifacts/${encodeURIComponent(id)}`;
  const [selectedGlbId, setSelectedGlbId] = useState<string>();
  const [comparison, setComparison] = useState(50);
  const [resumeCap, setResumeCap] = useState(Math.min(100, Math.max(1, (workspace.report?.cost.capUsd ?? 0) + 5)));
  const [resumeConfirmed, setResumeConfirmed] = useState(false);
  const selectedGlb = glbs.find((artifact) => artifact.id === selectedGlbId) ?? glbs.at(-1);
  const comparisonImages = [images.find((artifact) => artifact.kind === 'regional-composition') ?? images[0], images.find((artifact) => artifact.kind === 'threejs-render') ?? images.find((artifact) => artifact.kind === 'blender-rgb') ?? images[1]].filter((artifact, index, values) => artifact && values.indexOf(artifact) === index);
  const rejected = [...attempts].reverse().find((attempt) => attempt.status === 'rejected' || attempt.status === 'failed');
  const reason = workspace.report?.rejectionReason ?? rejected?.rejectionReason;
  const action = workspace.report?.plannedAction ?? rejected?.plannedAction;
  return <section className="compile-workspace" aria-label="Compile artifacts">
    <header><div><small>CLOUD COMPILE</small><strong>{workspace.id.slice(0, 12)}</strong></div><span className={`compile-status ${workspace.status}`}>{workspace.status.replace('-', ' ')}</span></header>
    <dl><div><dt>Reserved / actual</dt><dd>${(workspace.report?.cost.reservedUsd ?? 0).toFixed(2)} / ${(workspace.report?.cost.actualUsd ?? 0).toFixed(2)}</dd></div><div><dt>Artifacts / attempts</dt><dd>{artifacts.length} / {attempts.length}</dd></div></dl>
    {reason && <div className="compile-diagnosis"><strong>Why it stopped</strong><p>{reason}</p>{action && <small>Planned repair: {action.type} · {action.reason}</small>}</div>}
    {comparisonImages.length === 2 && <div className="artifact-comparison"><div><img src={artifactUrl(comparisonImages[0]!.id)} alt={comparisonImages[0]!.kind} /><img style={{ clipPath: `inset(0 ${100 - comparison}% 0 0)` }} src={artifactUrl(comparisonImages[1]!.id)} alt={comparisonImages[1]!.kind} /></div><input aria-label="Artifact comparison split" type="range" min="0" max="100" value={comparison} onChange={(event) => setComparison(Number(event.target.value))} /><small>{comparisonImages[0]!.kind} ↔ {comparisonImages[1]!.kind}</small></div>}
    {selectedGlb && <ArtifactGlbPreview uri={artifactUrl(selectedGlb.id)} />}
    <div className="artifact-grid">{artifacts.map((artifact) => <button key={artifact.id} className={selectedGlb?.id === artifact.id ? 'selected' : ''} onClick={() => artifact.contentType === 'model/gltf-binary' && setSelectedGlbId(artifact.id)} title={`${artifact.contentHash} · ${artifact.byteLength} bytes`}>{artifact.contentType.startsWith('image/') ? <img src={artifactUrl(artifact.id)} alt="" /> : <span>{artifact.contentType === 'model/gltf-binary' ? '3D' : 'DOC'}</span>}<strong>{artifact.kind}</strong><small>{artifact.phase}</small></button>)}</div>
    {attempts.length > 0 && <ol className="attempt-list">{attempts.map((attempt) => <li key={attempt.id}><span>{attempt.phase} #{attempt.index + 1}</span><em>{attempt.status}</em><small>${attempt.actualCostUsd.toFixed(2)}{attempt.rejectionReason ? ` · ${attempt.rejectionReason}` : ''}</small></li>)}</ol>}
    {workspace.status === 'needs-attention' && <div className="resume-compile"><label>New explicit cost cap<input type="number" min={(workspace.report?.cost.capUsd ?? 0) + 0.01} max="100" step="1" value={resumeCap} onChange={(event) => { setResumeCap(Number(event.target.value)); setResumeConfirmed(false); }} /></label><label><input type="checkbox" checked={resumeConfirmed} onChange={(event) => setResumeConfirmed(event.target.checked)} /> Confirm additional provider spend</label><button disabled={!resumeConfirmed || resumeCap <= (workspace.report?.cost.capUsd ?? 0)} onClick={() => void onResume(resumeCap)}>Resume run</button></div>}
  </section>;
}

export function App() {
  const [bundle, setBundle] = useState<VisualWorldBundle>(referenceBundle);
  const [design, setDesign] = useState<WorldDesignSpec>(referenceDesign);
  const [authoringWorld, setAuthoringWorld] = useState<AuthoringWorld>();
  const [remoteWorld, setRemoteWorld] = useState<{ id: string; revision: number }>();
  const [tool, setTool] = useState<Tool>('select');
  const [mode, setMode] = useState<CameraMode>('sandbox');
  const [leftTab, setLeftTab] = useState<LeftTab>('world');
  const [rightTab, setRightTab] = useState<RightTab>('inspect');
  const [selectedRegion, setSelectedRegion] = useState(referenceDesign.regions[1]!.id);
  const history = useHistoryState(initialEditorState);
  const editor = history.value;
  const [stats, setStats] = useState<ViewportStats>({ renderer: 'starting', loadedChunks: 0, visibleEntities: 0, p95FrameMs: 0, gpuMemoryMb: 0, maxChunkTaskMs: 0, withinBudget: true });
  const [events, setEvents] = useState<string[]>(['Reference snapshot validated', '256 chunk descriptors ready']);
  const [compileState, setCompileState] = useState<'idle' | 'estimating' | 'ready'>('idle');
  const [confirmCompile, setConfirmCompile] = useState(false);
  const [compileLimitsConfirmed, setCompileLimitsConfirmed] = useState(false);
  const [qualityProfile, setQualityProfile] = useState<QualityProfile>('local');
  const [heroRegionIds, setHeroRegionIds] = useState<string[]>([]);
  const [maxAssetGenerations, setMaxAssetGenerations] = useState(20);
  const [maxReferenceImages, setMaxReferenceImages] = useState(5);
  const [compilerHealth, setCompilerHealth] = useState<CompilerHealth>();
  const [snapshots, setSnapshots] = useState<EditorSnapshot[]>([]);
  const [jobs, setJobs] = useState<EditorJob[]>([]);
  const [compileWorkspace, setCompileWorkspace] = useState<CompileWorkspace>();
  const [selectedAsset, setSelectedAsset] = useState<string>();
  const [pendingAsset, setPendingAsset] = useState<PendingAssetImport>();
  const [assetLicenseName, setAssetLicenseName] = useState('User-provided commercial license');
  const [assetLicenseUrl, setAssetLicenseUrl] = useState('');
  const [assetAttribution, setAssetAttribution] = useState('');
  const [assetRightsAffirmed, setAssetRightsAffirmed] = useState(false);
  const [regenerationOpen, setRegenerationOpen] = useState(false);
  const [regenerationPrompt, setRegenerationPrompt] = useState('Increase visual detail while preserving topology, landmarks, and authored assets.');
  const [selectedEntity, setSelectedEntity] = useState<string>();
  const [loadedChunkSummaries, setLoadedChunkSummaries] = useState<LoadedChunkSummary[]>([]);
  const [selectedChunkId, setSelectedChunkId] = useState<string>();
  const [expandingChunkId, setExpandingChunkId] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef<VisualWorldEngine | undefined>(undefined);
  const baseTransforms = useRef(new Map<string, Transform>());
  const baseInstances = useRef(new Map<string, RuntimeInstance>());
  const assetFiles = useRef(new Map<string, File>());
  const assetObjectUrls = useRef(new Set<string>());
  const savedState = useRef(structuredClone(initialEditorState));
  const region = useMemo(() => design.regions.find((item) => item.id === selectedRegion) ?? design.regions[0]!, [design, selectedRegion]);
  const density = editor.densities[region.id] ?? region.density;
  const lastSnapshot = snapshots[snapshots.length - 1];
  const snapshotChanged = lastSnapshot ? JSON.stringify(lastSnapshot.state) !== JSON.stringify(editor) : false;
  const assetLicenseUrlValid = assetLicenseUrl.trim().length === 0 || URL.canParse(assetLicenseUrl.trim());
  const selectedChunk = loadedChunkSummaries.find((chunk) => chunk.id === selectedChunkId) ?? loadedChunkSummaries[0];
  const selectedChunkManifest = selectedChunk ? bundle.chunks.find((chunk) => chunk.id === selectedChunk.id) : undefined;
  const estimatedLocalInstanceCount = bundle.chunks.length * REFERENCE_SCATTER_INSTANCES_PER_CHUNK
    + bundle.authoredInstances.filter((instance) => !/^entity--?\d+--?\d+-0$/.test(instance.id)).length;
  const readyProviders = compilerHealth?.generation?.providers.filter((profile) => profile.operational && profile.configured) ?? [];
  const planningProvider = readyProviders.find((profile) => profile.provider === 'openrouter');
  const imageProvider = readyProviders.find((profile) => profile.provider === 'openrouter-image' && profile.modelId === 'openai/gpt-image-2');
  const cheapProviders = [planningProvider, imageProvider, readyProviders.find((profile) => profile.provider === 'wavespeed' && profile.modelId !== 'tripo3d/h3.1/multiview-to-3d')].filter((profile): profile is ProviderStatus => profile !== undefined);
  const studioMeshProvider = readyProviders.find((profile) => profile.provider === 'wavespeed' && profile.modelId === 'tripo3d/h3.1/multiview-to-3d');
  const studioProviders = [planningProvider, imageProvider, readyProviders.find((profile) => profile.provider === 'sam2-local'), studioMeshProvider].filter((profile): profile is ProviderStatus => profile !== undefined);
  const selectedCloudProviders = qualityProfile === 'studio' ? studioProviders : cheapProviders;
  const cloudAvailable = qualityProfile === 'cheap' ? cheapProviders.length === 3 : qualityProfile === 'studio' ? studioProviders.length === 4 && compilerHealth?.generation?.qualityProfiles?.studio.available === true : true;
  const reusableAssetLibrary = useMemo(() => bundle.prototypes.flatMap((prototype) => {
    if (prototype.assetUri.startsWith('primitive://') || !/^[a-f\d]{64}$/i.test(prototype.contentHash)) return [];
    const provenance = bundle.provenance.find((record) => record.subjectId === prototype.id && record.contentHash.toLowerCase() === prototype.contentHash.toLowerCase());
    if (!provenance?.reviewedAt || !provenance.license.commercialUse) return [];
    const sourceProvenance = provenanceAncestors(bundle.provenance, provenance);
    if (sourceProvenance.some((record) => !record.reviewedAt || !record.license.commercialUse)) return [];
    const lodProvenance = prototype.lods.map((lod) => bundle.provenance.find((record) => record.id === lod.provenanceId && record.contentHash.toLowerCase() === lod.contentHash.toLowerCase()));
    if (lodProvenance.some((record) => !record?.reviewedAt || !record.license.commercialUse)) return [];
    return [AssetLibraryEntrySchema.parse({
      id: prototype.id,
      class: prototype.tags[0] ?? prototype.id,
      assetUri: prototype.assetUri,
      contentHash: prototype.contentHash,
      textureFormat: prototype.textureFormat,
      boundsRadius: prototype.boundsRadius,
      lods: prototype.lods,
      materialVariants: prototype.materialVariants,
      animationClips: prototype.animationClips,
      tags: prototype.tags,
      provenance,
      sourceProvenance,
      lodProvenance,
      rightsAffirmed: true,
    })];
  }), [bundle]);
  const hardCostCap = qualityProfile === 'local' ? 0 : qualityProfile === 'cheap' ? 15 : 25;
  const estimatedMaximumCost = qualityProfile === 'local' ? 0 : selectedCloudProviders.reduce((sum, profile) => {
    const calls = profile.provider === 'openrouter' ? (qualityProfile === 'studio'
      ? 2 + maxReferenceImages * 3 + maxReferenceImages * 3 + 3 + maxReferenceImages
      : 2)
      : profile.provider === 'openrouter-image' || profile.provider === 'openai' ? (qualityProfile === 'studio'
        ? maxReferenceImages * 3 + maxAssetGenerations + maxAssetGenerations * 3 * 2
        : maxReferenceImages + maxAssetGenerations)
        : profile.provider === 'sam2-local' ? maxAssetGenerations
          : maxAssetGenerations * (qualityProfile === 'studio' ? 2 : 1);
    return sum + calls * profile.cost.usd;
  }, 0);
  const previewBundle = useMemo(() => VisualWorldBundleSchema.parse({
    ...bundle,
    prototypes: bundle.prototypes.map((prototype) => {
      const replacement = editor.assetReplacements[prototype.id];
      return replacement ? { ...prototype, assetUri: replacement.previewUri, contentHash: replacement.contentHash } : prototype;
    }),
  }), [bundle, editor.assetReplacements]);

  const onWorldEvent = (event: VisualWorldEvent) => {
    if (event.type === 'chunk-error') setEvents((items) => [`Chunk ${event.chunkId}: ${event.error.message}`, ...items].slice(0, 8));
    if (event.type === 'origin-shifted') setEvents((items) => [`Floating origin shifted to ${event.origin[0].toFixed(0)}, ${event.origin[2].toFixed(0)}`, ...items].slice(0, 8));
    if (event.type === 'chunk-loaded') {
      const summary: LoadedChunkSummary = {
        id: event.chunk.id,
        coordinate: event.chunk.coordinate,
        terrainSamples: event.chunk.terrain.samples,
        minHeight: event.chunk.terrain.minHeight,
        maxHeight: event.chunk.terrain.maxHeight,
        instances: event.chunk.instances.length,
        dependencies: event.chunk.dependencies.length,
        occlusionCells: event.chunk.occlusionCells.length,
        placeholder: event.chunk.placeholder,
      };
      setLoadedChunkSummaries((items) => [...items.filter((item) => item.id !== summary.id), summary].sort((a, b) => a.id.localeCompare(b.id)));
      setSelectedChunkId((current) => current ?? summary.id);
    }
    if (event.type === 'chunk-unloaded') {
      setLoadedChunkSummaries((items) => items.filter((item) => item.id !== event.chunkId));
      setSelectedChunkId((current) => current === event.chunkId ? undefined : current);
    }
    if (event.type === 'entity-available') {
      const matrix = event.entity.matrix;
      const scale = Math.hypot(matrix[0], matrix[1], matrix[2]);
      const yaw = Math.atan2(matrix[8] / Math.max(0.0001, scale), matrix[0] / Math.max(0.0001, scale));
      baseTransforms.current.set(event.entity.id, { position: [matrix[12], matrix[13], matrix[14]], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], scale: [scale, scale, scale] });
      baseInstances.current.set(event.entity.id, event.entity);
    }
    if (event.type === 'entity-disposed') {
      baseTransforms.current.delete(event.entityId);
      baseInstances.current.delete(event.entityId);
    }
  };

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    for (const [id, transform] of Object.entries(editor.entityTransforms)) engine.setEntityTransform(id as never, transform);
  }, [editor.entityTransforms]);

  useEffect(() => {
    setLoadedChunkSummaries([]);
    setSelectedChunkId(undefined);
  }, [bundle.worldId, bundle.bundleVersion, bundle.sourceRevision]);

  useEffect(() => () => {
    for (const uri of assetObjectUrls.current) URL.revokeObjectURL(uri);
    assetObjectUrls.current.clear();
  }, []);

  useEffect(() => {
    const endpoint = compilerEndpoint();
    const controller = new AbortController();
    void fetch(`${endpoint}/health`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`Health check returned ${response.status}`);
      setCompilerHealth(await response.json() as CompilerHealth);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setEvents((items) => [`Compiler health unavailable: ${(error as Error).message}`, ...items].slice(0, 8));
    });
    return () => controller.abort();
  }, []);

  const handleEngine = (engine: VisualWorldEngine | undefined) => {
    engineRef.current = engine;
    if (engine) for (const [id, transform] of Object.entries(editor.entityTransforms)) engine.setEntityTransform(id as never, transform);
  };

  const applyToolTransform = (direction = 1) => {
    if (!selectedEntity || !['move', 'rotate', 'scale'].includes(tool)) return;
    const current = editor.entityTransforms[selectedEntity] ?? baseTransforms.current.get(selectedEntity);
    if (!current) return;
    let transform: Transform = structuredClone(current);
    if (tool === 'move') transform = { ...transform, position: [transform.position[0] + direction * 2, transform.position[1], transform.position[2]] };
    if (tool === 'scale') transform = { ...transform, scale: transform.scale.map((value) => Math.max(0.1, value * (direction > 0 ? 1.1 : 0.9))) as Transform['scale'] };
    if (tool === 'rotate') {
      const angle = direction * Math.PI / 12;
      const [x, y, z, w] = transform.rotation;
      const sine = Math.sin(angle / 2);
      const cosine = Math.cos(angle / 2);
      transform = { ...transform, rotation: [x * cosine - z * sine, w * sine + y * cosine, x * sine + z * cosine, w * cosine - y * sine] };
    }
    history.apply(`${tool} entity`, (state) => ({ ...state, entityTransforms: { ...state.entityTransforms, [selectedEntity]: transform }, revision: state.revision + 1 }));
  };

  const refreshCompileWorkspace = async (compileId: string) => {
    const endpoint = compilerEndpoint();
    const [catalogResponse, reportResponse] = await Promise.all([
      fetch(`${endpoint}/v1/compiles/${encodeURIComponent(compileId)}/artifacts`),
      fetch(`${endpoint}/v1/compiles/${encodeURIComponent(compileId)}/report`),
    ]);
    if (!catalogResponse.ok || !reportResponse.ok) throw new Error(`Compile workspace returned ${catalogResponse.status}/${reportResponse.status}`);
    const catalog = CompileArtifactCatalogSchema.parse(await catalogResponse.json());
    const report = CompileReportSchema.parse(await reportResponse.json());
    setCompileWorkspace({ id: compileId, status: report.status, catalog, report });
  };

  const loadPublishedCompile = (compileEvent: { data?: Record<string, unknown> }, endpoint: string) => {
    const rawBundle = VisualWorldBundleSchema.parse(compileEvent.data?.['bundle']);
    const nextBundle = resolveBundleAssetUris(rawBundle, new URL(`${endpoint}/v1/worlds/${encodeURIComponent(rawBundle.worldId)}/bundle`));
    const nextDesign = WorldDesignSpecSchema.parse(compileEvent.data?.['designSpec']);
    const nextAuthoring = AuthoringWorldSchema.parse(compileEvent.data?.['authoringWorld']);
    setBundle(nextBundle);
    setDesign(nextDesign);
    setAuthoringWorld(nextAuthoring);
    setRemoteWorld({ id: nextBundle.worldId, revision: nextBundle.sourceRevision });
    setSelectedRegion(nextDesign.regions[0]!.id);
    baseTransforms.current.clear();
    baseInstances.current.clear();
    for (const uri of assetObjectUrls.current) URL.revokeObjectURL(uri);
    assetObjectUrls.current.clear();
    assetFiles.current.clear();
    const nextState: EditorState = {
      prompt: nextDesign.prompt,
      time: nextDesign.environment.timeOfDay,
      weather: nextDesign.environment.weather,
      densities: Object.fromEntries(nextDesign.regions.map((region) => [region.id, region.density])),
      terrainEdits: structuredClone(nextAuthoring.terrain.edits),
      assetReplacements: {}, entityTransforms: {}, revision: nextAuthoring.revision,
    };
    savedState.current = structuredClone(nextState);
    history.reset(nextState);
    setEvents((items) => [`Published and loaded ${nextDesign.title}: ${nextBundle.chunks.length} chunks, ${nextAuthoring.entities.length.toLocaleString()} entities`, ...items].slice(0, 8));
  };

  const attachCompileStream = (compileId: string, execute: boolean) => {
    const endpoint = compilerEndpoint();
    const stream = new EventSource(`${endpoint}/v1/compiles/${compileId}/events`);
    stream.addEventListener('cost', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { data?: { estimatedCostUsd?: number } };
      const costUsd = payload.data?.estimatedCostUsd ?? 0;
      setJobs((items) => items.map((job) => job.id === compileId ? { ...job, costUsd } : job));
      setCompileWorkspace((current) => current?.id === compileId ? { ...current, status: 'in-progress' } : current);
    });
    stream.addEventListener('artifact', (event) => {
      void refreshCompileWorkspace(compileId).catch((error: unknown) => setEvents((items) => [`Artifact catalog unavailable: ${(error as Error).message}`, ...items].slice(0, 8)));
      try {
        const compileEvent = JSON.parse((event as MessageEvent<string>).data) as { data?: Record<string, unknown> };
        if (!execute) {
          setEvents((items) => ['Dry-run artifacts validated without replacing the open world', ...items].slice(0, 8));
          return;
        }
        loadPublishedCompile(compileEvent, endpoint);
      } catch (error) {
        setEvents((items) => [`Compiler artifact rejected: ${(error as Error).message}`, ...items].slice(0, 8));
      }
    });
    for (const active of ['phase-started', 'progress']) stream.addEventListener(active, () => setCompileWorkspace((current) => current?.id === compileId ? { ...current, status: 'in-progress' } : current));
    for (const terminal of ['completed', 'needs-attention', 'failed', 'cancelled']) stream.addEventListener(terminal, (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { type: string; message?: string };
      setJobs((items) => items.map((job) => job.id === compileId ? { ...job, status: payload.type } : job));
      if (payload.type !== 'completed') setEvents((items) => [`Cloud compile ${payload.type}: ${payload.message ?? 'all staged artifacts remain available'}. Open world unchanged.`, ...items].slice(0, 8));
      void refreshCompileWorkspace(compileId).catch((error: unknown) => setEvents((items) => [`Compile report unavailable: ${(error as Error).message}`, ...items].slice(0, 8)));
      stream.close();
    });
    return stream;
  };

  const resumeCompile = async (newCap: number) => {
    if (!compileWorkspace) return;
    const response = await fetch(`${compilerEndpoint()}/v1/compiles/${encodeURIComponent(compileWorkspace.id)}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxCostUsd: newCap, confirmed: true }) });
    if (!response.ok) throw new Error(`Resume returned ${response.status}`);
    setCompileWorkspace((current) => current ? { ...current, status: 'in-progress' } : current);
    setJobs((items) => items.map((job) => job.id === compileWorkspace.id ? { ...job, status: 'in-progress' } : job));
    attachCompileStream(compileWorkspace.id, true);
  };

  const estimate = async (execute = false) => {
    setCompileState('estimating');
    const endpoint = compilerEndpoint();
    try {
        if (qualityProfile !== 'local' && !cloudAvailable) throw new Error(`${qualityProfile} profile is missing reviewed provider or worker capabilities`);
        const selectedProfiles = qualityProfile === 'local' ? [] : qualityProfile === 'cheap' ? [
          { profile: cheapProviders.find((item) => item.provider === 'openrouter')!, role: 'planner' },
          { profile: cheapProviders.find((item) => item.provider === 'openrouter')!, role: 'reviewer' },
          { profile: imageProvider!, role: 'composition-image' },
          { profile: cheapProviders.find((item) => item.provider === 'wavespeed')!, role: 'image-to-3d' },
        ] : [
          { profile: studioProviders.find((item) => item.provider === 'openrouter')!, role: 'planner' },
          { profile: studioProviders.find((item) => item.provider === 'openrouter')!, role: 'reviewer' },
          { profile: studioProviders.find((item) => item.provider === 'openrouter')!, role: 'object-detection' },
          { profile: imageProvider!, role: 'composition-image' },
          { profile: imageProvider!, role: 'multiview-image' },
          { profile: studioProviders.find((item) => item.provider === 'sam2-local')!, role: 'segmentation' },
          { profile: studioMeshProvider!, role: 'image-to-3d' },
        ];
        const providerModels = selectedProfiles.map(({ profile, role }) => ({ provider: profile.provider, modelId: profile.modelId, revision: profile.revision, termsFingerprint: profile.termsFingerprint, role }));
        const response = await fetch(`${endpoint}/v1/compiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          prompt: editor.prompt, seed: bundle.seed, qualityProfile, heroRegionIds, refinementPolicy: qualityProfile === 'studio'
            ? { maxTerrainRounds: 3, maxCompositionAttempts: 3, maxAssetAttempts: 2, maxSceneRounds: 3, maxAssetRepairRounds: 2, maxSceneRepairRounds: 1, terrainCoDeformation: true }
            : { maxTerrainRounds: 0, maxCompositionAttempts: 1, maxAssetAttempts: 1, maxSceneRounds: 0, maxAssetRepairRounds: 0, maxSceneRepairRounds: 0, terrainCoDeformation: false },
          maxCostUsd: hardCostCap, maxAssetGenerations: qualityProfile === 'local' ? 0 : maxAssetGenerations,
          maxReferenceImages: qualityProfile === 'local' ? 0 : maxReferenceImages, territory: 'NL', commercialUse: true, dryRun: !execute, providerModels,
          assetLibrary: reusableAssetLibrary,
        }) });
        if (!response.ok) throw new Error(`Compiler returned ${response.status}`);
        const result = await response.json() as { compileId: string };
        setJobs((items) => [{ id: result.compileId, kind: 'compile' as const, status: 'queued', createdAt: new Date().toISOString(), costUsd: 0 }, ...items].slice(0, 30));
        setCompileWorkspace({ id: result.compileId, status: 'queued' });
        attachCompileStream(result.compileId, execute);
        setEvents((items) => [`${execute ? 'Compile' : 'Dry run'} ${result.compileId.slice(0, 8)} queued — $${hardCostCap.toFixed(2)} hard cap`, ...items].slice(0, 8));
    } catch (error) {
      setEvents((items) => [`Compiler unavailable: ${(error as Error).message}`, ...items].slice(0, 8));
    }
    setCompileState('ready');
  };

  const chooseQualityProfile = (profile: QualityProfile) => {
    setQualityProfile(profile);
    setCompileLimitsConfirmed(false);
    if (profile === 'local') { setMaxAssetGenerations(0); setMaxReferenceImages(0); setHeroRegionIds([]); }
    if (profile === 'cheap') { setMaxAssetGenerations(5); setMaxReferenceImages(1); setHeroRegionIds([selectedRegion]); }
    if (profile === 'studio') { setMaxAssetGenerations(8); setMaxReferenceImages(1); setHeroRegionIds([selectedRegion]); }
  };

  const toggleHeroRegion = (regionId: string) => {
    const maximum = qualityProfile === 'studio' ? 1 : qualityProfile === 'cheap' ? 1 : 0;
    setHeroRegionIds((current) => current.includes(regionId) ? current.filter((id) => id !== regionId) : maximum === 1 ? [regionId] : [...current, regionId].slice(0, maximum));
  };

  const exportBundle = async () => {
    const prototypes = bundle.prototypes.map((prototype) => {
      const replacement = editor.assetReplacements[prototype.id];
      return replacement ? { ...prototype, assetUri: replacement.uri, contentHash: replacement.contentHash } : prototype;
    });
    const authored = new Map<string, RuntimeInstance>(bundle.authoredInstances.map((instance) => [instance.id, instance]));
    for (const [entityId, transform] of Object.entries(editor.entityTransforms)) {
      const source = authored.get(entityId) ?? baseInstances.current.get(entityId);
      if (!source) continue;
      authored.set(entityId, { ...source, matrix: matrixFromTransform(transform) });
    }
    const regions = bundle.regions.map((item) => ({ ...item, density: editor.densities[item.id] ?? item.density }));
    const invalidationKey = JSON.stringify({ terrainEdits: editor.terrainEdits, densities: editor.densities, revision: editor.revision });
    const chunks = await Promise.all(bundle.chunks.map(async (entry) => entry.source.kind === 'procedural' ? {
      ...entry,
      source: { ...entry.source, contentHash: await sha256(`${entry.source.contentHash}:${invalidationKey}`) },
    } : entry));
    const exported = VisualWorldBundleSchema.parse({
      ...bundle, id: `${bundle.worldId}-editor-${editor.revision}`, bundleVersion: bundle.bundleVersion + 1,
      sourceRevision: bundle.sourceRevision + 1, createdAt: new Date().toISOString(),
      terrain: bundle.terrain ? { ...bundle.terrain, edits: editor.terrainEdits } : bundle.terrain,
      environment: { ...bundle.environment, timeOfDay: editor.time, weather: editor.weather },
      prototypes, authoredInstances: [...authored.values()], regions, chunks,
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${bundle.worldId}-v${exported.bundleVersion}.json`; anchor.click(); URL.revokeObjectURL(url);
    setEvents((items) => [`Exported immutable bundle v${exported.bundleVersion}`, ...items].slice(0, 8));
  };

  const fetchRemoteWorld = async (endpoint: string, worldId: string): Promise<void> => {
    const [bundleResponse, designResponse, authoringResponse] = await Promise.all([
      fetch(`${endpoint}/v1/worlds/${encodeURIComponent(worldId)}/bundle`),
      fetch(`${endpoint}/v1/worlds/${encodeURIComponent(worldId)}/design`),
      fetch(`${endpoint}/v1/worlds/${encodeURIComponent(worldId)}/authoring`),
    ]);
    if (!bundleResponse.ok || !designResponse.ok || !authoringResponse.ok) throw new Error('Compiler rejected the updated canonical world');
    const [nextBundleValue, nextDesignValue, nextAuthoringValue] = await Promise.all([bundleResponse.json(), designResponse.json(), authoringResponse.json()]);
    const nextBundle = resolveBundleAssetUris(VisualWorldBundleSchema.parse(nextBundleValue), new URL(`${endpoint}/v1/worlds/${encodeURIComponent(worldId)}/bundle`));
    const nextDesign = WorldDesignSpecSchema.parse(nextDesignValue);
    const nextAuthoring = AuthoringWorldSchema.parse(nextAuthoringValue);
    setBundle(nextBundle);
    setDesign(nextDesign);
    setAuthoringWorld(nextAuthoring);
    setRemoteWorld({ id: nextBundle.worldId, revision: nextBundle.sourceRevision });
    setSelectedRegion((current) => nextDesign.regions.some((item) => item.id === current) ? current : nextDesign.regions[0]!.id);
    baseTransforms.current.clear();
    baseInstances.current.clear();
    for (const uri of assetObjectUrls.current) URL.revokeObjectURL(uri);
    assetObjectUrls.current.clear();
    assetFiles.current.clear();
    const nextState: EditorState = {
      prompt: nextDesign.prompt,
      time: nextDesign.environment.timeOfDay,
      weather: nextDesign.environment.weather,
      densities: Object.fromEntries(nextDesign.regions.map((item) => [item.id, item.density])),
      terrainEdits: structuredClone(nextAuthoring.terrain.edits),
      assetReplacements: {},
      entityTransforms: {},
      revision: nextAuthoring.revision,
    };
    savedState.current = structuredClone(nextState);
    history.reset(nextState);
  };

  const savePatch = async (extraOperations: WorldPatchOperation[] = []): Promise<boolean> => {
    const endpoint = compilerEndpoint();
    if (!remoteWorld) {
      setEvents((items) => ['Save requires a compiled remote world', ...items].slice(0, 8));
      return false;
    }
    const previous = savedState.current;
    if (editor.prompt !== previous.prompt) {
      setEvents((items) => ['Prompt changes require Compile world so intent is parsed into a new immutable design', ...items].slice(0, 8));
      return false;
    }
    const operations: WorldPatchOperation[] = [...extraOperations];
    if (editor.time !== previous.time || editor.weather !== previous.weather) operations.push({ op: 'set-environment', values: { timeOfDay: editor.time, weather: editor.weather } });
    for (const item of design.regions) {
      const nextDensity = editor.densities[item.id] ?? item.density;
      const previousDensity = previous.densities[item.id] ?? item.density;
      if (nextDensity !== previousDensity) operations.push({ op: 'set-region-density', regionId: item.id, density: nextDensity });
    }
    for (const edit of editor.terrainEdits.slice(previous.terrainEdits.length)) operations.push({ op: 'add-terrain-edit', ...edit });
    for (const [entityId, transform] of Object.entries(editor.entityTransforms)) operations.push({ op: 'set-transform', entityId: entityId as never, transform });
    const replacements = Object.entries(editor.assetReplacements);
    if (operations.length === 0 && replacements.length === 0) {
      setEvents((items) => ['No canonical changes to save', ...items].slice(0, 8));
      return false;
    }
    let currentRevision = remoteWorld.revision;
    for (const [prototypeId, replacement] of replacements) {
      const file = assetFiles.current.get(prototypeId);
      if (!file) throw new Error(`Replacement file for ${prototypeId} is no longer available; select it again`);
      const response = await fetch(`${endpoint}/v1/worlds/${encodeURIComponent(remoteWorld.id)}/assets/${encodeURIComponent(prototypeId)}/import`, {
        method: 'POST',
        headers: {
          'content-type': 'model/gltf-binary',
          'x-worldengine-base-revision': String(currentRevision),
          'x-worldengine-rights-affirmed': String(replacement.rightsAffirmed),
          'x-worldengine-license-name': encodeURIComponent(replacement.licenseName),
          'x-worldengine-file-name': encodeURIComponent(replacement.fileName),
          ...(replacement.licenseUrl ? { 'x-worldengine-license-url': encodeURIComponent(replacement.licenseUrl) } : {}),
          ...(replacement.attribution ? { 'x-worldengine-attribution': encodeURIComponent(replacement.attribution) } : {}),
        },
        body: file,
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({})) as { message?: string; error?: string };
        throw new Error(problem.message ?? problem.error ?? `Asset import failed with ${response.status}`);
      }
      const result = await response.json() as { revision: number };
      currentRevision = result.revision;
      setRemoteWorld({ id: remoteWorld.id, revision: currentRevision });
    }
    let patchId: ReturnType<typeof PatchIdSchema.parse> | undefined;
    if (operations.length > 0) {
      patchId = PatchIdSchema.parse(`editor-${crypto.randomUUID()}`);
      const response = await fetch(`${endpoint}/v1/worlds/${encodeURIComponent(remoteWorld.id)}/patches`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: patchId, worldId: remoteWorld.id, baseRevision: currentRevision, createdAt: new Date().toISOString(), author: 'worldengine-editor', operations }),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({})) as { message?: string; error?: string };
        throw new Error(problem.message ?? problem.error ?? `Patch failed with ${response.status}`);
      }
    }
    await fetchRemoteWorld(endpoint, remoteWorld.id);
    setEvents((items) => [`Saved ${replacements.length} asset import${replacements.length === 1 ? '' : 's'}${patchId ? ` and patch ${patchId.slice(0, 12)}` : ''}`, ...items].slice(0, 8));
    return true;
  };

  const regenerateRegion = async () => {
    const minX = Math.min(...region.polygon.map((point) => point[0]));
    const maxX = Math.max(...region.polygon.map((point) => point[0]));
    const minZ = Math.min(...region.polygon.map((point) => point[1]));
    const maxZ = Math.max(...region.polygon.map((point) => point[1]));
    const affected = bundle.chunks.filter((entry) => entry.bounds.max[0] >= minX && entry.bounds.min[0] <= maxX && entry.bounds.max[1] >= minZ && entry.bounds.min[1] <= maxZ);
    const id = crypto.randomUUID();
    setJobs((items) => [{ id, kind: 'regenerate', status: 'running', createdAt: new Date().toISOString(), costUsd: 0 }, ...items]);
    try {
      const lower = regenerationPrompt.toLowerCase();
      const biome = /desert|dune|arid/.test(lower) ? 'desert' : /snow|frozen|ice|tundra/.test(lower) ? 'frozen-tundra'
        : /volcan|lava|ash/.test(lower) ? 'volcanic' : /wetland|swamp|marsh/.test(lower) ? 'wetland'
          : /forest|wood|grove/.test(lower) ? 'temperate-forest' : /coast|shore|beach/.test(lower) ? 'coastal'
            : /grass|plain|meadow/.test(lower) ? 'grassland' : /mountain|highland|cliff/.test(lower) ? 'highland' : region.biome;
      const regeneratedDensity = /\bsparse|empty|open\b/.test(lower) ? Math.max(0.05, density * 0.65) : /\bdense|lush|crowded|thick\b/.test(lower) ? Math.min(1, density * 1.25) : density;
      const regeneratedRegion = { ...region, biome, density: regeneratedDensity, description: `${region.description}\nRegenerated visual direction: ${regenerationPrompt.trim()}`.trim() };
      const saved = await savePatch([{ op: 'replace-region', region: regeneratedRegion }, ...affected.map((entry) => ({ op: 'invalidate-chunk' as const, chunkId: entry.id }))]);
      setJobs((items) => items.map((job) => job.id === id ? { ...job, status: saved ? 'completed' : 'blocked' } : job));
      if (saved) {
        setRegenerationOpen(false);
        setEvents((items) => [`Regenerated ${affected.length} chunks intersecting ${region.name} from a schema-valid regional prompt`, ...items].slice(0, 8));
      }
    } catch (error) {
      setJobs((items) => items.map((job) => job.id === id ? { ...job, status: 'failed' } : job));
      setEvents((items) => [`Region regeneration failed: ${(error as Error).message}`, ...items].slice(0, 8));
    }
  };

  const expandSelectedChunk = async () => {
    if (!selectedChunk?.placeholder) return;
    if (!remoteWorld) {
      setEvents((items) => ['Detailed chunk generation requires a compiled remote world', ...items].slice(0, 8));
      return;
    }
    const endpoint = compilerEndpoint();
    const jobId = crypto.randomUUID();
    setExpandingChunkId(selectedChunk.id);
    setJobs((items) => [{ id: jobId, kind: 'expand' as const, status: 'running', createdAt: new Date().toISOString(), costUsd: 0 }, ...items].slice(0, 30));
    try {
      const response = await fetch(`${endpoint}/v1/worlds/${encodeURIComponent(remoteWorld.id)}/chunks/${selectedChunk.coordinate.x}/${selectedChunk.coordinate.z}/compile`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxCostUsd: 0, maxAssetGenerations: 0 }),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({})) as { message?: string; error?: string };
        throw new Error(problem.message ?? problem.error ?? `Chunk expansion failed with ${response.status}`);
      }
      const result = await response.json() as { chunkId: string; bundleVersion: number; revision: number };
      await fetchRemoteWorld(endpoint, remoteWorld.id);
      setSelectedChunkId(result.chunkId);
      setJobs((items) => items.map((job) => job.id === jobId ? { ...job, status: 'completed' } : job));
      setEvents((items) => [`Detailed ${result.chunkId} published in immutable bundle v${result.bundleVersion}; runtime reload queued`, ...items].slice(0, 8));
    } catch (error) {
      setJobs((items) => items.map((job) => job.id === jobId ? { ...job, status: 'failed' } : job));
      setEvents((items) => [`Chunk expansion failed: ${(error as Error).message}`, ...items].slice(0, 8));
    } finally {
      setExpandingChunkId(undefined);
    }
  };

  const captureSnapshot = () => {
    const snapshot: EditorSnapshot = { id: crypto.randomUUID(), name: `Snapshot ${String(snapshots.length + 2).padStart(2, '0')}`, createdAt: new Date().toISOString(), state: structuredClone(editor) };
    setSnapshots((items) => [...items, snapshot]);
    setEvents((items) => [`Captured ${snapshot.name}`, ...items].slice(0, 8));
  };

  const applyTerrainBrush = (pickedCenter?: [number, number]) => {
    const index = editor.terrainEdits.length;
    const center: [number, number] = pickedCenter ?? [((index % 5) - 2) * 96, (Math.floor(index / 5) - 1) * 96];
    history.apply('Terrain brush', (current) => ({ ...current, terrainEdits: [...current.terrainEdits, { center, radius: 96, delta: 6, mode: 'add' }], revision: current.revision + 1 }));
    setEvents((items) => [`Terrain raised +6m at ${center[0].toFixed(1)}, ${center[1].toFixed(1)}`, ...items].slice(0, 8));
  };

  const applyRegionBrush = (pickedPoint?: [number, number]) => {
    const targetRegion = pickedPoint ? design.regions.find((candidate) => pointInPolygon(pickedPoint, candidate.polygon)) : region;
    if (!targetRegion) {
      setEvents((items) => [`No canonical region contains ${pickedPoint?.[0].toFixed(1)}, ${pickedPoint?.[1].toFixed(1)}`, ...items].slice(0, 8));
      return;
    }
    const nextDensity = Math.min(1, (editor.densities[targetRegion.id] ?? targetRegion.density) + 0.05);
    setSelectedRegion(targetRegion.id);
    history.apply('Region brush', (current) => ({
      ...current,
      densities: { ...current.densities, [targetRegion.id]: nextDensity },
      revision: current.revision + 1,
    }));
    setEvents((items) => [`Region brush raised ${targetRegion.name} density to ${Math.round(nextDensity * 100)}%${pickedPoint ? ` at ${pickedPoint[0].toFixed(1)}, ${pickedPoint[1].toFixed(1)}` : ''}`, ...items].slice(0, 8));
  };

  const replaceAsset = async (file: File | undefined) => {
    if (!file || !selectedAsset) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
    setPendingAsset({ prototypeId: selectedAsset, file, contentHash: digest });
    setAssetRightsAffirmed(false);
  };

  const confirmAssetImport = () => {
    if (!pendingAsset || !assetRightsAffirmed || assetLicenseName.trim().length === 0 || !assetLicenseUrlValid) return;
    const previous = editor.assetReplacements[pendingAsset.prototypeId];
    if (previous) {
      URL.revokeObjectURL(previous.previewUri);
      assetObjectUrls.current.delete(previous.previewUri);
    }
    const previewUri = URL.createObjectURL(pendingAsset.file);
    assetObjectUrls.current.add(previewUri);
    assetFiles.current.set(pendingAsset.prototypeId, pendingAsset.file);
    history.apply('Replace asset', (current) => ({
      ...current, revision: current.revision + 1,
      assetReplacements: { ...current.assetReplacements, [pendingAsset.prototypeId]: {
        uri: `assets/${pendingAsset.contentHash}.glb`, previewUri, contentHash: pendingAsset.contentHash, fileName: pendingAsset.file.name, byteLength: pendingAsset.file.size,
        licenseName: assetLicenseName.trim(), ...(assetLicenseUrl.trim() ? { licenseUrl: assetLicenseUrl.trim() } : {}), ...(assetAttribution.trim() ? { attribution: assetAttribution.trim() } : {}), rightsAffirmed: true as const,
      } },
    }));
    setEvents((items) => [`Staged reviewed replacement ${pendingAsset.file.name} for ${pendingAsset.prototypeId}`, ...items].slice(0, 8));
    setPendingAsset(undefined);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Icon size={21}>{icons.cube}</Icon></span><span>WORLD<strong>ENGINE</strong></span><span className="version">0.1</span></div>
        <div className="project-title"><span className="status-dot" /> {design.title} <span>/</span> {bundle.qualityProfile === 'local' ? 'Local draft' : `${bundle.qualityProfile} published`} <span>/</span> Bundle {bundle.bundleVersion}</div>
        <div className="top-actions"><button className="icon-text-button" disabled={!history.canUndo} onClick={history.undo} title={history.undoLabel}>↶ Undo</button><button className="icon-text-button" disabled={!history.canRedo} onClick={history.redo} title={history.redoLabel}>↷ Redo</button><button className="ghost-button" onClick={captureSnapshot}>Snapshot</button>{remoteWorld && <button className="ghost-button" onClick={() => void savePatch().catch((error: unknown) => setEvents((items) => [`Save failed: ${(error as Error).message}`, ...items].slice(0, 8)))}>Save patch</button>}<button className="ghost-button" onClick={() => void exportBundle()}>Export bundle</button><button className="primary-button" onClick={() => { setCompileLimitsConfirmed(false); setConfirmCompile(true); }} disabled={compileState === 'estimating'}>{compileState === 'estimating' ? 'Estimating…' : 'Compile world'}</button></div>
      </header>

      <div className="workspace">
        <aside className="toolrail" aria-label="Viewport tools">
          {(['select','move','rotate','scale','terrain','region'] as Tool[]).map((name) => <button key={name} className={tool === name ? 'active' : ''} onClick={() => setTool(name)} aria-label={name}><Icon>{icons[name]}</Icon></button>)}
          <span className="rail-spacer" />
          <button aria-label="Preview" className={mode !== 'sandbox' ? 'previewing' : ''} onClick={() => setMode(mode === 'sandbox' ? 'third-person' : 'sandbox')}><Icon>{icons.play}</Icon></button>
        </aside>

        <aside className="left-panel panel">
          <div className="tabs"><button className={leftTab === 'world' ? 'selected' : ''} onClick={() => setLeftTab('world')}>World</button><button className={leftTab === 'assets' ? 'selected' : ''} onClick={() => setLeftTab('assets')}>Assets</button><button className={leftTab === 'pipeline' ? 'selected' : ''} onClick={() => setLeftTab('pipeline')}>Pipeline</button></div>
          {leftTab === 'world' ? <>
            <section className="prompt-card"><label htmlFor="prompt">WORLD DIRECTION</label><textarea id="prompt" value={editor.prompt} onChange={(event) => history.apply('Edit prompt', (current) => ({ ...current, prompt: event.target.value, revision: current.revision + 1 }))} /><div className="prompt-meta"><span>Seed {bundle.seed}</span><button onClick={() => void estimate(false)}>Dry-run cost</button></div></section>
            <section><div className="section-heading"><span>REGIONS</span><span>{design.regions.length}</span></div><RegionMap design={design} selected={selectedRegion} onSelect={setSelectedRegion} /></section>
            <nav className="hierarchy">
              <div className="tree-row root"><Icon size={15}>{icons.layers}</Icon><span>{design.title}</span></div>
              {design.regions.map((item, index) => <button key={item.id} className={`tree-row ${selectedRegion === item.id ? 'current' : ''}`} onClick={() => setSelectedRegion(item.id)}><span className="swatch" style={{ backgroundColor: ['#668d7a','#769d88','#3f6c54','#9a9e6c','#65777b'][index] }} /><span>{item.name}</span><small>{Math.round((editor.densities[item.id] ?? item.density) * 100)}%</small></button>)}
            </nav>
          </> : leftTab === 'assets' ? <section className="asset-grid"><input ref={fileInputRef} type="file" accept=".glb,model/gltf-binary" hidden onChange={(event) => void replaceAsset(event.target.files?.[0])}/>{!remoteWorld && <p className="asset-gate-note">Compile a remote world first. Reviewed GLBs are uploaded directly into an immutable world version and are never embedded in a compile request.</p>}{bundle.prototypes.map((prototype) => <button key={prototype.id} disabled={!remoteWorld} title={!remoteWorld ? 'Compile world before importing assets' : `Replace ${prototype.tags[0]}`} onClick={() => { setSelectedAsset(prototype.id); fileInputRef.current?.click(); }}><span className="asset-thumb"><Icon size={24}>{icons.cube}</Icon></span><span>{prototype.tags[0]}</span><small>{editor.assetReplacements[prototype.id]?.fileName ?? 'Library · reviewed'}</small></button>)}</section> : <section className="generation-panel">
            <small>SERVER-SIDE BYOK</small><h3>Generation pipeline</h3><p>Keys never enter this browser or an exported game. Configure them on the compiler service with reviewed provider policies.</p>
            <label className={`generation-mode ${qualityProfile === 'local' ? 'active' : ''}`}><input type="radio" name="generation-mode" checked={qualityProfile === 'local'} onChange={() => chooseQualityProfile('local')} /><span><strong>Local draft</strong><small>$0 · deterministic procedural preview with marked placeholders</small></span></label>
            <label className={`generation-mode ${qualityProfile === 'cheap' ? 'active' : ''} ${cheapProviders.length !== 3 ? 'disabled' : ''}`}><input type="radio" name="generation-mode" checked={qualityProfile === 'cheap'} disabled={cheapProviders.length !== 3} onChange={() => chooseQualityProfile('cheap')} /><span><strong>Cheap</strong><small>≤ $15 · one hero region · five generated assets</small></span></label>
            <label className={`generation-mode ${qualityProfile === 'studio' ? 'active' : ''} ${studioProviders.length !== 4 || compilerHealth?.generation?.qualityProfiles?.studio.available !== true ? 'disabled' : ''}`}><input type="radio" name="generation-mode" checked={qualityProfile === 'studio'} disabled={studioProviders.length !== 4 || compilerHealth?.generation?.qualityProfiles?.studio.available !== true} onChange={() => chooseQualityProfile('studio')} /><span><strong>Studio · experimental</strong><small>First gate ≤ $25 · one hero region · eight multiview PBR assets</small></span></label>
            <div className="provider-list">{(compilerHealth?.generation?.providers ?? []).map((profile) => { const ready = profile.operational && profile.configured; return <div key={`${profile.provider}:${profile.modelId}`} title={profile.operationalIssues.join(', ')}><i className={ready ? 'ready' : ''} /><span><strong>{profile.provider}</strong><small>{profile.modelId}</small></span><em>{ready ? 'READY' : !profile.operational ? 'POLICY REVIEW' : 'NO KEY'}</em></div>; })}{!compilerHealth?.generation && <p>Connect the current compiler service to inspect providers.</p>}</div>
            {!cloudAvailable && <div className="provider-setup"><strong>Why there is no API-key dialog</strong><p>This browser intentionally never asks for API keys. Review the policy file, put keys in the compiler service's ignored <code>.env.local</code>, then start:</p><code>pnpm --filter @worldengine/compiler-service dev:configured</code></div>}
            {qualityProfile === 'studio' && <div className="studio-provider"><strong>Fixed reconstruction profile</strong><small>WaveSpeed · tripo3d/h3.1/multiview-to-3d · front/left/back/right · PBR</small></div>}
            {qualityProfile !== 'local' && <div className="hero-regions"><small>HERO REGIONS · {heroRegionIds.length}/1</small>{design.regions.map((item) => <label key={item.id}><input type="checkbox" checked={heroRegionIds.includes(item.id)} onChange={() => toggleHeroRegion(item.id)} /><span>{item.name}</span></label>)}</div>}
            <div className="generation-limits"><label>3D assets<input type="number" min="0" max={qualityProfile === 'cheap' ? 5 : 8} value={maxAssetGenerations} disabled={qualityProfile === 'local'} onChange={(event) => setMaxAssetGenerations(Math.max(0, Math.min(qualityProfile === 'cheap' ? 5 : 8, Number(event.target.value))))} /></label><label>Region images<input type="number" min="0" max="1" value={maxReferenceImages} disabled={qualityProfile === 'local'} onChange={(event) => setMaxReferenceImages(Math.max(0, Math.min(1, Number(event.target.value))))} /></label></div>
            <small className="generation-reuse">{reusableAssetLibrary.length > 0 ? `${reusableAssetLibrary.length} reviewed GLB asset${reusableAssetLibrary.length === 1 ? '' : 's'} will be reused before generation.` : 'No reusable reviewed GLBs yet. A fully generated reference catalog needs up to 20 assets and 5 regional images.'}</small>
            <div className="cost-preview"><span>Estimate / hard maximum</span><strong>${estimatedMaximumCost.toFixed(2)} / ${hardCostCap.toFixed(2)}</strong></div>
            <div className="blender-status"><strong>Studio refinement</strong><span>Blender 5.1 worker · {compilerHealth?.generation?.blenderWorker ?? 'not connected'}</span><small>Blender executes only fixed mesh and region jobs with RGB/depth/normal/semantic/instance passes. WorldEngine applies bounded mesh-footprint support edits. Generated Python is never evaluated.</small></div>
            {bundle.qualityCertification && <div className={`quality-score ${bundle.qualityCertification.certified ? 'certified' : 'failed'}`}><small>VISUAL WORLD PARITY V1</small><strong>{bundle.qualityCertification.weightedScore.toFixed(1)}/100</strong><span>{bundle.qualityCertification.certified ? 'CERTIFIED' : 'NOT CERTIFIED'}</span>{remoteWorld && <a href={`${compilerEndpoint()}/v1/worlds/${encodeURIComponent(remoteWorld.id)}/quality-report?format=html`} target="_blank" rel="noreferrer">Open immutable report</a>}</div>}
          </section>}
        </aside>

        <section className="viewport-panel">
          <WorldViewport tool={tool} bundle={previewBundle} mode={mode} timeOfDay={editor.time} weather={editor.weather} terrainEdits={editor.terrainEdits} regionDensities={editor.densities} onStats={setStats} onEvent={onWorldEvent} onSelectEntity={setSelectedEntity} onTerrainBrush={applyTerrainBrush} onRegionBrush={applyRegionBrush} onEngine={handleEngine} />
          <div className="viewport-header">
            <div className="camera-switch">{(['sandbox','third-person','rts'] as CameraMode[]).map((item) => <button key={item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>{item === 'third-person' ? 'Third person' : item.toUpperCase()}</button>)}</div>
            <div className="live-pill"><span /> LIVE</div>
          </div>
          <div className="viewport-stats"><span>{stats.renderer.toUpperCase()}</span><span>{stats.loadedChunks} CHUNKS</span><span>{stats.visibleEntities.toLocaleString()} VISIBLE</span><span>{stats.p95FrameMs.toFixed(1)} MS P95</span><span>{stats.maxChunkTaskMs.toFixed(1)} MS CHUNK MAX</span><span>{stats.gpuMemoryMb.toFixed(0)} MB</span><span className={stats.withinBudget ? 'budget-ok' : 'budget-warning'}>{stats.withinBudget ? 'BUDGET OK' : 'BUDGET REVIEW'}</span></div>
          <div className="compass"><span>N</span><i /><b /></div>
          <div className="view-hint">Drag orbit · Shift/right-drag pan · WASD move · Q/E height · R reset · Scroll zoom</div>
          {tool === 'terrain' && <button className="brush-action" onClick={() => applyTerrainBrush()}>Click terrain to apply +6m · center fallback</button>}
          {tool === 'region' && <button className="brush-action" onClick={() => applyRegionBrush()}>Click terrain to paint +5% · {region.name} fallback</button>}
        </section>

        <aside className="right-panel panel">
          <div className="tabs"><button className={rightTab === 'inspect' ? 'selected' : ''} onClick={() => setRightTab('inspect')}>Inspect</button><button className={rightTab === 'diagnostics' ? 'selected' : ''} onClick={() => setRightTab('diagnostics')}>Diagnostics <em>{events.length}</em></button></div>
          {rightTab === 'inspect' ? <>
            <section className="inspector-hero"><span className="region-symbol">{selectedEntity ? 'EN' : region.name.slice(0, 2).toUpperCase()}</span><div><small>{selectedEntity ? 'ENTITY' : 'REGION'}</small><h2>{selectedEntity ?? region.name}</h2><p>{selectedEntity ? 'runtime visual instance' : region.biome}</p></div></section>
            {selectedEntity && <section className="property-section entity-transform"><h3>Transform tool</h3><p>{tool === 'move' ? 'Move ±2 meters on X' : tool === 'rotate' ? 'Rotate ±15° around Y' : tool === 'scale' ? 'Scale ±10%' : 'Choose move, rotate, or scale.'}</p><div><button className="secondary-button" disabled={!['move','rotate','scale'].includes(tool)} onClick={() => applyToolTransform(-1)}>− Apply</button><button className="secondary-button" disabled={!['move','rotate','scale'].includes(tool)} onClick={() => applyToolTransform(1)}>+ Apply</button></div><button className="clear-selection" onClick={() => setSelectedEntity(undefined)}>Clear selection</button></section>}
            <section className="property-section world-spec"><h3>World specification</h3><div className="coordinate-grid"><label>Format<input value={`${design.format} ${design.version}`} readOnly /></label><label>Seed<input value={design.seed} readOnly /></label><label>Bounds<input value={`${design.bounds.max[0] - design.bounds.min[0]} × ${design.bounds.max[1] - design.bounds.min[1]} m`} readOnly /></label><label>Features<input value={design.features.length} readOnly /></label></div><small>RH · Y-up · meters · {design.defaultsApplied.length} explicit defaults · {design.constraints.length} constraints</small></section>
            <section className="property-section"><h3>Composition</h3><label>Density <span>{Math.round(density * 100)}%</span><input type="range" min="0" max="100" value={density * 100} onChange={(event) => history.apply('Region density', (current) => ({ ...current, densities: { ...current.densities, [region.id]: Number(event.target.value) / 100 }, revision: current.revision + 1 }))} /></label><div className="coordinate-grid"><label>Min elevation<input value={`${region.elevation.min} m`} readOnly /></label><label>Max elevation<input value={`${region.elevation.max} m`} readOnly /></label></div><label className="description">Intent<textarea value={region.description || 'Canonical vector region; deterministic raster mask.'} readOnly /></label><button className="secondary-button" onClick={() => setRegenerationOpen(true)}>Regenerate region…</button></section>
            <section className="property-section chunk-inspector"><h3>Chunk inspector</h3>{selectedChunk ? <><label>Loaded chunk<select aria-label="Inspected chunk" value={selectedChunk.id} onChange={(event) => setSelectedChunkId(event.target.value)}>{loadedChunkSummaries.map((chunk) => <option key={chunk.id} value={chunk.id}>{chunk.id}{chunk.placeholder ? ' · placeholder' : ''}</option>)}</select></label><div className="coordinate-grid"><label>Coordinate<input value={`${selectedChunk.coordinate.x}, ${selectedChunk.coordinate.z}`} readOnly /></label><label>Terrain<input value={`${selectedChunk.terrainSamples}² samples`} readOnly /></label><label>Elevation<input value={`${selectedChunk.minHeight.toFixed(1)}…${selectedChunk.maxHeight.toFixed(1)} m`} readOnly /></label><label>Instances<input value={selectedChunk.instances} readOnly /></label><label>Dependencies<input value={selectedChunk.dependencies} readOnly /></label><label>Occlusion cells<input value={selectedChunk.occlusionCells} readOnly /></label></div><small>{selectedChunkManifest?.source.kind ?? 'runtime'} · {selectedChunkManifest?.source.contentHash.slice(0, 12) ?? 'unmanifested'}… · {selectedChunk.placeholder ? 'sparse placeholder' : 'detailed visual chunk'}</small>{selectedChunk.placeholder && <button className="secondary-button" disabled={!remoteWorld || expandingChunkId === selectedChunk.id} title={!remoteWorld ? 'Compile a remote world before publishing expansion' : 'Explicitly materialize this chunk with no provider calls'} onClick={() => void expandSelectedChunk()}>{expandingChunkId === selectedChunk.id ? 'Generating detailed chunk…' : 'Generate detailed chunk · $0'}</button>}</> : <p>Waiting for the first streamed chunk.</p>}</section>
            <section className="property-section environment"><h3><Icon size={16}>{icons.sun}</Icon> Environment</h3><label>Time of day <span>{String(Math.floor(editor.time)).padStart(2,'0')}:{String(Math.round((editor.time % 1) * 60)).padStart(2,'0')}<input type="range" min="0" max="24" step="0.1" value={editor.time} onChange={(event) => history.apply('Time of day', (current) => ({ ...current, time: Number(event.target.value), revision: current.revision + 1 }))}/></span></label><label>Weather<select value={editor.weather} onChange={(event) => history.apply('Weather', (current) => ({ ...current, weather: event.target.value as EditorState['weather'], revision: current.revision + 1 }))}><option>clear</option><option>cloudy</option><option>rain</option><option>snow</option><option>fog</option></select></label></section>
            <section className="property-section provenance"><h3>Provenance</h3><div><span className="check">✓</span><p><strong>{bundle.provenance.every((record) => record.reviewedAt) ? 'All assets reviewed' : 'Review required'}</strong><small>{bundle.provenance.length} records · {bundle.provenance.filter((record) => record.kind === 'imported').length} imported</small></p></div><ul>{bundle.provenance.map((record) => <li key={record.id}><strong>{record.subjectId}</strong><span>{record.kind} · {record.provider ?? record.license.name}</span><small>{record.contentHash.slice(0, 12)}… · {record.reviewedAt ? 'reviewed' : 'pending'}</small></li>)}</ul></section>
            <section className="property-section snapshot-comparison"><h3>Snapshot comparison</h3><p>{lastSnapshot ? `${lastSnapshot.name} · ${snapshotChanged ? 'unsaved visual changes' : 'identical'}` : 'Capture a snapshot to compare changes.'}</p><small>{editor.terrainEdits.length} terrain edits · {Object.keys(editor.assetReplacements).length} asset replacements</small></section>
          </> : <><section className="diagnostics-list">{events.map((event, index) => <div key={`${event}-${index}`}><span className={event.includes('unavailable') || event.includes('error') || event.includes('attention') ? 'warning' : ''}>{event.includes('unavailable') || event.includes('attention') ? '!' : '✓'}</span><p>{event}<small>{index === 0 ? 'just now' : `${index + 1}m ago`}</small></p></div>)}<h3 className="jobs-heading">Job history</h3>{jobs.map((job) => <div key={job.id}><span>{job.status === 'completed' ? '✓' : '·'}</span><p>{job.kind} · {job.status}<small>{job.id.slice(0, 12)} · ${job.costUsd.toFixed(2)}</small></p></div>)}</section>{compileWorkspace && <CompileArtifactWorkspace workspace={compileWorkspace} endpoint={compilerEndpoint()} onResume={async (cap) => { try { await resumeCompile(cap); } catch (error) { setEvents((items) => [`Resume failed: ${(error as Error).message}`, ...items].slice(0, 8)); } }} />}</>}
        </aside>
      </div>

      <footer className="statusbar"><span><i className="ok" /> Bundle valid</span><span>{bundle.chunks.length} / {bundle.chunks.length} chunks</span><span>{bundle.prototypes.length} prototypes</span><span>{(authoringWorld?.entities.length ?? estimatedLocalInstanceCount).toLocaleString()} instances</span><span>REV {editor.revision}</span><span className="status-spacer" /><span>RH · Y-UP · METERS</span><span>{snapshots.length + 1} snapshots</span></footer>
      {regenerationOpen && <div className="modal-backdrop" role="presentation"><section className="cost-modal asset-import-modal" role="dialog" aria-modal="true" aria-labelledby="regenerate-title"><small>SCHEMA-VALID REGENERATION</small><h2 id="regenerate-title">Regenerate {region.name}</h2><p>Topology, stable IDs, landmarks, user assets, legal metadata, and the current revision remain protected.</p><label>Regional visual direction<textarea value={regenerationPrompt} onChange={(event) => setRegenerationPrompt(event.target.value)} /></label><dl><div><dt>Maximum cost</dt><dd>$0.00</dd></div><div><dt>Affected chunks</dt><dd>{bundle.chunks.filter((entry) => entry.bounds.max[0] >= Math.min(...region.polygon.map((point) => point[0])) && entry.bounds.min[0] <= Math.max(...region.polygon.map((point) => point[0])) && entry.bounds.max[1] >= Math.min(...region.polygon.map((point) => point[1])) && entry.bounds.min[1] <= Math.max(...region.polygon.map((point) => point[1]))).length}</dd></div></dl><div><button className="ghost-button" onClick={() => setRegenerationOpen(false)}>Cancel</button><button className="primary-button" disabled={regenerationPrompt.trim().length === 0} onClick={() => void regenerateRegion()}>Apply regeneration</button></div></section></div>}
      {pendingAsset && <div className="modal-backdrop" role="presentation"><section className="cost-modal asset-import-modal" role="dialog" aria-modal="true" aria-labelledby="asset-import-title"><small>ASSET RIGHTS GATE</small><h2 id="asset-import-title">Review imported GLB</h2><p>{pendingAsset.file.name} · {(pendingAsset.file.size / 1024).toFixed(1)} KB · SHA-256 {pendingAsset.contentHash.slice(0, 12)}…</p><label>License name<input value={assetLicenseName} required onChange={(event) => setAssetLicenseName(event.target.value)} /></label><label>License URL (optional)<input type="url" aria-invalid={!assetLicenseUrlValid} value={assetLicenseUrl} placeholder="https://…" onChange={(event) => setAssetLicenseUrl(event.target.value)} />{!assetLicenseUrlValid && <small>Enter a valid absolute URL.</small>}</label><label>Attribution (optional)<input value={assetAttribution} onChange={(event) => setAssetAttribution(event.target.value)} /></label><label className="rights-affirmation"><input type="checkbox" checked={assetRightsAffirmed} onChange={(event) => setAssetRightsAffirmed(event.target.checked)} /> I affirm that I have the right to use this asset commercially and that the metadata above is accurate.</label><div><button className="ghost-button" onClick={() => setPendingAsset(undefined)}>Cancel</button><button className="primary-button" disabled={!assetRightsAffirmed || assetLicenseName.trim().length === 0 || !assetLicenseUrlValid} onClick={confirmAssetImport}>Stage reviewed asset</button></div></section></div>}
      {confirmCompile && <div className="modal-backdrop" role="presentation"><section className="cost-modal" role="dialog" aria-modal="true" aria-labelledby="cost-title"><small>{qualityProfile === 'local' ? 'LOCAL COMPILE GATE' : `${qualityProfile.toUpperCase()} BILLABLE WORK GATE`}</small><h2 id="cost-title">Confirm compile</h2><p>{qualityProfile === 'local' ? 'This compile is deterministic and calls no provider.' : 'Only the exact reviewed server-side roles below may run. There is no model fallback, blind retry, or camera-triggered generation.'}</p><dl><div><dt>Estimated / maximum cost</dt><dd>${estimatedMaximumCost.toFixed(2)} / ${hardCostCap.toFixed(2)}</dd></div><div><dt>Asset generations</dt><dd>{qualityProfile === 'local' ? 0 : maxAssetGenerations}</dd></div><div><dt>Hero regions</dt><dd>{qualityProfile === 'local' ? 0 : heroRegionIds.length}</dd></div><div><dt>Provider models</dt><dd>{qualityProfile === 'local' ? 'None' : selectedCloudProviders.map((profile) => profile.modelId).join(', ')}</dd></div></dl><label><input type="checkbox" checked={compileLimitsConfirmed} onChange={(event) => setCompileLimitsConfirmed(event.target.checked)} /> I confirm the displayed hard limits</label><div><button className="ghost-button" onClick={() => setConfirmCompile(false)}>Cancel</button><button className="primary-button" disabled={!compileLimitsConfirmed || (qualityProfile !== 'local' && (!cloudAvailable || heroRegionIds.length === 0))} onClick={() => { setConfirmCompile(false); void estimate(true); }}>Confirm & compile</button></div></section></div>}
    </main>
  );
}
