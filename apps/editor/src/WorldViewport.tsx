import { useEffect, useRef } from 'react';
import { DefaultVisualWorldEngine, FramePerformanceMonitor, ProceduralWorldBundleSource, type CameraView, type VisualWorld, type VisualWorldEngine, type VisualWorldEvent } from '@worldengine/runtime';
import { ChunkIdSchema, PatchIdSchema, type TerrainEdit, type VisualWorldBundle } from '@worldengine/schema';
import { frameDeltaSeconds } from './frame-timing.js';

export type CameraMode = 'sandbox' | 'third-person' | 'rts';
const streamRadiusForMode = (mode: CameraMode): number => import.meta.env['VITE_E2E_MODE'] === 'true' ? 1
  : mode === 'third-person' ? 512 : mode === 'rts' ? 768 : 640;
const previewTerrainSamples = import.meta.env['VITE_E2E_MODE'] === 'true' ? 17 : 65;

export interface ViewportStats {
  renderer: string;
  loadedChunks: number;
  visibleEntities: number;
  p95FrameMs: number;
  gpuMemoryMb: number;
  maxChunkTaskMs: number;
  withinBudget: boolean;
}

interface Props {
  tool: 'select' | 'move' | 'rotate' | 'scale' | 'terrain' | 'region';
  mode: CameraMode;
  timeOfDay: number;
  weather: string;
  terrainEdits: TerrainEdit[];
  regionDensities: Record<string, number>;
  bundle: VisualWorldBundle;
  onStats(stats: ViewportStats): void;
  onEvent(event: VisualWorldEvent): void;
  onSelectEntity(id: string | undefined): void;
  onTerrainBrush(center: [number, number]): void;
  onRegionBrush(point: [number, number]): void;
  onEngine(engine: VisualWorldEngine | undefined): void;
}

export function WorldViewport({ tool, mode, timeOfDay, weather, terrainEdits, regionDensities, bundle, onStats, onEvent, onSelectEntity, onTerrainBrush, onRegionBrush, onEngine }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigationRef = useRef<HTMLOutputElement>(null);
  const modeRef = useRef(mode);
  const timeRef = useRef(timeOfDay);
  const weatherRef = useRef(weather);
  const engineRef = useRef<DefaultVisualWorldEngine | undefined>(undefined);
  const sourceRef = useRef<ProceduralWorldBundleSource | undefined>(undefined);
  const worldRef = useRef<VisualWorld | undefined>(undefined);
  const revisionRef = useRef(0);
  const homeInstance = bundle.authoredInstances.reduce<(typeof bundle.authoredInstances)[number] | undefined>((best, candidate) => {
    if (!best) return candidate;
    const bestRadius = bundle.prototypes.find((prototype) => prototype.id === best.prototypeId)?.boundsRadius ?? 0;
    const candidateRadius = bundle.prototypes.find((prototype) => prototype.id === candidate.prototypeId)?.boundsRadius ?? 0;
    return candidateRadius > bestRadius ? candidate : best;
  }, undefined);
  const homeMatrix = homeInstance?.matrix;
  const homeFocusRef = useRef<[number, number, number]>(homeMatrix ? [homeMatrix[12], homeMatrix[13], homeMatrix[14]] : [0, 0, 0]);
  const navigationStateRef = useRef<{ yaw: number; pitch: number; distance: number; focus: [number, number, number] }>({ yaw: -0.65, pitch: 0.6, distance: 620, focus: [...homeFocusRef.current] });
  const interactionRef = useRef({ tool, onSelectEntity, onTerrainBrush, onRegionBrush });
  modeRef.current = mode;
  timeRef.current = timeOfDay;
  weatherRef.current = weather;
  interactionRef.current = { tool, onSelectEntity, onTerrainBrush, onRegionBrush };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let animation = 0;
    let chunks = 0;
    let entities = 0;
    const performanceMonitor = new FramePerformanceMonitor(180);
    const navigationState = navigationStateRef.current;
    let yaw = navigationState.yaw;
    let pitch = navigationState.pitch;
    let distance = navigationState.distance;
    let dragging = false;
    let panning = false;
    let pointer = [0, 0];
    let dragDistance = 0;
    const pressed = new Set<string>();
    const focusPosition = navigationState.focus;
    const streamedPosition: [number, number] = [focusPosition[0], focusPosition[2]];
    let streamedRadius = streamRadiusForMode(modeRef.current);
    let backend: import('@worldengine/three').ThreeRendererBackend | undefined;
    let engine: DefaultVisualWorldEngine | undefined;
    const rect = canvas.getBoundingClientRect();
    let unsubscribe: () => void = () => undefined;
    const handleEvent = (event: VisualWorldEvent) => {
      if (event.type === 'chunk-loaded') chunks += 1;
      if (event.type === 'chunk-unloaded') chunks -= 1;
      if (event.type === 'entity-available') entities += 1;
      if (event.type === 'entity-disposed') entities -= 1;
      onEvent(event);
      const snapshot = performanceMonitor.snapshot();
      const resources = backend?.getResourceStats();
      onStats({ renderer: backend?.rendererName.current ?? 'starting', loadedChunks: chunks, visibleEntities: entities, p95FrameMs: snapshot.p95FrameTimeMs, gpuMemoryMb: (resources?.usedBytes ?? 0) / 1024 ** 2, maxChunkTaskMs: resources?.maxChunkTaskMs ?? 0, withinBudget: snapshot.withinReferenceBudget && !(resources?.overBudget ?? false) });
    };
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      backend?.resize(entry.contentRect.width, entry.contentRect.height);
    });
    resize.observe(canvas);

    const pointerDown = (event: PointerEvent) => {
      dragging = true;
      panning = event.shiftKey || event.button === 1 || event.button === 2;
      dragDistance = 0;
      pointer = [event.clientX, event.clientY];
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const deltaX = event.clientX - pointer[0]!;
      const deltaY = event.clientY - pointer[1]!;
      if (panning) {
        const scale = distance * 0.0014;
        focusPosition[0] += Math.sin(yaw) * deltaX * scale + Math.cos(yaw) * deltaY * scale;
        focusPosition[2] += -Math.cos(yaw) * deltaX * scale + Math.sin(yaw) * deltaY * scale;
      } else {
        yaw -= deltaX * 0.005;
        pitch = Math.max(0.12, Math.min(1.45, pitch + deltaY * 0.004));
      }
      navigationState.yaw = yaw;
      navigationState.pitch = pitch;
      dragDistance += Math.hypot(deltaX, deltaY);
      pointer = [event.clientX, event.clientY];
    };
    const pointerUp = (event: PointerEvent) => {
      dragging = false;
      if (dragDistance < 4 && backend) {
        const bounds = canvas.getBoundingClientRect();
        const canvasX = event.clientX - bounds.left;
        const canvasY = event.clientY - bounds.top;
        const interaction = interactionRef.current;
        if (interaction.tool === 'terrain' || interaction.tool === 'region') {
          const point = backend.pickTerrain(canvasX, canvasY, bounds.width, bounds.height);
          if (point && interaction.tool === 'terrain') interaction.onTerrainBrush([point[0], point[2]]);
          if (point && interaction.tool === 'region') interaction.onRegionBrush([point[0], point[2]]);
        } else {
          interaction.onSelectEntity(backend.pick(canvasX, canvasY, bounds.width, bounds.height));
        }
      }
    };
    const wheel = (event: WheelEvent) => { event.preventDefault(); distance = Math.max(80, Math.min(1800, distance * Math.exp(event.deltaY * 0.001))); navigationState.distance = distance; };
    const isTypingTarget = (target: EventTarget | null): boolean => target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || (target instanceof HTMLElement && target.isContentEditable);
    const keyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
        event.preventDefault();
        pressed.add(event.code);
      }
      if (event.code === 'KeyR') {
        event.preventDefault();
        focusPosition.splice(0, 3, ...homeFocusRef.current);
        yaw = -0.65; pitch = 0.6; distance = 620;
        navigationState.yaw = yaw; navigationState.pitch = pitch; navigationState.distance = distance;
      }
    };
    const keyUp = (event: KeyboardEvent) => { pressed.delete(event.code); };
    const releaseControls = () => { pressed.clear(); dragging = false; panning = false; };
    const contextMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', releaseControls);
    canvas.addEventListener('blur', releaseControls);
    canvas.addEventListener('pointercancel', releaseControls);
    canvas.addEventListener('contextmenu', contextMenu);

    void import('@worldengine/three').then(async ({ ThreeRendererBackend }) => {
      if (cancelled) return;
      const forceWebGL2 = new URLSearchParams(location.search).get('renderer')?.toLowerCase() === 'webgl2';
      backend = new ThreeRendererBackend({ preferWebGPU: !forceWebGL2, shadows: true, ktx2TranscoderPath: `${import.meta.env.BASE_URL}basis/` });
      engine = new DefaultVisualWorldEngine(backend, { canvas, width: Math.max(1, rect.width), height: Math.max(1, rect.height), pixelRatio: window.devicePixelRatio });
      engineRef.current = engine;
      onEngine(engine);
      unsubscribe = engine.subscribe(handleEvent);
      // The canonical bundle remains 257-sample terrain. The viewport streams the
      // highest mesh LOD the backend can display instead of generating discarded samples.
      const source = new ProceduralWorldBundleSource(bundle, Math.min(bundle.terrainSamples, previewTerrainSamples));
      source.setTerrainEdits(terrainEdits);
      source.setRegionDensities(regionDensities);
      sourceRef.current = source;
      const world = await engine.load(source);
      worldRef.current = world;
      revisionRef.current = world.revision;
      if (cancelled) return;
      engine.streamAround(focusPosition, streamedRadius);
      const started = performance.now();
      let last = started;
      let renderedTime = Number.NaN;
      let renderedWeather = '';
      let frameCount = 0;
      const frame = (now: number) => {
        const currentMode = modeRef.current;
        const deltaSeconds = frameDeltaSeconds(now, last);
        const movementSpeed = (currentMode === 'third-person' ? 48 : currentMode === 'rts' ? 260 : 125) * (pressed.has('ShiftLeft') || pressed.has('ShiftRight') ? 3 : 1) * deltaSeconds;
        const forward = (pressed.has('KeyW') ? 1 : 0) - (pressed.has('KeyS') ? 1 : 0);
        const sideways = (pressed.has('KeyD') ? 1 : 0) - (pressed.has('KeyA') ? 1 : 0);
        const vertical = (pressed.has('KeyE') ? 1 : 0) - (pressed.has('KeyQ') ? 1 : 0);
        if (forward !== 0 || sideways !== 0 || vertical !== 0) {
          focusPosition[0] += (-Math.cos(yaw) * forward - Math.sin(yaw) * sideways) * movementSpeed;
          focusPosition[2] += (-Math.sin(yaw) * forward + Math.cos(yaw) * sideways) * movementSpeed;
          focusPosition[1] = Math.max(-100, Math.min(1_000, focusPosition[1] + vertical * movementSpeed));
        }
        const focus: [number, number, number] = [focusPosition[0], focusPosition[1] + (currentMode === 'third-person' ? 8 : 0), focusPosition[2]];
        const activeDistance = currentMode === 'third-person' ? Math.min(distance, 52) : currentMode === 'rts' ? Math.max(distance, 620) : distance;
        const activePitch = currentMode === 'third-person' ? Math.min(pitch, 0.28) : currentMode === 'rts' ? Math.max(pitch, 1.05) : pitch;
        const position: [number, number, number] = [
          focus[0] + Math.cos(yaw) * Math.cos(activePitch) * activeDistance,
          focus[1] + Math.sin(activePitch) * activeDistance,
          focus[2] + Math.sin(yaw) * Math.cos(activePitch) * activeDistance,
        ];
        const view: CameraView = {
          position, target: focus, up: [0, 1, 0], projection: currentMode === 'rts' ? 'orthographic' : 'perspective',
          fov: 48, orthographicSize: activeDistance * 0.55, near: 0.5, far: 12_000, aspect: Math.max(0.1, canvas.clientWidth / Math.max(1, canvas.clientHeight)),
        };
        const desiredStreamRadius = streamRadiusForMode(currentMode);
        if (desiredStreamRadius !== streamedRadius || Math.hypot(focusPosition[0] - streamedPosition[0], focusPosition[2] - streamedPosition[1]) >= 64) {
          engine?.streamAround(focusPosition, desiredStreamRadius);
          streamedPosition[0] = focusPosition[0];
          streamedPosition[1] = focusPosition[2];
          streamedRadius = desiredStreamRadius;
        }
        if (backend && Math.abs(renderedTime - timeRef.current) > 0.01) {
          backend.setTimeOfDay(timeRef.current);
          renderedTime = timeRef.current;
        }
        if (backend && renderedWeather !== weatherRef.current) {
          backend.setWeather(weatherRef.current);
          renderedWeather = weatherRef.current;
        }
        engine?.setView(view);
        engine?.update({ deltaSeconds, elapsedSeconds: (now - started) / 1000 });
        const resources = backend?.getResourceStats();
        performanceMonitor.record({ frameTimeMs: deltaSeconds * 1000, mainThreadChunkTaskMs: resources?.maxChunkTaskMs ?? 0, visibleInstances: entities, gpuMemoryBytes: resources?.usedBytes ?? 0 });
        frameCount += 1;
        if (frameCount % 30 === 0) {
          const snapshot = performanceMonitor.snapshot();
          onStats({ renderer: backend?.rendererName.current ?? 'starting', loadedChunks: chunks, visibleEntities: entities, p95FrameMs: snapshot.p95FrameTimeMs, gpuMemoryMb: (resources?.usedBytes ?? 0) / 1024 ** 2, maxChunkTaskMs: resources?.maxChunkTaskMs ?? 0, withinBudget: snapshot.withinReferenceBudget && !(resources?.overBudget ?? false) });
        }
        if (frameCount % 10 === 0 && navigationRef.current) navigationRef.current.textContent = `X ${focusPosition[0].toFixed(0)}  Y ${focusPosition[1].toFixed(0)}  Z ${focusPosition[2].toFixed(0)}`;
        last = now;
        animation = requestAnimationFrame(frame);
      };
      animation = requestAnimationFrame(frame);
    }).catch((error: unknown) => onEvent({ type: 'chunk-error', chunkId: ChunkIdSchema.parse('0:0'), error: error instanceof Error ? error : new Error(String(error)) }));

    return () => {
      cancelled = true;
      cancelAnimationFrame(animation);
      resize.disconnect();
      unsubscribe();
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', releaseControls);
      canvas.removeEventListener('blur', releaseControls);
      canvas.removeEventListener('pointercancel', releaseControls);
      canvas.removeEventListener('contextmenu', contextMenu);
      void engine?.dispose();
      engineRef.current = undefined;
      sourceRef.current = undefined;
      worldRef.current = undefined;
      onEngine(undefined);
    };
  }, [bundle]);

  useEffect(() => {
    const source = sourceRef.current;
    const engine = engineRef.current;
    const world = worldRef.current;
    if (!source || !engine || !world) return;
    source.setTerrainEdits(terrainEdits);
    source.setRegionDensities(regionDensities);
    const loaded = [...world.loadedChunkIds];
    if (loaded.length === 0) return;
    void engine.applyPatch({
      id: PatchIdSchema.parse(`terrain-${crypto.randomUUID()}`), worldId: world.manifest.worldId, baseRevision: revisionRef.current,
      createdAt: new Date().toISOString(), author: 'editor', operations: loaded.map((id) => ({ op: 'invalidate-chunk' as const, chunkId: id })),
    }).then(() => { revisionRef.current += 1; }).catch((error: unknown) => onEvent({ type: 'chunk-error', chunkId: ChunkIdSchema.parse('0:0'), error: error instanceof Error ? error : new Error(String(error)) }));
  }, [terrainEdits, regionDensities]);

  return <><canvas ref={canvasRef} className="world-canvas" aria-label="3D world viewport" tabIndex={0} /><output ref={navigationRef} className="navigation-readout" aria-label="Camera focus coordinates">X 0  Y 0  Z 0</output></>;
}
