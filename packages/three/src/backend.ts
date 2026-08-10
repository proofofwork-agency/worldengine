import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { ChunkId, EntityId, PrototypeId, VisualStatePatch, VisualWorldBundle, WorldPatch } from '@worldengine/schema';
import { ResourceBudget, type CameraView, type RendererBackend, type RenderTarget, type RuntimeChunk, type VisualFrame } from '@worldengine/runtime';
import { createPrimitiveVisual, type PrimitiveVisual } from './primitives.js';
import { buildTerrainLodIndexPlan, selectDistanceLod } from './lod.js';

interface RendererLike {
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
  shadowMap: { enabled: boolean; type: number };
  outputColorSpace: string;
  toneMapping: number;
  toneMappingExposure: number;
}

interface EntityBinding {
  meshes: THREE.InstancedMesh[];
  objects: THREE.Object3D[];
  mixers: THREE.AnimationMixer[];
  clips: THREE.AnimationClip[];
  activeClip?: string;
  index: number;
  prototypeId: PrototypeId;
  originalMatrix: THREE.Matrix4;
  color: THREE.Color;
  state: VisualStatePatch;
}

interface PrototypeLodSet { variants: THREE.InstancedMesh[][]; distances: number[] }
interface TerrainLodState { mesh: THREE.Mesh; levels: Array<{ distance: number; start: number; count: number }>; selected: number }
interface AnimatedAsset { scene: THREE.Group; clips: THREE.AnimationClip[] }
interface StaticVisual { parts: PrimitiveVisual[] }

const fallbackBiomeColors: Record<string, number> = {
  coastal: 0x718c83, wetland: 0x5f8061, forest: 0x456544, grassland: 0x82965f, highland: 0x777c70,
  desert: 0xb69a62, dune: 0xc6aa72, oasis: 0x5d8b66, volcanic: 0x584b47, ash: 0x6d665e, frozen: 0x9baeb0, tundra: 0x778b83,
};

function biomeColor(biome: string, paletteColor?: string): THREE.Color {
  if (paletteColor && (/^#[a-f\d]{6}$/i.test(paletteColor) || /^#[a-f\d]{3}$/i.test(paletteColor))) return new THREE.Color(paletteColor);
  const entry = Object.entries(fallbackBiomeColors).find(([key]) => biome.toLowerCase().includes(key));
  return new THREE.Color(entry?.[1] ?? 0x6f8b55);
}

function distanceToSegment(x: number, z: number, start: [number, number], end: [number, number]): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared));
  return Math.hypot(x - (start[0] + dx * t), z - (start[1] + dz * t));
}

export interface ThreeRendererBackendOptions {
  preferWebGPU?: boolean;
  shadows?: boolean;
  terrainColor?: number;
  clearColor?: number;
  gpuMemoryBudgetBytes?: number;
  ktx2TranscoderPath?: string;
}

export class ThreeRendererBackend implements RendererBackend {
  readonly rendererName = { current: 'uninitialized' as 'uninitialized' | 'webgpu' | 'webgl2' };
  private readonly scene = new THREE.Scene();
  private readonly worldRoot = new THREE.Group();
  private renderer: RendererLike | undefined;
  private target?: RenderTarget;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = new THREE.PerspectiveCamera();
  private readonly chunkGroups = new Map<ChunkId, THREE.Group>();
  private readonly chunkPrototypeLods = new Map<ChunkId, PrototypeLodSet[]>();
  private readonly terrainLods = new Map<ChunkId, TerrainLodState>();
  private readonly entities = new Map<EntityId, EntityBinding>();
  private readonly prototypes = new Map<PrototypeId, VisualWorldBundle['prototypes'][number]>();
  private readonly visuals = new Map<string, Promise<StaticVisual>>();
  private readonly visualBytes = new Map<string, number>();
  private readonly visualReferences = new Map<string, number>();
  private readonly chunkVisualKeys = new Map<ChunkId, string[]>();
  private readonly loader = new GLTFLoader();
  private readonly gltfAssets = new Map<string, Promise<GLTF>>();
  private readonly ktx2Loader = new KTX2Loader();
  private terrainLodSamples = [65, 33, 17];
  private sun?: THREE.DirectionalLight;
  private moon?: THREE.DirectionalLight;
  private sky: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | undefined;
  private water: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial> | undefined;
  private waterNormal: THREE.DataTexture | undefined;
  private terrainDetail: THREE.DataTexture | undefined;
  private terrainNormal: THREE.DataTexture | undefined;
  private terrainRegionColors: THREE.Color[] = [];
  private terrainFeatures: VisualWorldBundle['features'] = [];
  private weather: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | undefined;
  private weatherKind: string = 'clear';
  private currentTimeOfDay = 12;
  private currentBundle: VisualWorldBundle | undefined;
  private baseBackground = new THREE.Color(0x9cb8c5);
  private baseFogDensity = 0;
  private frameIndex = 0;
  private maxChunkTaskMs = 0;
  private readonly resources: ResourceBudget;

  constructor(private readonly options: ThreeRendererBackendOptions = {}) {
    this.scene.add(this.worldRoot);
    this.resources = new ResourceBudget(options.gpuMemoryBudgetBytes ?? 1.5 * 1024 ** 3);
  }

  async initialize(target: RenderTarget): Promise<void> {
    this.target = target;
    if (!(target.canvas instanceof HTMLCanvasElement)) throw new Error('ThreeRendererBackend currently requires an HTMLCanvasElement');
    if (this.options.preferWebGPU !== false && 'gpu' in navigator) {
      try {
        const module = await import('three/webgpu');
        const renderer = new module.WebGPURenderer({ canvas: target.canvas, antialias: true });
        await renderer.init();
        this.renderer = renderer as unknown as RendererLike;
        this.rendererName.current = 'webgpu';
      } catch {
        this.renderer = this.createWebGLRenderer(target.canvas);
      }
    } else {
      this.renderer = this.createWebGLRenderer(target.canvas);
    }
    // A 1.5× ceiling keeps a 1080p-class render target crisp on HiDPI displays
    // without silently quadrupling fragment and shadow work at devicePixelRatio 2.
    this.renderer.setPixelRatio(Math.min(target.pixelRatio ?? window.devicePixelRatio, 1.5));
    this.renderer.setSize(target.width, target.height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.16;
    this.renderer.shadowMap.enabled = this.options.shadows ?? true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (this.options.ktx2TranscoderPath) {
      this.ktx2Loader.setTranscoderPath(this.options.ktx2TranscoderPath).setWorkerLimit(2);
      this.ktx2Loader.detectSupport(this.renderer as unknown as THREE.WebGLRenderer);
      this.loader.setKTX2Loader(this.ktx2Loader);
    }
  }

  async setWorld(bundle: VisualWorldBundle): Promise<void> {
    if (bundle.prototypes.some((prototype) => prototype.textureFormat === 'ktx2') && !this.options.ktx2TranscoderPath) {
      throw new Error('This bundle contains KTX2 textures; configure ThreeRendererBackendOptions.ktx2TranscoderPath with matching Basis transcoder assets');
    }
    for (const id of [...this.chunkGroups.keys()]) this.unloadChunk(id);
    this.currentBundle = bundle;
    this.prototypes.clear();
    bundle.prototypes.forEach((prototype) => this.prototypes.set(prototype.id, prototype));
    this.terrainLodSamples = [...bundle.optimization.terrainLodSamples].sort((a, b) => b - a);
    this.baseBackground = new THREE.Color(this.options.clearColor ?? 0x9cb8c5);
    this.baseFogDensity = bundle.environment.fogDensity;
    this.terrainRegionColors = bundle.regions.map((region, index) => biomeColor(region.biome, bundle.style.palette[index % Math.max(1, bundle.style.palette.length)]));
    this.terrainFeatures = bundle.features;
    this.scene.background = this.baseBackground.clone();
    this.scene.fog = new THREE.FogExp2(0xa9bdc2, this.baseFogDensity);
    this.scene.environment = null;
    this.installTerrainSurfaceTextures();
    this.currentTimeOfDay = bundle.environment.timeOfDay;
    this.installLights(this.currentTimeOfDay);
    this.installWeather(bundle.environment.weather);
    this.installSky(this.currentTimeOfDay);
    this.installWater(bundle, bundle.environment.waterLevel);
  }

  private installWater(bundle: VisualWorldBundle, waterLevel: number | null): void {
    if (this.water) {
      this.water.geometry.dispose();
      this.water.material.dispose();
      this.water.removeFromParent();
      this.water = undefined;
      this.waterNormal?.dispose();
      this.waterNormal = undefined;
      this.resources.remove('water');
    }
    if (waterLevel !== null) {
      const waterTextureSize = 128;
      const normalData = new Uint8Array(waterTextureSize * waterTextureSize * 4);
      const waterHeight = (x: number, z: number): number => {
        const u = x / waterTextureSize * Math.PI * 2;
        const v = z / waterTextureSize * Math.PI * 2;
        return Math.sin(u * 2 + v) * 0.36 + Math.sin(u * 5 - v * 3) * 0.17 + Math.cos(u * 9 + v * 7) * 0.07;
      };
      for (let z = 0; z < waterTextureSize; z += 1) for (let x = 0; x < waterTextureSize; x += 1) {
        const offset = (z * waterTextureSize + x) * 4;
        const dx = waterHeight(x + 1, z) - waterHeight(x - 1, z);
        const dz = waterHeight(x, z + 1) - waterHeight(x, z - 1);
        const normal = new THREE.Vector3(-dx * 1.8, -dz * 1.8, 1).normalize();
        normalData[offset] = Math.round((normal.x * 0.5 + 0.5) * 255);
        normalData[offset + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
        normalData[offset + 2] = Math.round((normal.z * 0.5 + 0.5) * 255);
        normalData[offset + 3] = 255;
      }
      this.waterNormal = new THREE.DataTexture(normalData, waterTextureSize, waterTextureSize, THREE.RGBAFormat);
      this.waterNormal.colorSpace = THREE.NoColorSpace;
      this.waterNormal.wrapS = THREE.RepeatWrapping; this.waterNormal.wrapT = THREE.RepeatWrapping;
      this.waterNormal.repeat.set(36, 36);
      this.waterNormal.magFilter = THREE.LinearFilter;
      this.waterNormal.minFilter = THREE.LinearMipmapLinearFilter;
      this.waterNormal.generateMipmaps = true;
      this.waterNormal.anisotropy = 4;
      this.waterNormal.needsUpdate = true;
      this.water = new THREE.Mesh(
        new THREE.PlaneGeometry(bundle.bounds.max[0] - bundle.bounds.min[0] + 4096, bundle.bounds.max[1] - bundle.bounds.min[1] + 4096),
        new THREE.MeshPhysicalMaterial({ color: 0x397f96, roughness: 0.4, metalness: 0.02, clearcoat: 0.28, clearcoatRoughness: 0.36, transmission: 0.03, transparent: true, opacity: 0.84, normalMap: this.waterNormal, normalScale: new THREE.Vector2(0.02, 0.02) }),
      );
      this.water.name = 'worldengine-water';
      this.water.rotation.x = -Math.PI / 2;
      this.water.position.y = waterLevel;
      this.water.receiveShadow = true;
      this.worldRoot.add(this.water);
      const positionBytes = Object.values(this.water.geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
      this.resources.touch('water', 'geometry', positionBytes + (this.water.geometry.index?.array.byteLength ?? 0) + normalData.byteLength, this.frameIndex, true);
    }
  }

  async loadChunk(chunk: RuntimeChunk): Promise<void> {
    if (this.chunkGroups.has(chunk.id)) this.unloadChunk(chunk.id);
    const group = new THREE.Group();
    group.name = `chunk:${chunk.id}`;
    group.userData['worldCenter'] = [(chunk.bounds.min[0] + chunk.bounds.max[0]) / 2, (chunk.bounds.min[1] + chunk.bounds.max[1]) / 2];
    group.add(await this.createTerrain(chunk));
    const chunkLods: PrototypeLodSet[] = [];
    const chunkVisualKeys: string[] = [];
    const pendingEntities: Array<[EntityId, EntityBinding]> = [];
    const cellByEntity = new Map<EntityId, string>();
    for (const cell of chunk.occlusionCells) for (const entityId of cell.instanceIds) cellByEntity.set(entityId, cell.id);
    const instanceGroups = new Map<string, { prototypeId: PrototypeId; instances: typeof chunk.instances }>();
    for (const instance of chunk.instances) {
      const key = `${instance.prototypeId}::${cellByEntity.get(instance.id) ?? 'uncelled'}`;
      const entry = instanceGroups.get(key) ?? { prototypeId: instance.prototypeId, instances: [] };
      entry.instances.push(instance);
      instanceGroups.set(key, entry);
    }
    const loads = await Promise.allSettled([...instanceGroups.values()].map(async ({ prototypeId, instances }) => {
      const prototype = this.prototypes.get(prototypeId);
      if (!prototype) throw new Error(`Unknown prototype ${prototypeId}`);
      const animated = !prototype.assetUri.startsWith('primitive://') && prototype.animationClips.length > 0 ? await this.loadAnimatedAsset(prototype.assetUri, prototype.contentHash) : undefined;
      if (animated) {
        let taskStarted = performance.now();
        for (let index = 0; index < instances.length; index += 1) {
          const instance = instances[index]!;
          const object = cloneSkeleton(animated.scene);
          object.name = `animated:${prototypeId}:${instance.id}`;
          object.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            const cloned = materials.map((material) => material.clone());
            child.material = Array.isArray(child.material) ? cloned : cloned[0]!;
            child.userData['worldengineOwnedMaterial'] = true;
            child.castShadow = this.options.shadows ?? true;
            child.receiveShadow = true;
          });
          const mixer = new THREE.AnimationMixer(object);
          const matrix = new THREE.Matrix4().fromArray(instance.matrix);
          const binding: EntityBinding = { meshes: [], objects: [object], mixers: [mixer], clips: animated.clips, index, prototypeId, originalMatrix: matrix, color: new THREE.Color(0xffffff), state: { ...instance.visualState } };
          pendingEntities.push([instance.id, binding]);
          group.add(object);
          this.applyEntityAppearance(binding);
          if ((index + 1) % 512 === 0 && index + 1 < instances.length) {
            this.recordChunkTask(taskStarted);
            await this.yieldChunkTask();
            taskStarted = performance.now();
          }
        }
        this.recordChunkTask(taskStarted);
        return;
      }
      const variants = [{ distance: 0, assetUri: prototype.assetUri, contentHash: prototype.contentHash }, ...prototype.lods].sort((a, b) => a.distance - b.distance);
      for (const variant of variants) {
        const key = this.visualKey(prototypeId, variant.assetUri, variant.contentHash);
        chunkVisualKeys.push(key);
      }
      const loaded = await Promise.all(variants.map((variant) => this.loadVisual(prototypeId, variant.assetUri, variant.contentHash)));
      let taskStarted = performance.now();
      const baseParts = loaded[0]!.parts;
      const meshVariants = loaded.map((visual, variantIndex) => visual.parts.map((part, partIndex) => {
        const inherited = variantIndex === 0 ? part.material : (baseParts[partIndex]?.material ?? baseParts[0]!.material);
        const material = this.cloneMaterials(inherited);
        for (const candidate of this.materialsOf(material)) if ('vertexColors' in candidate) candidate.vertexColors = part.geometry.hasAttribute('color');
        const mesh = new THREE.InstancedMesh(part.geometry, material, instances.length);
        mesh.userData['worldengineOwnedMaterial'] = true;
        mesh.name = `instances:${prototypeId}:lod:${variantIndex}:part:${partIndex}`;
        mesh.castShadow = this.options.shadows ?? true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        mesh.visible = variantIndex === 0;
        group.add(mesh);
        return mesh;
      }));
      const meshes = meshVariants.flat();
      for (let index = 0; index < instances.length; index += 1) {
        const instance = instances[index]!;
        const matrix = new THREE.Matrix4().fromArray(instance.matrix);
        const color = new THREE.Color(0xffffff);
        const binding: EntityBinding = { meshes, objects: [], mixers: [], clips: [], index, prototypeId, originalMatrix: matrix.clone(), color, state: { ...instance.visualState } };
        pendingEntities.push([instance.id, binding]);
        this.applyEntityAppearance(binding);
        if ((index + 1) % 512 === 0 && index + 1 < instances.length) {
          this.recordChunkTask(taskStarted);
          await this.yieldChunkTask();
          taskStarted = performance.now();
        }
      }
      for (const mesh of meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
      chunkLods.push({ variants: meshVariants, distances: variants.map((variant) => variant.distance) });
      this.recordChunkTask(taskStarted);
    }));
    const failed = loads.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) {
      pendingEntities.forEach(([, binding]) => binding.mixers.forEach((mixer) => mixer.stopAllAction()));
      this.disposeDetachedChunk(group, chunk.id);
      this.evictUnusedVisuals();
      throw failed.reason;
    }
    for (const [id, binding] of pendingEntities) this.entities.set(id, binding);
    this.chunkGroups.set(chunk.id, group);
    this.chunkPrototypeLods.set(chunk.id, chunkLods);
    const instanceMeshes = new Set(pendingEntities.flatMap(([, binding]) => binding.meshes));
    const instanceBytes = [...instanceMeshes].reduce((sum, mesh) => sum + mesh.instanceMatrix.array.byteLength + (mesh.instanceColor?.array.byteLength ?? 0), 0)
      + pendingEntities.reduce((sum, [, binding]) => sum + binding.objects.length * 1_024, 0);
    this.resources.touch(`chunk:${chunk.id}:instances`, 'geometry', instanceBytes, this.frameIndex, true);
    for (const key of chunkVisualKeys) {
      const references = (this.visualReferences.get(key) ?? 0) + 1;
      this.visualReferences.set(key, references);
      const bytes = this.visualBytes.get(key);
      if (bytes !== undefined) this.resources.touch(`prototype:${key}`, 'other', bytes, this.frameIndex, true);
    }
    this.chunkVisualKeys.set(chunk.id, chunkVisualKeys);
    this.worldRoot.add(group);
  }

  unloadChunk(chunkId: ChunkId): void {
    const group = this.chunkGroups.get(chunkId);
    if (!group) return;
    for (const [id, binding] of this.entities) if (binding.objects.some((object) => group.getObjectById(object.id) !== undefined)) {
      binding.mixers.forEach((mixer) => mixer.stopAllAction());
      this.entities.delete(id);
    }
    group.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) {
        for (const [id, binding] of this.entities) if (binding.meshes.includes(object)) this.entities.delete(id);
      }
      if (object instanceof THREE.Mesh && object.userData['worldengineOwnedGeometry'] === true) object.geometry.dispose();
      if (object instanceof THREE.Mesh && object.userData['worldengineOwnedMaterial'] === true) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
    group.removeFromParent();
    this.chunkGroups.delete(chunkId);
    this.chunkPrototypeLods.delete(chunkId);
    this.terrainLods.delete(chunkId);
    for (const key of this.chunkVisualKeys.get(chunkId) ?? []) {
      const references = Math.max(0, (this.visualReferences.get(key) ?? 1) - 1);
      this.visualReferences.set(key, references);
      const bytes = this.visualBytes.get(key);
      if (bytes !== undefined) this.resources.touch(`prototype:${key}`, 'other', bytes, this.frameIndex, references > 0);
    }
    this.chunkVisualKeys.delete(chunkId);
    this.resources.remove(`chunk:${chunkId}:terrain`);
    this.resources.remove(`chunk:${chunkId}:instances`);
    this.evictUnusedVisuals();
  }

  async applyVisualPatch(patch: WorldPatch): Promise<void> {
    for (const operation of patch.operations) {
      if (operation.op === 'set-transform') {
        const binding = this.entities.get(operation.entityId);
        if (!binding) continue;
        const transform = operation.transform;
        const matrix = new THREE.Matrix4().compose(
          new THREE.Vector3(...transform.position),
          new THREE.Quaternion(...transform.rotation),
          new THREE.Vector3(...transform.scale),
        );
        binding.originalMatrix.copy(matrix);
        this.applyEntityAppearance(binding);
      }
      if (operation.op === 'set-visual-state') {
        const binding = this.entities.get(operation.entityId);
        if (!binding) continue;
        binding.state = { ...binding.state, ...operation.state };
        this.applyEntityAppearance(binding);
      }
      if (operation.op === 'set-environment') {
        if (typeof operation.values['timeOfDay'] === 'number') this.setTimeOfDay(operation.values['timeOfDay']);
        if (typeof operation.values['weather'] === 'string') this.setWeather(operation.values['weather']);
        if (typeof operation.values['fogDensity'] === 'number' && operation.values['fogDensity'] >= 0) {
          this.baseFogDensity = operation.values['fogDensity'];
          if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = this.weatherKind === 'fog' ? Math.max(this.baseFogDensity, 0.0025) : this.baseFogDensity;
        }
        const waterLevel = operation.values['waterLevel'];
        if ((typeof waterLevel === 'number' || waterLevel === null) && this.currentBundle) this.installWater(this.currentBundle, waterLevel);
      }
    }
  }

  render(frame: VisualFrame): void {
    if (!this.renderer || !this.target) return;
    this.worldRoot.position.set(-frame.origin[0], -frame.origin[1], -frame.origin[2]);
    this.configureCamera(frame.view, frame.origin);
    if (this.sky) this.sky.position.copy(this.camera.position);
    this.updateDistanceLods(frame.view);
    this.updateAnimations(frame);
    this.updateWeather(frame);
    if (this.waterNormal) {
      this.waterNormal.offset.x = (frame.elapsedSeconds * 0.006) % 1;
      this.waterNormal.offset.y = (frame.elapsedSeconds * -0.0035) % 1;
    }
    this.frameIndex += 1;
    this.renderer.render(this.scene, this.camera);
  }

  async dispose(): Promise<void> {
    for (const id of [...this.chunkGroups.keys()]) this.unloadChunk(id);
    const visuals = await Promise.allSettled(this.visuals.values());
    for (const result of visuals) if (result.status === 'fulfilled') this.disposeVisual(result.value);
    this.visuals.clear();
    const assets = await Promise.allSettled(this.gltfAssets.values());
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    for (const result of assets) {
      if (result.status === 'rejected') continue;
      const gltf = result.value;
      gltf.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of objectMaterials) {
          materials.add(material);
          const record = material as THREE.Material & Record<string, unknown>;
          for (const value of Object.values(record)) if (value instanceof THREE.Texture) textures.add(value);
        }
      });
    }
    geometries.forEach((geometry) => geometry.dispose());
    textures.forEach((texture) => texture.dispose());
    materials.forEach((material) => material.dispose());
    this.gltfAssets.clear();
    this.ktx2Loader.dispose();
    this.disposeWeather();
    if (this.water) {
      this.water.geometry.dispose();
      this.water.material.dispose();
      this.water.removeFromParent();
      this.water = undefined;
      this.waterNormal?.dispose();
      this.waterNormal = undefined;
      this.resources.remove('water');
    }
    if (this.sky) {
      this.sky.geometry.dispose();
      this.sky.material.dispose();
      this.sky.removeFromParent();
      this.sky = undefined;
      this.resources.remove('sky');
    }
    this.renderer?.dispose();
    this.renderer = undefined;
    this.currentBundle = undefined;
    this.terrainDetail?.dispose();
    this.terrainNormal?.dispose();
    this.terrainDetail = undefined;
    this.terrainNormal = undefined;
    this.resources.remove('terrain-surface-textures');
  }

  resize(width: number, height: number, pixelRatio = window.devicePixelRatio): void {
    if (!this.renderer || !this.target) return;
    this.target.width = width;
    this.target.height = height;
    this.renderer.setPixelRatio(Math.min(pixelRatio, 1.5));
    this.renderer.setSize(width, height, false);
  }

  setTimeOfDay(timeOfDay: number): void {
    const time = Math.max(0, Math.min(24, timeOfDay));
    this.currentTimeOfDay = time;
    this.installLights(time);
    this.installSky(time);
  }

  setWeather(weather: string): void {
    if (weather !== this.weatherKind) {
      this.installWeather(weather);
      this.installSky(this.currentTimeOfDay);
    }
  }

  getResourceStats(): { usedBytes: number; budgetBytes: number; overBudget: boolean; maxChunkTaskMs: number } {
    return { usedBytes: this.resources.usedBytes, budgetBytes: this.resources.maxBytes, overBudget: this.resources.usedBytes > this.resources.maxBytes, maxChunkTaskMs: this.maxChunkTaskMs };
  }

  pick(canvasX: number, canvasY: number, width: number, height: number): EntityId | undefined {
    if (width <= 0 || height <= 0) return undefined;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2((canvasX / width) * 2 - 1, 1 - (canvasY / height) * 2), this.camera);
    const intersections = raycaster.intersectObjects([...this.chunkGroups.values()], true);
    for (const intersection of intersections) {
      if (intersection.object instanceof THREE.InstancedMesh && intersection.instanceId !== undefined) {
        for (const [id, binding] of this.entities) if (binding.meshes.includes(intersection.object) && binding.index === intersection.instanceId) return id;
      } else {
        for (const [id, binding] of this.entities) {
          let current: THREE.Object3D | null = intersection.object;
          while (current) {
            if (binding.objects.includes(current)) return id;
            current = current.parent;
          }
        }
      }
    }
    return undefined;
  }

  pickTerrain(canvasX: number, canvasY: number, width: number, height: number): [number, number, number] | undefined {
    if (width <= 0 || height <= 0 || this.terrainLods.size === 0) return undefined;
    this.worldRoot.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2((canvasX / width) * 2 - 1, 1 - (canvasY / height) * 2), this.camera);
    const intersection = raycaster.intersectObjects([...this.terrainLods.values()].map((terrain) => terrain.mesh), false)[0];
    if (!intersection) return undefined;
    const worldPoint = this.worldRoot.worldToLocal(intersection.point.clone());
    return [worldPoint.x, worldPoint.y, worldPoint.z];
  }

  private createWebGLRenderer(canvas: HTMLCanvasElement): RendererLike {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.rendererName.current = 'webgl2';
    return renderer;
  }

  private installTerrainSurfaceTextures(): void {
    if (this.terrainDetail && this.terrainNormal) return;
    const size = 128;
    const heights = new Float32Array(size * size);
    for (let z = 0; z < size; z += 1) for (let x = 0; x < size; x += 1) {
      const u = x / size * Math.PI * 2;
      const v = z / size * Math.PI * 2;
      heights[z * size + x] = Math.sin(u * 3 + Math.cos(v * 2)) * 0.42 + Math.sin(v * 5 - u) * 0.25 + Math.sin((u + v) * 11) * 0.11;
    }
    const detail = new Uint8Array(size * size * 4);
    const normals = new Uint8Array(size * size * 4);
    for (let z = 0; z < size; z += 1) for (let x = 0; x < size; x += 1) {
      const index = z * size + x;
      const offset = index * 4;
      const left = heights[z * size + (x + size - 1) % size]!;
      const right = heights[z * size + (x + 1) % size]!;
      const top = heights[((z + size - 1) % size) * size + x]!;
      const bottom = heights[((z + 1) % size) * size + x]!;
      const shade = Math.round(240 + heights[index]! * 8);
      const grain = ((x * 73 + z * 151 + x * z * 17) % 29) === 0 ? -6 : 0;
      detail[offset] = Math.max(0, shade + grain);
      detail[offset + 1] = Math.max(0, shade + grain);
      detail[offset + 2] = Math.max(0, shade + grain);
      detail[offset + 3] = 255;
      // Tangent-space normal maps encode the unperturbed surface normal on Z.
      // Encoding elevation on Y turns the entire terrain normal sideways and
      // creates severe grazing-angle specular/moiré artifacts in both renderers.
      const normal = new THREE.Vector3((left - right) * 0.6, (top - bottom) * 0.6, 2).normalize();
      normals[offset] = Math.round((normal.x * 0.5 + 0.5) * 255);
      normals[offset + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
      normals[offset + 2] = Math.round((normal.z * 0.5 + 0.5) * 255);
      normals[offset + 3] = 255;
    }
    this.terrainDetail = new THREE.DataTexture(detail, size, size, THREE.RGBAFormat);
    this.terrainDetail.colorSpace = THREE.SRGBColorSpace;
    this.terrainDetail.wrapS = THREE.RepeatWrapping;
    this.terrainDetail.wrapT = THREE.RepeatWrapping;
    this.terrainDetail.repeat.set(8, 8);
    this.terrainDetail.magFilter = THREE.LinearFilter;
    this.terrainDetail.minFilter = THREE.LinearMipmapLinearFilter;
    this.terrainDetail.generateMipmaps = true;
    this.terrainDetail.anisotropy = 4;
    this.terrainDetail.needsUpdate = true;
    this.terrainNormal = new THREE.DataTexture(normals, size, size, THREE.RGBAFormat);
    this.terrainNormal.colorSpace = THREE.NoColorSpace;
    this.terrainNormal.wrapS = THREE.RepeatWrapping;
    this.terrainNormal.wrapT = THREE.RepeatWrapping;
    this.terrainNormal.repeat.set(8, 8);
    this.terrainNormal.magFilter = THREE.LinearFilter;
    this.terrainNormal.minFilter = THREE.LinearMipmapLinearFilter;
    this.terrainNormal.generateMipmaps = true;
    this.terrainNormal.anisotropy = 4;
    this.terrainNormal.needsUpdate = true;
    this.resources.touch('terrain-surface-textures', 'texture', detail.byteLength + normals.byteLength, this.frameIndex, true);
  }

  private async createTerrain(chunk: RuntimeChunk): Promise<THREE.Group> {
    let taskStarted = performance.now();
    const sourceSamples = chunk.terrain.samples;
    const renderSamples = this.terrainLodSamples.find((candidate) => candidate <= sourceSamples && (sourceSamples - 1) % (candidate - 1) === 0) ?? sourceSamples;
    const sourceStep = (sourceSamples - 1) / (renderSamples - 1);
    const heights = new Float32Array(renderSamples * renderSamples);
    for (let z = 0; z < renderSamples; z += 1) for (let x = 0; x < renderSamples; x += 1) heights[z * renderSamples + x] = chunk.terrain.heights[(z * sourceStep) * sourceSamples + x * sourceStep]!;
    this.recordChunkTask(taskStarted);
    await this.yieldChunkTask();
    taskStarted = performance.now();
    const size = chunk.bounds.max[0] - chunk.bounds.min[0];
    const geometry = new THREE.PlaneGeometry(size, size, renderSamples - 1, renderSamples - 1);
    const positions = geometry.attributes['position'];
    if (!positions) throw new Error('Terrain geometry has no position buffer');
    for (let index = 0; index < heights.length; index += 1) positions.setZ(index, heights[index]!);
    positions.needsUpdate = true;
    const colors = new Float32Array(renderSamples * renderSamples * 3);
    const range = Math.max(1, chunk.terrain.maxHeight - chunk.terrain.minHeight);
    const fallbackColor = new THREE.Color(this.options.terrainColor ?? 0x6f8b55);
    const featureColors = { river: new THREE.Color(0x477f91), road: new THREE.Color(0x8b7655), coastline: new THREE.Color(0xb9a87a) };
    const steepTerrainColor = new THREE.Color(0x6c706b);
    const sampleSpacing = size / (renderSamples - 1);
    for (let sampleZ = 0; sampleZ < renderSamples; sampleZ += 1) {
      for (let sampleX = 0; sampleX < renderSamples; sampleX += 1) {
        const index = sampleZ * renderSamples + sampleX;
        const sourceIndex = (sampleZ * sourceStep) * sourceSamples + sampleX * sourceStep;
        const regionIndex = chunk.terrain.biomeWeights?.[sourceIndex] ?? 255;
        const base = (this.terrainRegionColors[regionIndex] ?? fallbackColor).clone();
        const heightFactor = (heights[index]! - chunk.terrain.minHeight) / range;
        const left = heights[sampleZ * renderSamples + Math.max(0, sampleX - 1)]!;
        const right = heights[sampleZ * renderSamples + Math.min(renderSamples - 1, sampleX + 1)]!;
        const top = heights[Math.max(0, sampleZ - 1) * renderSamples + sampleX]!;
        const bottom = heights[Math.min(renderSamples - 1, sampleZ + 1) * renderSamples + sampleX]!;
        const slope = Math.hypot((right - left) / (sampleSpacing * 2), (bottom - top) / (sampleSpacing * 2));
        const microVariation = 0.96 + Math.sin((sampleX * 17.17 + sampleZ * 31.73 + chunk.coordinate.x * 11 + chunk.coordinate.z * 19)) * 0.035;
        base.multiplyScalar((0.9 + heightFactor * 0.23) * microVariation);
        if (slope > 0.42) base.lerp(steepTerrainColor, Math.min(0.72, (slope - 0.42) * 0.8));
        const worldX = chunk.bounds.min[0] + (sampleX / (renderSamples - 1)) * size;
        const worldZ = chunk.bounds.min[1] + (sampleZ / (renderSamples - 1)) * size;
        for (const feature of this.terrainFeatures) {
          let distance = Number.POSITIVE_INFINITY;
          for (let pointIndex = 1; pointIndex < feature.points.length; pointIndex += 1) distance = Math.min(distance, distanceToSegment(worldX, worldZ, feature.points[pointIndex - 1]!, feature.points[pointIndex]!));
          if (distance >= feature.width) continue;
          const influence = (1 - distance / feature.width) ** 2;
          base.lerp(featureColors[feature.kind], Math.min(0.86, influence));
        }
        colors[index * 3] = base.r;
        colors[index * 3 + 1] = base.g;
        colors[index * 3 + 2] = base.b;
      }
      if ((sampleZ + 1) % 8 === 0 && sampleZ + 1 < renderSamples) {
        this.recordChunkTask(taskStarted);
        await this.yieldChunkTask();
        taskStarted = performance.now();
      }
    }
    this.recordChunkTask(taskStarted);
    await this.yieldChunkTask();
    taskStarted = performance.now();
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.rotateX(-Math.PI / 2);
    geometry.computeVertexNormals();
    const plan = buildTerrainLodIndexPlan(renderSamples, this.terrainLodSamples, size);
    const levels = plan.levels.map(({ distance, start, count }) => ({ distance, start, count }));
    geometry.setIndex(plan.indices);
    geometry.setDrawRange(levels[0]!.start, levels[0]!.count);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.93,
      metalness: 0,
      map: this.terrainDetail ?? null,
      normalMap: this.terrainNormal ?? null,
      normalScale: new THREE.Vector2(0.16, 0.16),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `terrain:${chunk.id}`;
    mesh.receiveShadow = true;
    mesh.userData['worldengineOwnedGeometry'] = true;
    mesh.userData['worldengineOwnedMaterial'] = true;
    const skirtGeometry = this.createTerrainSkirt(chunk, renderSamples, heights, colors, Math.max(10, (chunk.terrain.maxHeight - chunk.terrain.minHeight) * 0.2));
    const skirt = new THREE.Mesh(skirtGeometry, material);
    skirt.name = `terrain-skirt:${chunk.id}`;
    skirt.receiveShadow = true;
    skirt.userData['worldengineOwnedGeometry'] = true;
    const terrainGroup = new THREE.Group();
    terrainGroup.position.set(chunk.coordinate.x * size + size / 2, 0, chunk.coordinate.z * size + size / 2);
    terrainGroup.add(mesh, skirt);
    this.terrainLods.set(chunk.id, { mesh, levels, selected: 0 });
    const indexBytes = geometry.index?.array.byteLength ?? 0;
    const attributeBytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0) + Object.values(skirtGeometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0) + (skirtGeometry.index?.array.byteLength ?? 0);
    this.resources.touch(`chunk:${chunk.id}:terrain`, 'geometry', indexBytes + attributeBytes, this.frameIndex, true);
    this.recordChunkTask(taskStarted);
    return terrainGroup;
  }

  private async yieldChunkTask(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  private createTerrainSkirt(chunk: RuntimeChunk, samples: number, heights: Float32Array, surfaceColors: Float32Array, depth: number): THREE.BufferGeometry {
    const size = chunk.bounds.max[0] - chunk.bounds.min[0];
    const spacing = size / (samples - 1);
    const edge: Array<[number, number]> = [];
    for (let x = 0; x < samples; x += 1) edge.push([x, 0]);
    for (let z = 1; z < samples; z += 1) edge.push([samples - 1, z]);
    for (let x = samples - 2; x >= 0; x -= 1) edge.push([x, samples - 1]);
    for (let z = samples - 2; z > 0; z -= 1) edge.push([0, z]);
    const vertices = new Float32Array(edge.length * 2 * 3);
    const colors = new Float32Array(edge.length * 2 * 3);
    const uvs = new Float32Array(edge.length * 2 * 2);
    for (let index = 0; index < edge.length; index += 1) {
      const [x, z] = edge[index]!;
      const height = heights[z * samples + x]!;
      const localX = -size / 2 + x * spacing;
      const localZ = -size / 2 + z * spacing;
      vertices.set([localX, height, localZ, localX, height - depth, localZ], index * 6);
      const colorOffset = (z * samples + x) * 3;
      const red = surfaceColors[colorOffset] ?? 0.4; const green = surfaceColors[colorOffset + 1] ?? 0.45; const blue = surfaceColors[colorOffset + 2] ?? 0.36;
      colors.set([red, green, blue, red * 0.58, green * 0.58, blue * 0.58], index * 6);
      const u = x / (samples - 1); const v = z / (samples - 1);
      uvs.set([u, v, u, v + depth / size], index * 4);
    }
    const indices: number[] = [];
    for (let index = 0; index < edge.length; index += 1) {
      const next = (index + 1) % edge.length;
      indices.push(index * 2, index * 2 + 1, next * 2, next * 2, index * 2 + 1, next * 2 + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  private updateDistanceLods(view: CameraView): void {
    for (const [chunkId, group] of this.chunkGroups) {
      const center = group.userData['worldCenter'] as [number, number] | undefined;
      if (!center) continue;
      const distance = Math.hypot(view.position[0] - center[0], view.position[2] - center[1]);
      const prototypeLods = this.chunkPrototypeLods.get(chunkId);
      if (prototypeLods) for (const lod of prototypeLods) {
        const selected = selectDistanceLod(lod.distances, distance);
        lod.variants.forEach((variant, index) => variant.forEach((mesh) => { mesh.visible = index === selected; }));
      }
      const terrain = this.terrainLods.get(chunkId);
      if (terrain) {
        const selected = selectDistanceLod(terrain.levels.map((level) => level.distance), distance);
        if (selected !== terrain.selected) {
          terrain.selected = selected;
          const level = terrain.levels[selected]!;
          terrain.mesh.geometry.setDrawRange(level.start, level.count);
        }
      }
    }
  }

  private recordChunkTask(startedAt: number): void {
    this.maxChunkTaskMs = Math.max(this.maxChunkTaskMs, performance.now() - startedAt);
  }

  private visualKey(id: PrototypeId, assetUri: string, contentHash: string): string { return `${id}::${contentHash}::${assetUri}`; }

  private loadGltf(assetUri: string, contentHash: string): Promise<GLTF> {
    if (!/^[a-f\d]{64}$/i.test(contentHash)) throw new Error(`External GLB ${assetUri} requires a SHA-256 content hash`);
    const cacheKey = `${contentHash.toLowerCase()}::${assetUri}`;
    const existing = this.gltfAssets.get(cacheKey);
    if (existing) return existing;
    const loaded = this.fetchAndParseGltf(assetUri, contentHash).catch((error: unknown) => {
      this.gltfAssets.delete(cacheKey);
      throw error;
    });
    this.gltfAssets.set(cacheKey, loaded);
    return loaded;
  }

  private async loadAnimatedAsset(assetUri: string, contentHash: string): Promise<AnimatedAsset | undefined> {
    const gltf = await this.loadGltf(assetUri, contentHash);
    let skinned = false;
    gltf.scene.traverse((object) => { if (object instanceof THREE.SkinnedMesh) skinned = true; });
    return skinned && gltf.animations.length > 0 ? { scene: gltf.scene, clips: gltf.animations } : undefined;
  }

  private loadVisual(id: PrototypeId, assetUri: string, contentHash: string): Promise<StaticVisual> {
    const key = this.visualKey(id, assetUri, contentHash);
    const existing = this.visuals.get(key);
    if (existing) return existing;
    const prototype = this.prototypes.get(id);
    if (!prototype) throw new Error(`Unknown prototype ${id}`);
    const promise = assetUri.startsWith('primitive://')
      ? Promise.resolve({ parts: [createPrimitiveVisual(assetUri)] })
      : this.loadGltf(assetUri, contentHash).then((gltf) => {
          const meshes: THREE.Mesh[] = [];
          gltf.scene.traverse((object) => { if (object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh)) meshes.push(object); });
          if (meshes.length === 0) throw new Error(`GLB ${assetUri} contains no static mesh`);
          gltf.scene.updateMatrixWorld(true);
          const parts = meshes.map((mesh): PrimitiveVisual => {
            const geometry = mesh.geometry.clone();
            geometry.applyMatrix4(mesh.matrixWorld);
            return { geometry, material: this.cloneMaterials(mesh.material) };
          });
          const bounds = new THREE.Box3();
          for (const part of parts) {
            part.geometry.computeBoundingBox();
            if (part.geometry.boundingBox) bounds.union(part.geometry.boundingBox);
          }
          if (!bounds.isEmpty()) {
            const centerX = (bounds.min.x + bounds.max.x) / 2;
            const centerZ = (bounds.min.z + bounds.max.z) / 2;
            const horizontalRadius = Math.max((bounds.max.x - bounds.min.x) / 2, (bounds.max.z - bounds.min.z) / 2, 0.001);
            const scale = prototype.boundsRadius / horizontalRadius;
            for (const part of parts) {
              part.geometry.translate(-centerX, -bounds.min.y, -centerZ);
              part.geometry.scale(scale, scale, scale);
              part.geometry.computeBoundingBox();
              part.geometry.computeBoundingSphere();
            }
          }
          return { parts };
        });
    this.visuals.set(key, promise);
    void promise.catch(() => {
      if (this.visuals.get(key) === promise) this.visuals.delete(key);
      this.visualBytes.delete(key);
      this.resources.remove(`prototype:${key}`);
    });
    void promise.then((visual) => {
      const textures = new Set<THREE.Texture>();
      let geometryBytes = 0;
      for (const part of visual.parts) {
        geometryBytes += (part.geometry.index?.array.byteLength ?? 0) + Object.values(part.geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0);
        for (const material of this.materialsOf(part.material)) {
          for (const value of Object.values(material as THREE.Material & Record<string, unknown>)) if (value instanceof THREE.Texture) textures.add(value);
        }
      }
      let textureBytes = 0;
      for (const texture of textures) {
        const image = texture.image as { width?: number; height?: number } | undefined;
        textureBytes += (image?.width ?? 1) * (image?.height ?? 1) * 4 * 4 / 3;
      }
      const bytes = geometryBytes + textureBytes;
      this.visualBytes.set(key, bytes);
      this.resources.touch(`prototype:${key}`, 'other', bytes, this.frameIndex, (this.visualReferences.get(key) ?? 0) > 0);
    });
    return promise;
  }

  private async fetchAndParseGltf(assetUri: string, expectedHash: string): Promise<GLTF> {
    const response = await fetch(assetUri);
    if (!response.ok) throw new Error(`Unable to load GLB ${assetUri}: ${response.status} ${response.statusText}`);
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actualHash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    if (actualHash !== expectedHash.toLowerCase()) throw new Error(`GLB ${assetUri} content hash does not match its prototype`);
    const view = new DataView(bytes);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) throw new Error(`Asset ${assetUri} is not a valid glTF 2.0 GLB`);
    let resourcePath = '';
    const parsed = new URL(assetUri, globalThis.location?.href ?? 'http://localhost/');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') resourcePath = new URL('.', parsed).href;
    return this.loader.parseAsync(bytes, resourcePath);
  }

  private evictUnusedVisuals(): void {
    for (const candidate of this.resources.evictionCandidates()) {
      if (!candidate.id.startsWith('prototype:')) continue;
      const key = candidate.id.slice('prototype:'.length);
      if ((this.visualReferences.get(key) ?? 0) > 0) continue;
      const visual = this.visuals.get(key);
      if (!visual) continue;
      this.visuals.delete(key);
      this.visualBytes.delete(key);
      this.visualReferences.delete(key);
      this.resources.remove(candidate.id);
      void visual.then((value) => this.disposeVisual(value));
    }
  }

  private cloneMaterials(material: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
    return Array.isArray(material) ? material.map((candidate) => candidate.clone()) : material.clone();
  }

  private materialsOf(material: THREE.Material | THREE.Material[]): THREE.Material[] {
    return Array.isArray(material) ? material : [material];
  }

  private disposeVisual(visual: StaticVisual): void {
    for (const part of visual.parts) {
      part.geometry.dispose();
      part.ownedTextures?.forEach((texture) => texture.dispose());
      // Texture objects belong to the cached GLTF source and may be shared by
      // multiple static parts. They are disposed once with that source; only
      // procedural textures declare themselves owned above.
      this.materialsOf(part.material).forEach((material) => material.dispose());
    }
  }

  private disposeDetachedChunk(group: THREE.Group, chunkId: ChunkId): void {
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object.userData['worldengineOwnedGeometry'] === true) object.geometry.dispose();
      if (object.userData['worldengineOwnedMaterial'] === true) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      }
    });
    group.clear();
    this.terrainLods.delete(chunkId);
    this.resources.remove(`chunk:${chunkId}:terrain`);
    this.resources.remove(`chunk:${chunkId}:instances`);
  }

  private configureCamera(view: CameraView, origin: [number, number, number]): void {
    if (view.projection === 'orthographic') {
      const size = view.orthographicSize ?? 500;
      if (!(this.camera instanceof THREE.OrthographicCamera)) this.camera = new THREE.OrthographicCamera();
      this.camera.left = -size * view.aspect;
      this.camera.right = size * view.aspect;
      this.camera.top = size;
      this.camera.bottom = -size;
    } else {
      if (!(this.camera instanceof THREE.PerspectiveCamera)) this.camera = new THREE.PerspectiveCamera();
      this.camera.fov = view.fov ?? 50;
      this.camera.aspect = view.aspect;
    }
    this.camera.near = view.near;
    this.camera.far = view.far;
    this.camera.position.set(view.position[0] - origin[0], view.position[1] - origin[1], view.position[2] - origin[2]);
    this.camera.up.set(...view.up);
    this.camera.lookAt(view.target[0] - origin[0], view.target[1] - origin[1], view.target[2] - origin[2]);
    this.camera.updateProjectionMatrix();
  }

  private installLights(timeOfDay: number): void {
    if (this.sun) this.sun.removeFromParent();
    if (this.moon) this.moon.removeFromParent();
    const angle = ((timeOfDay - 6) / 24) * Math.PI * 2;
    const daylight = Math.max(0, Math.sin(angle));
    this.sun = new THREE.DirectionalLight(0xfff2d2, 0.25 + daylight * 3.1);
    this.sun.position.set(Math.cos(angle) * 1000, Math.max(100, Math.sin(angle) * 1000), 420);
    this.sun.castShadow = this.options.shadows ?? true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -700;
    this.sun.shadow.camera.right = 700;
    this.sun.shadow.camera.top = 700;
    this.sun.shadow.camera.bottom = -700;
    this.scene.add(this.sun);
    this.moon = new THREE.DirectionalLight(0x9eb8db, 0.24 * (1 - daylight));
    this.moon.position.copy(this.sun.position).multiplyScalar(-1);
    this.scene.add(this.moon);
    const existingAmbient = this.scene.getObjectByName('worldengine-hemisphere');
    const ambient = existingAmbient instanceof THREE.HemisphereLight ? existingAmbient : new THREE.HemisphereLight(0xd3e4ed, 0x64705a, 1.6);
    if (!(existingAmbient instanceof THREE.HemisphereLight)) {
      ambient.name = 'worldengine-hemisphere';
      this.scene.add(ambient);
    }
    ambient.intensity = 0.7 + daylight * 1.3;
  }

  private installSky(timeOfDay: number): void {
    if (!this.sky) {
      const geometry = new THREE.SphereGeometry(8_000, 32, 18);
      const material = new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true, depthWrite: false, fog: false });
      this.sky = new THREE.Mesh(geometry, material);
      this.sky.name = 'worldengine-sky';
      this.sky.frustumCulled = false;
      this.scene.add(this.sky);
      const bytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0) + (geometry.index?.array.byteLength ?? 0);
      this.resources.touch('sky', 'geometry', bytes, this.frameIndex, true);
    }
    const angle = ((timeOfDay - 6) / 24) * Math.PI * 2;
    const daylight = Math.max(0, Math.min(1, Math.sin(angle) * 1.7 + 0.12));
    const twilight = Math.max(0, 1 - Math.abs(Math.sin(angle)) * 4);
    const zenith = new THREE.Color(0x07101d).lerp(new THREE.Color(0x5f94c2), daylight);
    const horizon = new THREE.Color(0x182338).lerp(new THREE.Color(0xc4d3d6), daylight).lerp(new THREE.Color(0xd58f61), twilight * 0.55);
    if (this.weatherKind === 'cloudy') {
      zenith.lerp(new THREE.Color(0x718086), 0.72);
      horizon.lerp(new THREE.Color(0x9aa4a3), 0.7);
    } else if (this.weatherKind === 'rain') {
      zenith.lerp(new THREE.Color(0x3e515d), 0.78);
      horizon.lerp(new THREE.Color(0x708187), 0.72);
    } else if (this.weatherKind === 'snow') {
      zenith.lerp(new THREE.Color(0x8ca5b2), 0.55);
      horizon.lerp(new THREE.Color(0xd5dfe0), 0.62);
    } else if (this.weatherKind === 'fog') {
      zenith.lerp(new THREE.Color(0xaeb9b9), 0.78);
      horizon.lerp(new THREE.Color(0xc7ceca), 0.82);
    }
    const positions = this.sky.geometry.attributes['position'];
    if (!positions) return;
    const colors = new Float32Array(positions.count * 3);
    for (let index = 0; index < positions.count; index += 1) {
      const factor = Math.max(0, Math.min(1, positions.getY(index) / 8_000 * 0.7 + 0.3));
      const color = horizon.clone().lerp(zenith, factor);
      colors[index * 3] = color.r; colors[index * 3 + 1] = color.g; colors[index * 3 + 2] = color.b;
    }
    this.sky.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.scene.background = horizon;
  }

  private installWeather(weather: string): void {
    this.disposeWeather();
    this.weatherKind = weather;
    this.scene.background = this.baseBackground.clone();
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = this.baseFogDensity;
    if (weather === 'clear' || weather === 'cloudy' || weather === 'fog') {
      if (weather === 'cloudy') this.scene.background = new THREE.Color(0x7f9194);
      if (weather === 'fog' && this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = Math.max(this.scene.fog.density, 0.0025);
      return;
    }
    const count = weather === 'rain' ? 1800 : 1100;
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      positions[index * 3] = ((index * 73) % 401) - 200;
      positions[index * 3 + 1] = (index * 47) % 180;
      positions[index * 3 + 2] = ((index * 109) % 401) - 200;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: weather === 'rain' ? 0xa8c6d4 : 0xf2f6f4, size: weather === 'rain' ? 0.6 : 1.8, transparent: true, opacity: 0.75, depthWrite: false });
    this.weather = new THREE.Points(geometry, material);
    this.weather.name = 'worldengine-weather';
    this.scene.add(this.weather);
    this.resources.touch('weather', 'geometry', positions.byteLength, this.frameIndex, true);
  }

  private updateWeather(frame: VisualFrame): void {
    if (!this.weather) return;
    this.weather.position.set(frame.view.position[0] - frame.origin[0], frame.view.position[1] - 60, frame.view.position[2] - frame.origin[2]);
    const positions = this.weather.geometry.attributes['position'];
    if (!positions) return;
    const fall = this.weatherKind === 'rain' ? 75 : 14;
    for (let index = 0; index < positions.count; index += 1) {
      let y = positions.getY(index) - fall * frame.deltaSeconds;
      if (y < 0) y += 180;
      positions.setY(index, y);
    }
    positions.needsUpdate = true;
  }

  private updateAnimations(frame: VisualFrame): void {
    const rotation = new THREE.Matrix4();
    const animatedMeshes = new Set<THREE.InstancedMesh>();
    for (const binding of this.entities.values()) {
      if (binding.mixers.length > 0) {
        const clipName = binding.state.animationClip;
        if (!clipName || binding.state.visible === false) {
          if (binding.activeClip) binding.mixers.forEach((mixer) => mixer.stopAllAction());
          delete binding.activeClip;
          continue;
        }
        const clip = binding.clips.find((candidate) => candidate.name === clipName);
        if (!clip) continue;
        if (binding.activeClip !== clipName) {
          binding.mixers.forEach((mixer) => { mixer.stopAllAction(); mixer.clipAction(clip).reset().play(); });
          binding.activeClip = clipName;
        }
        if (typeof binding.state.animationTime === 'number') binding.mixers.forEach((mixer) => mixer.setTime(binding.state.animationTime!));
        else binding.mixers.forEach((mixer) => mixer.update(frame.deltaSeconds));
        continue;
      }
      if (!binding.state.animationClip || binding.state.visible === false) continue;
      const prototype = this.prototypes.get(binding.prototypeId);
      if (!prototype?.animationClips.includes(binding.state.animationClip)) continue;
      const time = typeof binding.state.animationTime === 'number' ? binding.state.animationTime : frame.elapsedSeconds;
      rotation.makeRotationY(time * 0.8);
      for (const mesh of binding.meshes) {
        mesh.setMatrixAt(binding.index, binding.originalMatrix.clone().multiply(rotation));
        animatedMeshes.add(mesh);
      }
    }
    animatedMeshes.forEach((mesh) => { mesh.instanceMatrix.needsUpdate = true; });
  }

  private applyEntityAppearance(binding: EntityBinding): void {
    const visible = binding.state.visible ?? true;
    binding.color.set(binding.state.materialVariant === 'seasonal' ? 0xd2b879 : 0xffffff);
    if (typeof binding.state.teamColor === 'string') binding.color.lerp(new THREE.Color(binding.state.teamColor), 0.68);
    const damage = typeof binding.state.damage === 'number' ? binding.state.damage : 0;
    for (const mesh of binding.meshes) {
      mesh.setMatrixAt(binding.index, visible ? binding.originalMatrix : new THREE.Matrix4().makeScale(0, 0, 0));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.setColorAt(binding.index, binding.color.clone().multiplyScalar(1 - damage * 0.65));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const object of binding.objects) {
      binding.originalMatrix.decompose(object.position, object.quaternion, object.scale);
      object.visible = visible;
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if (!('color' in material) || !(material.color instanceof THREE.Color)) continue;
          const colorMaterial = material as THREE.Material & { color: THREE.Color };
          const stored = material.userData['worldengineBaseColor'] as number | undefined;
          if (stored === undefined) material.userData['worldengineBaseColor'] = colorMaterial.color.getHex();
          colorMaterial.color.setHex(stored ?? colorMaterial.color.getHex());
          if (binding.state.materialVariant === 'seasonal') colorMaterial.color.lerp(new THREE.Color(0xd2b879), 0.5);
          if (typeof binding.state.teamColor === 'string') colorMaterial.color.lerp(new THREE.Color(binding.state.teamColor), 0.68);
          colorMaterial.color.multiplyScalar(1 - damage * 0.65);
        }
      });
    }
  }

  private disposeWeather(): void {
    if (!this.weather) return;
    this.weather.geometry.dispose();
    this.weather.material.dispose();
    this.weather.removeFromParent();
    this.weather = undefined;
    this.resources.remove('weather');
  }
}
