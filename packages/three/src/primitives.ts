import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface PrimitiveVisual {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** Textures created specifically for this visual and safe to dispose with it. */
  ownedTextures?: THREE.Texture[];
}

type Vector = readonly [number, number, number];
interface Part {
  geometry: THREE.BufferGeometry;
  color: number;
  position?: Vector;
  rotation?: Vector;
  scale?: Vector;
}

const palette = {
  leaf: 0x47744a,
  leafLight: 0x6d9256,
  leafDark: 0x315d42,
  bark: 0x654733,
  birch: 0xc7c4a9,
  stone: 0x727d7b,
  stoneLight: 0x929995,
  stoneDark: 0x535e5c,
  timber: 0x765038,
  timberDark: 0x4f3528,
  plaster: 0xc4b38d,
  roof: 0x704236,
  cloth: 0xb98a4f,
  accent: 0xd1ae58,
  watercraft: 0x815538,
  flower: 0xd9a2aa,
  metal: 0x5c6565,
  ice: 0xb8d4d8,
  snow: 0xdde5e2,
  sand: 0xc49a5a,
  obsidian: 0x29262d,
  ash: 0x554f4d,
  cactus: 0x477952,
  sulfur: 0xc8b23f,
};

function transformed(part: Part): THREE.BufferGeometry {
  const source = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...(part.position ?? [0, 0, 0])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(part.rotation ?? [0, 0, 0]))),
    new THREE.Vector3(...(part.scale ?? [1, 1, 1])),
  );
  source.applyMatrix4(matrix);
  const position = source.getAttribute('position');
  if (!position) throw new Error('Procedural primitive part has no position buffer');
  if (!source.getAttribute('normal')) source.computeVertexNormals();
  if (!source.getAttribute('uv')) source.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
  const normal = source.getAttribute('normal');
  const color = new THREE.Color(part.color);
  const colors = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index += 1) {
    const grain = Math.sin(position.getX(index) * 7.13 + position.getY(index) * 3.71 + position.getZ(index) * 5.93) * 0.5 + 0.5;
    const skyExposure = normal ? Math.max(-0.15, normal.getY(index)) : 0;
    const shade = Math.max(0.72, Math.min(1.1, 0.8 + grain * 0.18 + skyExposure * 0.1));
    colors.set([Math.min(1, color.r * shade), Math.min(1, color.g * shade), Math.min(1, color.b * shade)], index * 3);
  }
  source.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return source;
}

function proceduralSurface(parts: Part[], roughness: number): { map: THREE.DataTexture; roughnessMap: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const size = 64;
  const albedo = new Uint8Array(size * size * 4);
  const rough = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const seed = parts.reduce((value, part, index) => (Math.imul(value ^ part.color, 16_777_619) + index * 97) >>> 0, 2_166_136_261);
  const phaseA = (seed & 0xffff) / 0xffff * Math.PI * 2;
  const phaseB = ((seed >>> 16) & 0xffff) / 0xffff * Math.PI * 2;
  const heightAt = (x: number, y: number): number => {
    const u = ((x % size) + size) % size / size * Math.PI * 2;
    const v = ((y % size) + size) % size / size * Math.PI * 2;
    return Math.sin(u * 3 + phaseA) * 0.38 + Math.sin(v * 5 + phaseB) * 0.25
      + Math.sin((u + v) * 9 + phaseA * 0.7) * 0.14 + Math.sin((u * 17 - v * 13) + phaseB) * 0.07;
  };
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * 4;
    const height = heightAt(x, y);
    const speckle = (((Math.imul(x + 1, 73_856_093) ^ Math.imul(y + 1, 19_349_663) ^ seed) >>> 24) / 255 - 0.5) * 10;
    const value = Math.max(188, Math.min(255, Math.round(229 + height * 20 + speckle)));
    albedo.set([value, value, value, 255], offset);
    const roughValue = Math.max(64, Math.min(255, Math.round(roughness * 255 * (0.94 - height * 0.09))));
    rough.set([roughValue, roughValue, roughValue, 255], offset);
    const dx = heightAt(x + 1, y) - heightAt(x - 1, y);
    const dy = heightAt(x, y + 1) - heightAt(x, y - 1);
    const tangentNormal = new THREE.Vector3(-dx * 0.55, -dy * 0.55, 1).normalize();
    normal.set([
      Math.round((tangentNormal.x * 0.5 + 0.5) * 255),
      Math.round((tangentNormal.y * 0.5 + 0.5) * 255),
      Math.round((tangentNormal.z * 0.5 + 0.5) * 255),
      255,
    ], offset);
  }
  const configure = (data: Uint8Array, colorSpace?: string): THREE.DataTexture => {
    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    if (colorSpace) texture.colorSpace = colorSpace;
    texture.needsUpdate = true;
    return texture;
  };
  return {
    map: configure(albedo, THREE.SRGBColorSpace),
    roughnessMap: configure(rough),
    normalMap: configure(normal),
  };
}

function model(parts: Part[], roughness = 0.86, metalness = 0): PrimitiveVisual {
  const geometries = parts.map(transformed);
  const geometry = mergeGeometries(geometries, false);
  geometries.forEach((entry) => entry.dispose());
  if (!geometry) throw new Error('Could not merge procedural primitive geometry');
  geometry.computeBoundingBox();
  geometry.translate(0, -(geometry.boundingBox?.min.y ?? 0), 0);
  geometry.computeBoundingSphere();
  const textures = proceduralSurface(parts, roughness);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness,
    metalness,
    map: textures.map,
    roughnessMap: textures.roughnessMap,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(0.22, 0.22),
    dithering: true,
  });
  return { geometry, material, ownedTextures: [textures.map, textures.roughnessMap, textures.normalMap] };
}

function tree(kind: string): PrimitiveVisual {
  const trunkColor = kind === 'birch' ? palette.birch : /dead|charred/.test(kind) ? palette.ash : palette.bark;
  const parts: Part[] = [{ geometry: new THREE.CylinderGeometry(0.42, 0.62, 4.8, 12), color: trunkColor, position: [0, 2.4, 0] }];
  if (/dead-tree|charred-pine/.test(kind)) {
    parts.push(
      { geometry: new THREE.CylinderGeometry(0.16, 0.28, 3.6, 6), color: trunkColor, position: [-0.75, 4.6, 0], rotation: [0, 0, -0.62] },
      { geometry: new THREE.CylinderGeometry(0.13, 0.24, 3.1, 6), color: trunkColor, position: [0.7, 5.3, 0.15], rotation: [0.12, 0, 0.7] },
      { geometry: new THREE.CylinderGeometry(0.08, 0.16, 2.3, 5), color: trunkColor, position: [0.25, 6.3, -0.45], rotation: [-0.8, 0, 0.18] },
    );
  } else if (kind === 'date-palm') {
    parts[0] = { geometry: new THREE.CylinderGeometry(0.3, 0.55, 7.2, 9), color: palette.bark, position: [0, 3.6, 0], rotation: [0, 0, -0.08] };
    for (let index = 0; index < 9; index += 1) {
      const angle = index / 9 * Math.PI * 2;
      parts.push({ geometry: new THREE.SphereGeometry(0.72, 9, 5), color: index % 2 ? palette.leafLight : palette.leaf, position: [Math.cos(angle) * 1.25 - 0.55, 7.35, Math.sin(angle) * 1.25], scale: [2.3, 0.18, 0.52], rotation: [0, -angle, Math.sin(index * 2.1) * 0.12] });
    }
  } else if (kind === 'acacia') {
    parts.push(
      { geometry: new THREE.CylinderGeometry(0.22, 0.34, 3.8, 7), color: palette.bark, position: [-0.65, 4.4, 0], rotation: [0, 0, -0.32] },
      { geometry: new THREE.IcosahedronGeometry(2.4, 2), color: palette.leafDark, position: [-0.8, 6, 0], scale: [1.55, 0.38, 1] },
      { geometry: new THREE.IcosahedronGeometry(2.1, 2), color: palette.leafLight, position: [1.4, 6.1, 0.25], scale: [1.4, 0.32, 1] },
    );
  } else if (/pine|spruce|fir/.test(kind)) {
    parts.push(
      { geometry: new THREE.ConeGeometry(2.25, 4.5, 16), color: palette.leafDark, position: [0, 4.3, 0] },
      { geometry: new THREE.ConeGeometry(1.8, 4, 16), color: palette.leaf, position: [0, 6, 0] },
      { geometry: new THREE.ConeGeometry(1.25, 3.3, 16), color: palette.leafLight, position: [0, 7.5, 0] },
    );
  } else if (kind === 'willow') {
    parts.push(
      { geometry: new THREE.IcosahedronGeometry(2.3, 2), color: palette.leafDark, position: [-0.7, 5.2, 0], scale: [1, 0.85, 1] },
      { geometry: new THREE.IcosahedronGeometry(2.1, 2), color: palette.leaf, position: [1, 5.4, 0.2], scale: [1, 0.9, 1] },
      { geometry: new THREE.ConeGeometry(0.38, 3.5, 6), color: palette.leafLight, position: [-1.4, 3.2, 0.5], rotation: [0, 0, 0.18] },
      { geometry: new THREE.ConeGeometry(0.35, 3.2, 6), color: palette.leaf, position: [1.5, 3.4, -0.3], rotation: [0, 0, -0.2] },
    );
  } else {
    parts.push(
      { geometry: new THREE.IcosahedronGeometry(1.75, 2), color: palette.leafDark, position: [-1.1, 5.1, 0] },
      { geometry: new THREE.IcosahedronGeometry(1.9, 2), color: palette.leaf, position: [0.8, 5.5, 0.2] },
      { geometry: new THREE.IcosahedronGeometry(1.55, 2), color: palette.leafLight, position: [0, 6.8, -0.3] },
    );
  }
  return model(parts);
}

function groundPlant(kind: string): PrimitiveVisual {
  if (kind === 'cactus') return model([
    { geometry: new THREE.CylinderGeometry(0.38, 0.5, 4.5, 9), color: palette.cactus, position: [0, 2.25, 0] },
    { geometry: new THREE.CylinderGeometry(0.22, 0.28, 2.1, 8), color: palette.cactus, position: [0.85, 2.4, 0], rotation: [0, 0, -0.72] },
    { geometry: new THREE.CylinderGeometry(0.2, 0.26, 1.7, 8), color: palette.cactus, position: [-0.75, 3.15, 0.1], rotation: [0, 0, 0.75] },
    { geometry: new THREE.SphereGeometry(0.24, 8, 5), color: palette.flower, position: [0, 4.58, 0] },
  ]);
  if (kind === 'sulfur-vent') return model([
    { geometry: new THREE.ConeGeometry(1.1, 1.4, 7), color: palette.ash, position: [0, 0.7, 0] },
    { geometry: new THREE.CylinderGeometry(0.22, 0.45, 1.1, 7), color: palette.sulfur, position: [0, 1.4, 0] },
    { geometry: new THREE.DodecahedronGeometry(0.48, 0), color: palette.sulfur, position: [0.8, 0.35, 0.35] },
  ]);
  if (kind === 'reed' || kind === 'frozen-reed') {
    return model(Array.from({ length: 7 }, (_, index) => ({
      geometry: new THREE.CylinderGeometry(0.055, 0.075, 2.3 + (index % 3) * 0.45, 5), color: kind === 'frozen-reed' ? (index % 2 ? palette.ice : palette.snow) : index % 2 ? palette.leafLight : palette.leaf,
      position: [((index % 4) - 1.5) * 0.28, 1.2, (Math.floor(index / 4) - 0.5) * 0.38] as Vector, rotation: [0, 0, (index - 3) * 0.035] as Vector,
    })));
  }
  if (kind === 'mushroom') return model([
    { geometry: new THREE.CylinderGeometry(0.18, 0.28, 0.9, 8), color: palette.plaster, position: [0, 0.45, 0] },
    { geometry: new THREE.SphereGeometry(0.72, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), color: palette.roof, position: [0, 0.85, 0] },
    { geometry: new THREE.CylinderGeometry(0.1, 0.16, 0.55, 7), color: palette.plaster, position: [0.85, 0.28, 0.25], scale: [0.8, 0.8, 0.8] },
    { geometry: new THREE.SphereGeometry(0.45, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), color: palette.accent, position: [0.85, 0.52, 0.25] },
  ]);
  if (/shrub/.test(kind)) {
    const color = kind === 'snow-shrub' ? palette.snow : kind === 'ash-shrub' ? palette.ash : kind === 'dry-shrub' ? palette.sand : palette.leaf;
    return model(Array.from({ length: 7 }, (_, index): Part => {
      const angle = index / 7 * Math.PI * 2;
      return { geometry: new THREE.IcosahedronGeometry(0.55 + (index % 3) * 0.12, 1), color, position: [Math.cos(angle) * 0.7, 0.5 + (index % 2) * 0.25, Math.sin(angle) * 0.7], scale: [1.25, 0.7, 1] };
    }));
  }
  const parts: Part[] = [{ geometry: new THREE.CylinderGeometry(0.06, 0.09, 1.4, 5), color: palette.leaf, position: [0, 0.7, 0] }];
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    parts.push({ geometry: new THREE.SphereGeometry(kind === 'wildflower' ? 0.22 : 0.55, 7, 5), color: kind === 'wildflower' ? (index % 2 ? palette.flower : palette.accent) : palette.leafLight, position: [Math.cos(angle) * 0.55, kind === 'wildflower' ? 1.45 : 0.55, Math.sin(angle) * 0.55], scale: kind === 'fern' ? [1.8, 0.24, 0.55] : [1, 0.45, 1], rotation: [0, -angle, 0] });
  }
  return model(parts);
}

function rock(kind: string): PrimitiveVisual {
  if (kind === 'archway') return model([
    { geometry: new THREE.BoxGeometry(1.35, 6.2, 1.4), color: palette.stone, position: [-2.4, 3.1, 0] },
    { geometry: new THREE.BoxGeometry(1.35, 6.2, 1.4), color: palette.stoneDark, position: [2.4, 3.1, 0] },
    { geometry: new THREE.BoxGeometry(6.2, 1.4, 1.5), color: palette.stoneLight, position: [0, 6.2, 0] },
    { geometry: new THREE.BoxGeometry(1.1, 0.7, 1.7), color: palette.stoneDark, position: [-1.3, 7.2, 0], rotation: [0, 0, 0.08] },
  ]);
  if (kind === 'basalt-column') return model(Array.from({ length: 6 }, (_, index): Part => {
    const angle = index / 6 * Math.PI * 2;
    return { geometry: new THREE.CylinderGeometry(0.55, 0.62, 3.5 + (index % 3) * 1.2, 6), color: index % 2 ? palette.obsidian : palette.ash, position: [Math.cos(angle) * 0.75, 2.2 + (index % 3) * 0.55, Math.sin(angle) * 0.75] };
  }));
  if (kind === 'ruin-column') return model([
    { geometry: new THREE.CylinderGeometry(1.1, 1.25, 0.5, 10), color: palette.stoneDark, position: [0, 0.25, 0] },
    { geometry: new THREE.CylinderGeometry(0.72, 0.82, 4.8, 10), color: palette.stone, position: [0, 2.8, 0] },
    { geometry: new THREE.CylinderGeometry(1, 0.9, 0.45, 10), color: palette.stoneLight, position: [0, 5.35, 0], rotation: [0.08, 0, 0.09] },
  ]);
  if (kind === 'ruin-wall') return model([
    { geometry: new THREE.BoxGeometry(5.4, 2.6, 0.85), color: palette.stone, position: [0, 1.3, 0] },
    { geometry: new THREE.BoxGeometry(1.4, 1.5, 0.9), color: palette.stoneLight, position: [-2, 3.25, 0], rotation: [0, 0, -0.08] },
    { geometry: new THREE.BoxGeometry(1.15, 1, 0.9), color: palette.stoneDark, position: [0, 3, 0], rotation: [0, 0, 0.12] },
  ]);
  const baseColor = kind.includes('ice') ? palette.ice : kind.includes('obsidian') ? palette.obsidian : kind.includes('sandstone') ? palette.sand : palette.stone;
  const large = /boulder/.test(kind);
  return model([
    { geometry: new THREE.DodecahedronGeometry(large ? 1.8 : 1.3, 0), color: baseColor, position: [0, large ? 1.15 : 2.5, 0], scale: large ? [1.25, 0.75, 1] : [0.85, 2, 0.75], rotation: [0.08, 0.35, -0.12] },
    { geometry: new THREE.DodecahedronGeometry(0.75, 0), color: kind.includes('ice') ? palette.snow : palette.stoneDark, position: [1.2, 0.5, 0.4], scale: [1, 0.65, 0.9] },
  ]);
}

function building(kind: string): PrimitiveVisual {
  if (kind === 'tent') return model([
    { geometry: new THREE.ConeGeometry(3.8, 4.6, 4), color: palette.cloth, position: [0, 2.3, 0], rotation: [0, Math.PI / 4, 0], scale: [1.25, 1, 0.82] },
    { geometry: new THREE.CylinderGeometry(0.1, 0.12, 5.2, 6), color: palette.timberDark, position: [0, 2.6, 0] },
    { geometry: new THREE.BoxGeometry(1.2, 2.1, 0.15), color: palette.timberDark, position: [0, 1.05, 3.15] },
  ]);
  if (kind === 'well') return model([
    { geometry: new THREE.CylinderGeometry(1.8, 2, 1.5, 12, 1, true), color: palette.stone, position: [0, 0.75, 0] },
    { geometry: new THREE.CylinderGeometry(0.18, 0.22, 3.7, 7), color: palette.timberDark, position: [-1.45, 2.3, 0] },
    { geometry: new THREE.CylinderGeometry(0.18, 0.22, 3.7, 7), color: palette.timberDark, position: [1.45, 2.3, 0] },
    { geometry: new THREE.CylinderGeometry(0.16, 0.16, 3.3, 8), color: palette.timber, position: [0, 3.6, 0], rotation: [0, 0, Math.PI / 2] },
    { geometry: new THREE.ConeGeometry(2.6, 1.7, 6), color: palette.roof, position: [0, 4.45, 0] },
  ]);
  if (kind === 'cabin') return model([
    { geometry: new THREE.BoxGeometry(6.2, 3.6, 5), color: palette.timber, position: [0, 1.8, 0] },
    { geometry: new THREE.ConeGeometry(4.7, 3.1, 4), color: palette.snow, position: [0, 4.9, 0], rotation: [0, Math.PI / 4, 0] },
    { geometry: new THREE.BoxGeometry(1.2, 2.3, 0.25), color: palette.timberDark, position: [0, 1.15, 2.62] },
    ...Array.from({ length: 6 }, (_, index): Part => ({ geometry: new THREE.CylinderGeometry(0.16, 0.16, 6, 6), color: palette.timberDark, position: [0, 0.8 + index * 0.52, 2.55], rotation: [0, 0, Math.PI / 2] })),
  ]);
  if (kind === 'caravan-cart') return model([
    { geometry: new THREE.BoxGeometry(4.8, 1.8, 2.8), color: palette.timber, position: [0, 2.1, 0] },
    { geometry: new THREE.CylinderGeometry(1.25, 1.25, 0.35, 12), color: palette.timberDark, position: [-1.55, 1.2, 1.55], rotation: [Math.PI / 2, 0, 0] },
    { geometry: new THREE.CylinderGeometry(1.25, 1.25, 0.35, 12), color: palette.timberDark, position: [1.55, 1.2, 1.55], rotation: [Math.PI / 2, 0, 0] },
    { geometry: new THREE.BoxGeometry(4.4, 0.18, 2.5), color: palette.cloth, position: [0, 4.1, 0], rotation: [0, 0, -0.08] },
    { geometry: new THREE.BoxGeometry(4.5, 0.2, 0.25), color: palette.timberDark, position: [4.2, 1.4, 0] },
  ]);
  if (kind === 'sled') return model([
    { geometry: new THREE.BoxGeometry(4.8, 0.25, 0.22), color: palette.metal, position: [0, 0.25, 1.15] },
    { geometry: new THREE.BoxGeometry(4.8, 0.25, 0.22), color: palette.metal, position: [0, 0.25, -1.15] },
    { geometry: new THREE.BoxGeometry(3.5, 0.35, 2.8), color: palette.timber, position: [0, 0.85, 0] },
    { geometry: new THREE.BoxGeometry(2.5, 1.7, 0.25), color: palette.timberDark, position: [-1.35, 1.6, 0] },
  ]);
  if (kind === 'cottage') return model([
    { geometry: new THREE.BoxGeometry(6, 3.8, 5), color: palette.plaster, position: [0, 1.9, 0] },
    { geometry: new THREE.ConeGeometry(4.6, 3.2, 4), color: palette.roof, position: [0, 5.15, 0], rotation: [0, Math.PI / 4, 0] },
    { geometry: new THREE.BoxGeometry(1.25, 2.2, 0.28), color: palette.timberDark, position: [0, 1.1, 2.62] },
    { geometry: new THREE.BoxGeometry(0.9, 1.15, 0.25), color: palette.accent, position: [-1.8, 2.3, 2.63] },
    { geometry: new THREE.BoxGeometry(0.7, 2.5, 0.7), color: palette.stoneDark, position: [1.75, 5.4, -0.8] },
  ]);
  if (kind === 'watchtower') return model([
    { geometry: new THREE.CylinderGeometry(1.8, 2.3, 9, 8), color: palette.stone, position: [0, 4.5, 0] },
    { geometry: new THREE.CylinderGeometry(3.2, 3.2, 1, 8), color: palette.timber, position: [0, 9.2, 0] },
    { geometry: new THREE.ConeGeometry(3.7, 3.2, 8), color: palette.roof, position: [0, 11.3, 0] },
    ...Array.from({ length: 6 }, (_, index): Part => ({ geometry: new THREE.BoxGeometry(0.38, 1.1, 0.38), color: palette.timberDark, position: [Math.cos(index * Math.PI / 3) * 2.6, 10.1, Math.sin(index * Math.PI / 3) * 2.6] })),
  ]);
  if (kind === 'dock') return model([
    ...Array.from({ length: 7 }, (_, index): Part => ({ geometry: new THREE.BoxGeometry(4.8, 0.28, 0.8), color: index % 2 ? palette.timber : palette.timberDark, position: [0, 1.1, index * 0.82 - 2.5] })),
    ...([-1, 1] as const).flatMap((side) => [-2.5, 2.5].map((z): Part => ({ geometry: new THREE.CylinderGeometry(0.22, 0.3, 2.8, 7), color: palette.timberDark, position: [side * 2, 1.4, z] }))),
  ]);
  if (kind === 'bridge') return model([
    ...Array.from({ length: 10 }, (_, index): Part => ({ geometry: new THREE.BoxGeometry(1.05, 0.25, 3.4), color: index % 2 ? palette.timber : palette.timberDark, position: [index - 4.5, 1 + Math.sin((index / 9) * Math.PI) * 1.5, 0], rotation: [0, 0, Math.cos((index / 9) * Math.PI) * -0.22] })),
    { geometry: new THREE.BoxGeometry(10.5, 0.22, 0.22), color: palette.timberDark, position: [0, 3, 1.5] },
    { geometry: new THREE.BoxGeometry(10.5, 0.22, 0.22), color: palette.timberDark, position: [0, 3, -1.5] },
  ]);
  return model([
    { geometry: new THREE.BoxGeometry(5.5, 0.45, 3.8), color: palette.timber, position: [0, 0.3, 0] },
    { geometry: new THREE.BoxGeometry(6.2, 0.35, 4.4), color: palette.cloth, position: [0, 4.2, 0], rotation: [0, 0, -0.08] },
    ...([-1, 1] as const).flatMap((x) => [-1, 1].map((z): Part => ({ geometry: new THREE.CylinderGeometry(0.13, 0.16, 4, 6), color: palette.timberDark, position: [x * 2.3, 2, z * 1.5] }))),
    { geometry: new THREE.BoxGeometry(4.6, 1.25, 1.2), color: palette.plaster, position: [0, 1, 0.6] },
  ]);
}

function feature(kind: string): PrimitiveVisual {
  if (kind === 'windmill') {
    const parts: Part[] = [
      { geometry: new THREE.CylinderGeometry(2.8, 4.1, 10, 10), color: palette.plaster, position: [0, 5, 0] },
      { geometry: new THREE.ConeGeometry(3.3, 3.2, 10), color: palette.roof, position: [0, 11.5, 0] },
      { geometry: new THREE.CylinderGeometry(0.42, 0.42, 1, 10), color: palette.metal, position: [0, 8.2, 3.8], rotation: [Math.PI / 2, 0, 0] },
    ];
    for (let index = 0; index < 4; index += 1) parts.push({ geometry: new THREE.BoxGeometry(0.55, 6.8, 0.18), color: palette.timberDark, position: [0, 8.2, 4.35], rotation: [0, 0, index * Math.PI / 2 + 0.2] });
    return model(parts);
  }
  if (kind === 'boat') return model([
    { geometry: new THREE.CylinderGeometry(0.55, 2.2, 5.8, 4), color: palette.watercraft, position: [0, 0.8, 0], rotation: [0, 0, Math.PI / 2], scale: [1, 1, 0.65] },
    { geometry: new THREE.CylinderGeometry(0.12, 0.16, 5.6, 7), color: palette.timberDark, position: [0, 3.4, 0] },
    { geometry: new THREE.CircleGeometry(2.25, 3), color: palette.plaster, position: [0.1, 3.9, 0.08], rotation: [0, 0, -Math.PI / 2], scale: [1, 1.35, 1] },
  ]);
  return model([
    { geometry: new THREE.CylinderGeometry(0.13, 0.18, 3.2, 7), color: palette.metal, position: [0, 1.6, 0] },
    { geometry: new THREE.BoxGeometry(0.85, 1.1, 0.85), color: palette.accent, position: [0, 3.05, 0] },
    { geometry: new THREE.ConeGeometry(0.75, 0.65, 6), color: palette.metal, position: [0, 3.9, 0] },
  ], 0.58, 0.22);
}

export function createPrimitiveVisual(uri: string): PrimitiveVisual {
  const kind = uri.replace('primitive://', '');
  if (['oak', 'pine', 'birch', 'willow', 'acacia', 'spruce', 'fir', 'dead-tree', 'charred-pine', 'date-palm'].includes(kind)) return tree(kind);
  if (['reed', 'fern', 'wildflower', 'mushroom', 'cactus', 'dry-shrub', 'frozen-reed', 'snow-shrub', 'ash-shrub', 'sulfur-vent'].includes(kind)) return groundPlant(kind);
  if (['boulder', 'standing-stone', 'ruin-column', 'ruin-wall', 'sandstone-boulder', 'ice-boulder', 'obsidian-boulder', 'basalt-column', 'archway'].includes(kind)) return rock(kind);
  if (['cottage', 'watchtower', 'dock', 'bridge', 'market-stall', 'tent', 'well', 'cabin', 'caravan-cart', 'sled'].includes(kind)) return building(kind);
  if (['windmill', 'boat', 'lantern'].includes(kind)) return feature(kind);
  return model([
    { geometry: new THREE.DodecahedronGeometry(1.2, 0), color: palette.accent, position: [0, 1.1, 0] },
    { geometry: new THREE.CylinderGeometry(0.3, 0.5, 2.2, 7), color: palette.timberDark, position: [0, 1.1, 0] },
  ]);
}
