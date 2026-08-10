import { NodeIO, type Node } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { assertValidGlb } from './asset-validation.js';

type Vec3 = [number, number, number];

interface PrimitiveRecord {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number>;
  matrix: readonly number[];
  color: [number, number, number];
  vertexCount: number;
  triangleCount: number;
  mode: number;
}

interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  color: [number, number, number];
}

interface ProjectedVertex {
  x: number;
  y: number;
  depth: number;
}

export interface GlbDiagnosticOptions {
  width?: number;
  height?: number;
  maximumInputTriangles?: number;
  maximumRenderedTriangles?: number;
}

export interface GlbDiagnosticRender {
  bytes: Uint8Array;
  inputTriangles: number;
  renderedTriangles: number;
  views: number;
}

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(value: Vec3, amount: number): Vec3 { return [value[0] * amount, value[1] * amount, value[2] * amount]; }
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function length(value: Vec3): number { return Math.hypot(value[0], value[1], value[2]); }
function normalize(value: Vec3): Vec3 { const magnitude = length(value); return magnitude > 0 ? scale(value, 1 / magnitude) : [0, 0, 0]; }
function clampByte(value: number): number { return Math.max(0, Math.min(255, Math.round(value))); }

function transformPoint(matrix: readonly number[], point: Vec3): Vec3 {
  const x = point[0]; const y = point[1]; const z = point[2];
  const w = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
  const inverseW = w === 0 ? 1 : 1 / w;
  return [
    (matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!) * inverseW,
    (matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!) * inverseW,
    (matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!) * inverseW,
  ];
}

function positionAt(record: PrimitiveRecord, index: number): Vec3 {
  const offset = index * 3;
  return transformPoint(record.matrix, [record.positions[offset]!, record.positions[offset + 1]!, record.positions[offset + 2]!]);
}

function sourceIndex(record: PrimitiveRecord, index: number): number {
  return record.indices ? Number(record.indices[index]) : index;
}

function triangleIndices(record: PrimitiveRecord, triangle: number): [number, number, number] {
  if (record.mode === TRIANGLES) {
    const start = triangle * 3;
    return [sourceIndex(record, start), sourceIndex(record, start + 1), sourceIndex(record, start + 2)];
  }
  if (record.mode === TRIANGLE_STRIP) {
    const first = sourceIndex(record, triangle);
    const second = sourceIndex(record, triangle + 1);
    const third = sourceIndex(record, triangle + 2);
    return triangle % 2 === 0 ? [first, second, third] : [second, first, third];
  }
  return [sourceIndex(record, 0), sourceIndex(record, triangle + 1), sourceIndex(record, triangle + 2)];
}

function triangleCount(mode: number, elementCount: number): number {
  if (mode === TRIANGLES) return Math.floor(elementCount / 3);
  if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) return Math.max(0, elementCount - 2);
  return 0;
}

function collectSceneNodes(document: Awaited<ReturnType<NodeIO['readBinary']>>): Node[] {
  const nodes: Node[] = [];
  const visited = new Set<Node>();
  const visit = (node: Node): void => {
    if (visited.has(node)) return;
    visited.add(node);
    nodes.push(node);
    for (const child of node.listChildren()) visit(child);
  };
  for (const scene of document.getRoot().listScenes()) for (const child of scene.listChildren()) visit(child);
  return nodes;
}

function project(point: Vec3, cameraPosition: Vec3, viewportX: number, viewportWidth: number, height: number): ProjectedVertex {
  const forward = normalize(scale(cameraPosition, -1));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  const relative = subtract(point, cameraPosition);
  const size = Math.min(viewportWidth, height) * 0.34;
  return {
    x: viewportX + viewportWidth / 2 + dot(point, right) * size,
    y: height / 2 - dot(point, up) * size,
    depth: dot(relative, forward),
  };
}

function edge(a: ProjectedVertex, b: ProjectedVertex, x: number, y: number): number {
  return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

function rasterize(
  pixels: Uint8Array,
  depths: Float32Array,
  width: number,
  height: number,
  triangle: Triangle,
  camera: Vec3,
  viewportX: number,
  viewportWidth: number,
): boolean {
  const a = project(triangle.a, camera, viewportX, viewportWidth, height);
  const b = project(triangle.b, camera, viewportX, viewportWidth, height);
  const c = project(triangle.c, camera, viewportX, viewportWidth, height);
  const area = edge(a, b, c.x, c.y);
  if (Math.abs(area) < 0.0001) return false;
  const faceNormal = normalize(cross(subtract(triangle.b, triangle.a), subtract(triangle.c, triangle.a)));
  const light = normalize([0.55, 0.82, 0.38]);
  const shade = 0.28 + Math.max(0, dot(faceNormal, light)) * 0.72;
  const color: [number, number, number] = [clampByte(triangle.color[0] * shade), clampByte(triangle.color[1] * shade), clampByte(triangle.color[2] * shade)];
  const minimumX = Math.max(viewportX, Math.floor(Math.min(a.x, b.x, c.x)));
  const maximumX = Math.min(viewportX + viewportWidth - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minimumY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maximumY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  let wrotePixel = false;
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
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = 255;
    wrotePixel = true;
  }
  return wrotePixel;
}

/**
 * Produces deterministic, non-photoreal two-view evidence of the exact GLB
 * bytes supplied to the runtime. This is intentionally a review aid rather
 * than a replacement for Blender-quality offline refinement.
 */
export async function renderGlbDiagnostic(input: Uint8Array, options: GlbDiagnosticOptions = {}): Promise<GlbDiagnosticRender> {
  assertValidGlb(input);
  const width = options.width ?? 1_024;
  const height = options.height ?? 512;
  const maximumInputTriangles = options.maximumInputTriangles ?? 2_000_000;
  const maximumRenderedTriangles = options.maximumRenderedTriangles ?? 250_000;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 256 || width > 2_048 || height < 256 || height > 1_024 || width < height * 1.5) throw new Error('GLB diagnostic dimensions must provide two viewports between 256 and 2048 pixels');
  if (!Number.isInteger(maximumInputTriangles) || !Number.isInteger(maximumRenderedTriangles) || maximumRenderedTriangles < 1 || maximumInputTriangles < maximumRenderedTriangles) throw new Error('GLB diagnostic triangle limits are invalid');

  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  const document = await io.readBinary(input);
  const records: PrimitiveRecord[] = [];
  let inputTriangles = 0;
  let minimum: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  let maximum: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const node of collectSceneNodes(document)) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const mode = primitive.getMode();
      if (mode !== TRIANGLES && mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) continue;
      const accessor = primitive.getAttribute('POSITION');
      const positions = accessor?.getArray();
      if (!accessor || !positions || accessor.getElementSize() !== 3 || accessor.getCount() < 3) continue;
      for (const value of positions) if (!Number.isFinite(Number(value))) throw new Error('GLB diagnostic rejected a non-finite vertex position');
      const indices = primitive.getIndices()?.getArray() ?? undefined;
      if (indices) for (const value of indices) if (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) >= accessor.getCount()) throw new Error('GLB diagnostic rejected an out-of-range triangle index');
      const elements = indices?.length ?? accessor.getCount();
      const count = triangleCount(mode, elements);
      if (count === 0) continue;
      const factor = primitive.getMaterial()?.getBaseColorFactor() ?? [0.46, 0.64, 0.78, 1];
      const color: [number, number, number] = [clampByte(factor[0] * 255), clampByte(factor[1] * 255), clampByte(factor[2] * 255)];
      const record: PrimitiveRecord = { positions, ...(indices ? { indices } : {}), matrix, color, vertexCount: accessor.getCount(), triangleCount: count, mode };
      records.push(record);
      inputTriangles += count;
      if (inputTriangles > maximumInputTriangles) throw new Error(`GLB diagnostic exceeds the ${maximumInputTriangles.toLocaleString()} triangle safety limit`);
      for (let vertex = 0; vertex < record.vertexCount; vertex += 1) {
        const point = positionAt(record, vertex);
        minimum = [Math.min(minimum[0], point[0]), Math.min(minimum[1], point[1]), Math.min(minimum[2], point[2])];
        maximum = [Math.max(maximum[0], point[0]), Math.max(maximum[1], point[1]), Math.max(maximum[2], point[2])];
      }
    }
  }
  if (records.length === 0 || inputTriangles === 0) throw new Error('GLB has no scene-visible triangle geometry for diagnostic review');
  const extent = subtract(maximum, minimum);
  const largestExtent = Math.max(...extent);
  if (!Number.isFinite(largestExtent) || largestExtent <= 0) throw new Error('GLB diagnostic rejected zero-size scene geometry');
  const center = scale(add(minimum, maximum), 0.5);
  const normalization = 2 / largestExtent;
  const triangles: Triangle[] = [];
  const sampleStep = Math.max(1, inputTriangles / maximumRenderedTriangles);
  let nextSample = 0;
  let globalTriangle = 0;
  for (const record of records) for (let localTriangle = 0; localTriangle < record.triangleCount; localTriangle += 1, globalTriangle += 1) {
    if (globalTriangle + 0.5 < nextSample) continue;
    const [a, b, c] = triangleIndices(record, localTriangle);
    triangles.push({
      a: scale(subtract(positionAt(record, a), center), normalization),
      b: scale(subtract(positionAt(record, b), center), normalization),
      c: scale(subtract(positionAt(record, c), center), normalization),
      color: record.color,
    });
    nextSample += sampleStep;
  }

  const pixels = new Uint8Array(width * height * 4);
  const depths = new Float32Array(width * height); depths.fill(Number.POSITIVE_INFINITY);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const checker = ((Math.floor(x / 24) + Math.floor(y / 24)) & 1) * 7;
    const gradient = Math.round((1 - y / height) * 15);
    const offset = (y * width + x) * 4;
    pixels[offset] = 28 + checker + gradient; pixels[offset + 1] = 34 + checker + gradient; pixels[offset + 2] = 43 + checker + gradient; pixels[offset + 3] = 255;
  }
  const divider = Math.floor(width / 2);
  for (let y = 0; y < height; y += 1) {
    const offset = (y * width + divider) * 4;
    pixels[offset] = 88; pixels[offset + 1] = 98; pixels[offset + 2] = 112;
  }
  const cameras: Vec3[] = [[2.6, 1.65, 2.6], [-2.6, 1.45, -2.6]];
  let visibleTriangles = 0;
  for (const [view, camera] of cameras.entries()) {
    const viewportX = view === 0 ? 0 : divider + 1;
    const viewportWidth = view === 0 ? divider : width - divider - 1;
    for (const triangle of triangles) if (rasterize(pixels, depths, width, height, triangle, camera, viewportX, viewportWidth)) visibleTriangles += 1;
  }
  if (visibleTriangles === 0) throw new Error('GLB diagnostic produced no visible triangle pixels');
  const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  return { bytes: Uint8Array.from(bytes), inputTriangles, renderedTriangles: triangles.length, views: cameras.length };
}
