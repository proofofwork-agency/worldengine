import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import type { AuthoringWorld, RegionSpec, Vec3, VisualWorldBundle } from '@worldengine/schema';
import { sampleWorldHeight } from '@worldengine/terrain';
import { pointInPolygon, type ReferenceCamera } from './composition.js';

interface ProjectedVertex { x: number; y: number; depth: number; color: [number, number, number] }

const biomeColors: Array<[RegExp, [number, number, number]]> = [
  [/snow|frozen|ice|tundra/, [196, 216, 222]],
  [/desert|dune|arid/, [190, 145, 78]],
  [/volcan|lava|ash/, [88, 72, 66]],
  [/wetland|swamp|marsh/, [83, 119, 79]],
  [/forest|wood|grove/, [61, 105, 61]],
  [/coast|shore|beach/, [106, 139, 124]],
  [/highland|mountain|cliff|canyon/, [116, 117, 106]],
];

function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(value: Vec3): Vec3 { const length = Math.hypot(...value); return length === 0 ? [0, 0, 0] : [value[0] / length, value[1] / length, value[2] / length]; }
function edge(a: ProjectedVertex, b: ProjectedVertex, x: number, y: number): number { return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x); }

function distanceToSegment(x: number, z: number, start: readonly [number, number], end: readonly [number, number]): number {
  const dx = end[0] - start[0]; const dz = end[1] - start[1]; const lengthSquared = dx * dx + dz * dz;
  const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - start[0]) * dx + (z - start[1]) * dz) / lengthSquared));
  return Math.hypot(x - (start[0] + dx * amount), z - (start[1] + dz * amount));
}

function project(camera: ReferenceCamera, point: Vec3, color: [number, number, number], width: number, height: number): ProjectedVertex | undefined {
  const forward = normalize(subtract(camera.target, camera.position));
  const right = normalize(cross(forward, camera.up));
  const up = normalize(cross(right, forward));
  const relative = subtract(point, camera.position);
  const depth = dot(relative, forward);
  if (depth <= 0.1) return undefined;
  const tangent = Math.tan(camera.verticalFovDegrees * Math.PI / 360);
  const ndcX = dot(relative, right) / (depth * tangent * camera.aspect);
  const ndcY = dot(relative, up) / (depth * tangent);
  return { x: (ndcX * 0.5 + 0.5) * width, y: (0.5 - ndcY * 0.5) * height, depth, color };
}

function rasterizeTriangle(pixels: Uint8Array, depths: Float32Array, width: number, height: number, a: ProjectedVertex, b: ProjectedVertex, c: ProjectedVertex): void {
  const area = edge(a, b, c.x, c.y);
  if (Math.abs(area) < 0.0001) return;
  const minimumX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maximumX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minimumY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maximumY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  for (let y = minimumY; y <= maximumY; y += 1) for (let x = minimumX; x <= maximumX; x += 1) {
    const wa = edge(b, c, x + 0.5, y + 0.5) / area;
    const wb = edge(c, a, x + 0.5, y + 0.5) / area;
    const wc = 1 - wa - wb;
    if (wa < 0 || wb < 0 || wc < 0) continue;
    const depth = wa * a.depth + wb * b.depth + wc * c.depth;
    const index = y * width + x;
    if (depth >= depths[index]!) continue;
    depths[index] = depth;
    const offset = index * 4;
    pixels[offset] = Math.round(wa * a.color[0] + wb * b.color[0] + wc * c.color[0]);
    pixels[offset + 1] = Math.round(wa * a.color[1] + wb * b.color[1] + wc * c.color[1]);
    pixels[offset + 2] = Math.round(wa * a.color[2] + wb * b.color[2] + wc * c.color[2]);
    pixels[offset + 3] = 255;
  }
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.byteLength);
  return output;
}

function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) Buffer.from(pixels.buffer, pixels.byteOffset + row * width * 4, width * 4).copy(scanlines, row * (width * 4 + 1) + 1);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanlines, { level: 7 })), pngChunk('IEND', new Uint8Array()),
  ]));
}

export function renderTerrainReference(bundle: VisualWorldBundle, region: RegionSpec, camera: ReferenceCamera, width = 768, height = 512): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 2_048 || height > 2_048) throw new Error('Terrain reference dimensions must be integers between 64 and 2048');
  const pixels = new Uint8Array(width * height * 4);
  const depths = new Float32Array(width * height); depths.fill(Number.POSITIVE_INFINITY);
  for (let y = 0; y < height; y += 1) {
    const amount = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round(125 + amount * 65); pixels[offset + 1] = Math.round(164 + amount * 48); pixels[offset + 2] = Math.round(190 + amount * 35); pixels[offset + 3] = 255;
    }
  }
  const minX = Math.min(...region.polygon.map((point) => point[0])); const maxX = Math.max(...region.polygon.map((point) => point[0]));
  const minZ = Math.min(...region.polygon.map((point) => point[1])); const maxZ = Math.max(...region.polygon.map((point) => point[1]));
  const padding = Math.max(maxX - minX, maxZ - minZ) * 0.85;
  const samples = 97;
  const stepX = (maxX - minX + padding * 2) / (samples - 1); const stepZ = (maxZ - minZ + padding * 2) / (samples - 1);
  const sun = normalize([0.5, 1, 0.32]);
  const vertices: Array<ProjectedVertex | undefined> = [];
  for (let zIndex = 0; zIndex < samples; zIndex += 1) for (let xIndex = 0; xIndex < samples; xIndex += 1) {
    const x = minX - padding + xIndex * stepX; const z = minZ - padding + zIndex * stepZ;
    const y = sampleWorldHeight(bundle, x, z);
    const dx = sampleWorldHeight(bundle, x + 6, z) - sampleWorldHeight(bundle, x - 6, z);
    const dz = sampleWorldHeight(bundle, x, z + 6) - sampleWorldHeight(bundle, x, z - 6);
    const normal = normalize([-dx, 12, -dz]);
    const light = Math.max(0.26, Math.min(1.08, 0.38 + Math.max(0, dot(normal, sun)) * 0.7));
    const elevation = (y - region.elevation.min) / Math.max(1, region.elevation.max - region.elevation.min);
    const localRegion = bundle.regions.find((candidate) => pointInPolygon([x, z], candidate.polygon)) ?? region;
    let baseColor = biomeColors.find(([pattern]) => pattern.test(localRegion.biome.toLowerCase()))?.[1] ?? [104, 137, 88];
    for (const feature of bundle.features) {
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 1; index < feature.points.length; index += 1) distance = Math.min(distance, distanceToSegment(x, z, feature.points[index - 1]!, feature.points[index]!));
      if (distance < feature.width) baseColor = feature.kind === 'river' ? [48, 111, 148] : feature.kind === 'road' ? [133, 105, 72] : [91, 145, 151];
    }
    const color = baseColor.map((channel) => Math.max(0, Math.min(255, Math.round(channel * light + elevation * 16)))) as [number, number, number];
    vertices.push(project(camera, [x, y, z], color, width, height));
  }
  for (let z = 0; z < samples - 1; z += 1) for (let x = 0; x < samples - 1; x += 1) {
    const a = vertices[z * samples + x]; const b = vertices[z * samples + x + 1]; const c = vertices[(z + 1) * samples + x]; const d = vertices[(z + 1) * samples + x + 1];
    if (a && b && c) rasterizeTriangle(pixels, depths, width, height, a, c, b);
    if (b && c && d) rasterizeTriangle(pixels, depths, width, height, b, c, d);
  }
  return encodePng(width, height, pixels);
}

function setPixel(pixels: Uint8Array, width: number, height: number, x: number, y: number, color: readonly [number, number, number]): void {
  const roundedX = Math.round(x); const roundedY = Math.round(y);
  if (roundedX < 0 || roundedY < 0 || roundedX >= width || roundedY >= height) return;
  const offset = (roundedY * width + roundedX) * 4;
  pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = 255;
}

function drawLine(pixels: Uint8Array, width: number, height: number, startX: number, startY: number, endX: number, endY: number, color: readonly [number, number, number], thickness = 1): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(endX - startX, endY - startY)));
  for (let step = 0; step <= steps; step += 1) {
    const amount = step / steps;
    const x = startX + (endX - startX) * amount; const y = startY + (endY - startY) * amount;
    for (let offsetY = -thickness; offsetY <= thickness; offsetY += 1) for (let offsetX = -thickness; offsetX <= thickness; offsetX += 1) setPixel(pixels, width, height, x + offsetX, y + offsetY, color);
  }
}

function drawRectangle(pixels: Uint8Array, width: number, height: number, x: number, y: number, boxWidth: number, boxHeight: number, color: readonly [number, number, number]): void {
  drawLine(pixels, width, height, x, y, x + boxWidth, y, color);
  drawLine(pixels, width, height, x + boxWidth, y, x + boxWidth, y + boxHeight, color);
  drawLine(pixels, width, height, x + boxWidth, y + boxHeight, x, y + boxHeight, color);
  drawLine(pixels, width, height, x, y + boxHeight, x, y, color);
}

export interface PlacementDiagnosticAtlas {
  bytes: Uint8Array;
  compositionIds: string[];
  renderedObjects: number;
  maximumProjectionErrorPixels: number;
  maximumTerrainContactErrorMeters: number;
}

/**
 * Builds one bounded atlas proving that generated composition anchors survive
 * the inverse camera projection and retain terrain contact. Yellow rectangles
 * are the requested 2D boxes; green/red crosses are actual 3D anchors.
 */
export async function renderPlacementDiagnosticAtlas(
  bundle: VisualWorldBundle,
  authoring: AuthoringWorld,
  generatedPrototypeIds: ReadonlySet<string>,
): Promise<PlacementDiagnosticAtlas | undefined> {
  const entities = new Map(authoring.entities.map((entity) => [entity.id, entity]));
  const compositions = authoring.regionalCompositions.map((composition) => ({
    ...composition,
    objects: composition.objects.filter((object) => object.entityId && generatedPrototypeIds.has(entities.get(object.entityId)?.prototypeId ?? '')),
  })).filter((composition) => composition.objects.length > 0);
  if (compositions.length === 0) return undefined;
  if (compositions.length > 24) throw new Error('Placement diagnostic supports at most 24 generated regional compositions');
  const tileWidth = 384; const tileHeight = 256; const columns = Math.min(4, compositions.length); const rows = Math.ceil(compositions.length / columns);
  const width = columns * tileWidth; const height = rows * tileHeight;
  const atlas = new Uint8Array(width * height * 4);
  for (let index = 0; index < atlas.length; index += 4) { atlas[index] = 24; atlas[index + 1] = 29; atlas[index + 2] = 37; atlas[index + 3] = 255; }
  let renderedObjects = 0; let maximumProjectionErrorPixels = 0; let maximumTerrainContactErrorMeters = 0;
  const targetColor = [246, 198, 84] as const; const passColor = [48, 222, 132] as const; const failColor = [245, 82, 92] as const;
  for (const [index, composition] of compositions.entries()) {
    const region = bundle.regions.find((candidate) => candidate.id === composition.regionId);
    if (!region) throw new Error(`Placement diagnostic references unknown region ${composition.regionId}`);
    const terrain = renderTerrainReference(bundle, region, composition.camera, tileWidth, tileHeight);
    const { data } = await sharp(terrain).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const tileX = (index % columns) * tileWidth; const tileY = Math.floor(index / columns) * tileHeight;
    for (let y = 0; y < tileHeight; y += 1) {
      const sourceOffset = y * tileWidth * 4; const destinationOffset = ((tileY + y) * width + tileX) * 4;
      atlas.set(data.subarray(sourceOffset, sourceOffset + tileWidth * 4), destinationOffset);
    }
    for (const object of composition.objects) {
      const entity = object.entityId ? entities.get(object.entityId) : undefined;
      if (!entity) continue;
      const projected = project(composition.camera, entity.transform.position, [255, 255, 255], tileWidth, tileHeight);
      if (!projected) continue;
      const targetX = object.screenBox.x / composition.camera.width * tileWidth;
      const targetY = object.screenBox.y / composition.camera.height * tileHeight;
      const boxWidth = object.screenBox.width / composition.camera.width * tileWidth;
      const boxHeight = object.screenBox.height / composition.camera.height * tileHeight;
      const targetAnchorX = targetX + boxWidth / 2; const targetAnchorY = targetY + boxHeight;
      const projectionError = Math.hypot(projected.x - targetAnchorX, projected.y - targetAnchorY);
      const expectedHeight = sampleWorldHeight(bundle, entity.transform.position[0], entity.transform.position[2]);
      const contactError = Math.abs(entity.transform.position[1] - expectedHeight);
      maximumProjectionErrorPixels = Math.max(maximumProjectionErrorPixels, projectionError);
      maximumTerrainContactErrorMeters = Math.max(maximumTerrainContactErrorMeters, contactError);
      const statusColor = projectionError <= 2 && contactError <= 0.01 ? passColor : failColor;
      drawRectangle(atlas, width, height, tileX + targetX, tileY + targetY, boxWidth, boxHeight, targetColor);
      drawLine(atlas, width, height, tileX + targetAnchorX, tileY + targetAnchorY, tileX + projected.x, tileY + projected.y, statusColor);
      drawLine(atlas, width, height, tileX + projected.x - 5, tileY + projected.y, tileX + projected.x + 5, tileY + projected.y, statusColor, 1);
      drawLine(atlas, width, height, tileX + projected.x, tileY + projected.y - 5, tileX + projected.x, tileY + projected.y + 5, statusColor, 1);
      renderedObjects += 1;
    }
    drawRectangle(atlas, width, height, tileX, tileY, tileWidth - 1, tileHeight - 1, [104, 118, 137]);
  }
  if (renderedObjects === 0) throw new Error('Placement diagnostic found no generated composition anchors');
  const bytes = await sharp(atlas, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  return { bytes: Uint8Array.from(bytes), compositionIds: compositions.map((composition) => composition.id), renderedObjects, maximumProjectionErrorPixels, maximumTerrainContactErrorMeters };
}
