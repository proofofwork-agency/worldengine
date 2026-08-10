import { read as readKtx2 } from 'ktx-parse';

export interface AssetValidationIssue { code: string; message: string }

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_GENERATED_ASSET_BYTES = 512 * 1024 * 1024;

export function validateGlb(bytes: Uint8Array): AssetValidationIssue[] {
  const issues: AssetValidationIssue[] = [];
  if (bytes.byteLength > MAX_GENERATED_ASSET_BYTES) return [{ code: 'GLB_TOO_LARGE', message: 'GLB exceeds the 512 MB ingestion limit' }];
  if (bytes.byteLength < 20) return [{ code: 'GLB_TOO_SHORT', message: 'GLB is shorter than its mandatory header and JSON chunk' }];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) issues.push({ code: 'GLB_MAGIC', message: 'GLB magic does not equal glTF' });
  if (view.getUint32(4, true) !== 2) issues.push({ code: 'GLB_VERSION', message: 'Only glTF 2.0 GLB assets are supported' });
  if (view.getUint32(8, true) !== bytes.byteLength) issues.push({ code: 'GLB_LENGTH', message: 'GLB declared length does not match downloaded bytes' });
  let offset = 12;
  let json: Record<string, unknown> | undefined;
  let binaryLength = 0;
  let chunkIndex = 0;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + length > bytes.byteLength) { issues.push({ code: 'GLB_CHUNK_RANGE', message: `GLB chunk ${chunkIndex} exceeds the file boundary` }); break; }
    if (chunkIndex === 0 && type !== JSON_CHUNK) issues.push({ code: 'GLB_JSON_FIRST', message: 'The first GLB chunk must be JSON' });
    if (type === JSON_CHUNK) {
      try {
        const text = new TextDecoder().decode(bytes.subarray(offset, offset + length)).replace(/[\u0000\u0020]+$/g, '');
        json = JSON.parse(text) as Record<string, unknown>;
      } catch { issues.push({ code: 'GLB_JSON_INVALID', message: 'GLB JSON chunk is malformed' }); }
    } else if (type === BIN_CHUNK) binaryLength += length;
    else issues.push({ code: 'GLB_CHUNK_TYPE', message: `Unknown GLB chunk type ${type}` });
    offset += length;
    chunkIndex += 1;
  }
  if (offset !== bytes.byteLength) issues.push({ code: 'GLB_TRAILING_BYTES', message: 'GLB contains an incomplete trailing chunk header' });
  if (!json) issues.push({ code: 'GLB_JSON_MISSING', message: 'GLB has no JSON document' });
  else {
    const asset = json['asset'] as { version?: unknown } | undefined;
    if (asset?.version !== '2.0') issues.push({ code: 'GLTF_ASSET_VERSION', message: 'glTF asset.version must be 2.0' });
    const meshes = json['meshes'];
    if (!Array.isArray(meshes) || meshes.length === 0) issues.push({ code: 'GLTF_MESH_MISSING', message: 'Runtime GLB must contain at least one mesh' });
    else if (!(meshes as Array<{ primitives?: unknown }>).some((mesh) => Array.isArray(mesh.primitives) && mesh.primitives.some((primitive) => {
      const attributes = (primitive as { attributes?: Record<string, unknown> }).attributes;
      return attributes && Number.isInteger(attributes['POSITION']);
    }))) issues.push({ code: 'GLTF_PRIMITIVE_MISSING', message: 'Runtime GLB must contain a primitive with POSITION data' });
    for (const collection of ['buffers', 'images'] as const) {
      const entries = json[collection];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as Array<{ uri?: unknown }>) {
        if (typeof entry.uri !== 'string') continue;
        if (!isSafeAssetUri(entry.uri)) issues.push({ code: 'GLTF_UNSAFE_URI', message: `Unsafe ${collection} URI: ${entry.uri}` });
        else if (!entry.uri.startsWith('data:')) issues.push({ code: 'GLTF_EXTERNAL_URI', message: `Runtime GLB must embed ${collection}; external URI is not content-addressed: ${entry.uri}` });
      }
    }
    const buffers = Array.isArray(json['buffers']) ? json['buffers'] as Array<{ byteLength?: unknown; uri?: unknown }> : [];
    if (buffers.length === 0 || typeof buffers[0]?.byteLength !== 'number') issues.push({ code: 'GLTF_BUFFER_MISSING', message: 'Runtime GLB must declare its binary buffer' });
    else if (buffers[0].uri === undefined && buffers[0].byteLength > binaryLength) issues.push({ code: 'GLTF_BUFFER_RANGE', message: 'Declared glTF buffer exceeds the GLB binary chunk' });
    const bufferViews = Array.isArray(json['bufferViews']) ? json['bufferViews'] as Array<{ buffer?: unknown; byteOffset?: unknown; byteLength?: unknown; byteStride?: unknown }> : [];
    bufferViews.forEach((bufferView, index) => {
      const buffer = typeof bufferView.buffer === 'number' ? bufferView.buffer : -1;
      const byteOffset = typeof bufferView.byteOffset === 'number' ? bufferView.byteOffset : 0;
      const byteLength = typeof bufferView.byteLength === 'number' ? bufferView.byteLength : -1;
      const declared = buffers[buffer]?.byteLength;
      if (!Number.isInteger(buffer) || !Number.isInteger(byteOffset) || !Number.isInteger(byteLength) || byteOffset < 0 || byteLength < 0 || typeof declared !== 'number' || byteOffset + byteLength > declared) issues.push({ code: 'GLTF_BUFFER_VIEW_RANGE', message: `bufferView ${index} exceeds its declared buffer` });
    });
    const componentBytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const typeComponents: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
    const accessors = Array.isArray(json['accessors']) ? json['accessors'] as Array<{ bufferView?: unknown; byteOffset?: unknown; componentType?: unknown; count?: unknown; type?: unknown }> : [];
    accessors.forEach((accessor, index) => {
      if (!Number.isInteger(accessor.bufferView) || !Number.isInteger(accessor.componentType) || !Number.isInteger(accessor.count) || typeof accessor.type !== 'string') { issues.push({ code: 'GLTF_ACCESSOR_INVALID', message: `accessor ${index} is incomplete` }); return; }
      const bufferView = bufferViews[accessor.bufferView as number];
      const componentSize = componentBytes[accessor.componentType as number];
      const components = typeComponents[accessor.type];
      const count = accessor.count as number;
      const byteOffset = typeof accessor.byteOffset === 'number' ? accessor.byteOffset : 0;
      if (!bufferView || !componentSize || !components || count < 1 || byteOffset < 0) { issues.push({ code: 'GLTF_ACCESSOR_INVALID', message: `accessor ${index} references invalid storage` }); return; }
      const elementSize = componentSize * components;
      const stride = typeof bufferView.byteStride === 'number' ? bufferView.byteStride : elementSize;
      if (typeof bufferView.byteLength !== 'number' || byteOffset + (count - 1) * stride + elementSize > bufferView.byteLength) issues.push({ code: 'GLTF_ACCESSOR_RANGE', message: `accessor ${index} exceeds its bufferView` });
    });
  }
  return issues;
}

export function assertValidGlb(bytes: Uint8Array): void {
  const issues = validateGlb(bytes);
  if (issues.length > 0) throw new Error(`GLB validation failed: ${issues.map((issue) => `${issue.code}: ${issue.message}`).join('; ')}`);
}

export function validateKtx2(bytes: Uint8Array): AssetValidationIssue[] {
  if (bytes.byteLength < KTX2_IDENTIFIER.length || !KTX2_IDENTIFIER.every((value, index) => bytes[index] === value)) return [{ code: 'KTX2_IDENTIFIER', message: 'Texture does not contain the KTX2 identifier' }];
  if (bytes.byteLength > MAX_GENERATED_ASSET_BYTES) return [{ code: 'KTX2_TOO_LARGE', message: 'KTX2 exceeds the 512 MB ingestion limit' }];
  try {
    const container = readKtx2(bytes);
    const issues: AssetValidationIssue[] = [];
    if (container.pixelWidth < 1 || container.pixelHeight < 1) issues.push({ code: 'KTX2_DIMENSIONS', message: 'KTX2 must have positive 2D dimensions' });
    if (container.faceCount !== 1 && container.faceCount !== 6) issues.push({ code: 'KTX2_FACE_COUNT', message: 'KTX2 face count must be one or six' });
    if (container.levels.length < 1 || container.levels.some((level) => level.levelData.byteLength === 0)) issues.push({ code: 'KTX2_LEVELS', message: 'KTX2 must contain non-empty image levels' });
    if (container.dataFormatDescriptor.length === 0) issues.push({ code: 'KTX2_DFD', message: 'KTX2 is missing its data format descriptor' });
    return issues;
  } catch (error) {
    return [{ code: 'KTX2_STRUCTURE', message: `KTX2 container is malformed: ${(error as Error).message}` }];
  }
}

export function isSafeAssetUri(uri: string): boolean {
  if (/^https?:\/\//i.test(uri)) return true;
  if (/^primitive:\/\/[a-z\d][a-z\d._-]*$/i.test(uri)) return true;
  if (/^data:(?:model\/gltf-binary|application\/octet-stream|image\/(?:png|jpeg|webp|ktx2));base64,[a-z\d+/=]+$/i.test(uri)) return true;
  if (/^[a-z][a-z\d+.-]*:/i.test(uri)) return false;
  if (uri.startsWith('/') || uri.startsWith('\\') || uri.includes('\\')) return false;
  return uri.length > 0 && !uri.split('/').includes('..') && !uri.includes('\0');
}
