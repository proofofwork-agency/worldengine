import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { listTextureSlots } from '@gltf-transform/functions';
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp from 'sharp';
import { assertValidGlb, validateKtx2 } from './asset-validation.js';

export interface TextureOptimizationOptions {
  maxDimension?: number;
  uastcQuality?: 0 | 1 | 2 | 3;
  rdoQuality?: number;
}

export interface TextureOptimizationResult {
  bytes: Uint8Array;
  textureFormat: 'ktx2' | 'source' | 'none';
  textureCount: number;
  convertedTextures: number;
  sourceTextureBytes: number;
  optimizedTextureBytes: number;
}

const supportedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const colorSlots = new Set(['baseColorTexture', 'emissiveTexture', 'sheenColorTexture', 'specularColorTexture']);

/**
 * Converts embedded glTF textures to mipmapped Basis Universal UASTC KTX2.
 * Color and data textures receive different transfer-function settings, and
 * normal maps use the encoder's normal-map preset. The source GLB is returned
 * unchanged when it has no convertible textures.
 */
export async function transcodeGlbTexturesToKtx2(input: Uint8Array, options: TextureOptimizationOptions = {}): Promise<TextureOptimizationResult> {
  assertValidGlb(input);
  const maxDimension = Math.max(64, Math.min(8_192, Math.floor(options.maxDimension ?? 2_048)));
  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  const document = await io.readBinary(input);
  const textures = document.getRoot().listTextures();
  let convertedTextures = 0;
  let sourceTextureBytes = 0;
  let optimizedTextureBytes = 0;
  let sourceTextures = 0;

  for (const texture of textures) {
    const image = texture.getImage();
    if (!image) { sourceTextures += 1; continue; }
    sourceTextureBytes += image.byteLength;
    if (texture.getMimeType() === 'image/ktx2') {
      const issues = validateKtx2(image);
      if (issues.length > 0) throw new Error(`Existing KTX2 texture is invalid: ${issues.map((issue) => issue.message).join('; ')}`);
      optimizedTextureBytes += image.byteLength;
      continue;
    }
    if (!supportedMimeTypes.has(texture.getMimeType())) { sourceTextures += 1; optimizedTextureBytes += image.byteLength; continue; }

    const slots = listTextureSlots(texture);
    const isNormalMap = slots.includes('normalTexture');
    const isPerceptual = slots.some((slot) => colorSlots.has(slot));
    const encoded = await encodeToKTX2(image, {
      isUASTC: true,
      needSupercompression: true,
      generateMipmap: true,
      enableRDO: true,
      rdoQualityLevel: Math.max(0.01, Math.min(10, options.rdoQuality ?? 1)),
      uastcLDRQualityLevel: options.uastcQuality ?? 2,
      isNormalMap,
      isPerceptual,
      isSetKTX2SRGBTransferFunc: isPerceptual,
      imageDecoder: async (buffer) => {
        const decoded = await sharp(buffer, { limitInputPixels: 268_402_689 })
          // Preserve encoded pixel orientation: glTF UVs, not EXIF metadata,
          // are authoritative for how a material samples its texture.
          .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { data: Uint8Array.from(decoded.data), width: decoded.info.width, height: decoded.info.height };
      },
    });
    const issues = validateKtx2(encoded);
    if (issues.length > 0) throw new Error(`Basis encoder returned invalid KTX2: ${issues.map((issue) => issue.message).join('; ')}`);
    texture.setImage(encoded).setMimeType('image/ktx2').setURI('');
    convertedTextures += 1;
    optimizedTextureBytes += encoded.byteLength;
  }

  if (convertedTextures === 0) {
    return {
      bytes: input,
      textureFormat: textures.length === 0 ? 'none' : sourceTextures === 0 ? 'ktx2' : 'source',
      textureCount: textures.length,
      convertedTextures,
      sourceTextureBytes,
      optimizedTextureBytes,
    };
  }

  document.createExtension(KHRTextureBasisu).setRequired(true);
  const bytes = await io.writeBinary(document);
  assertValidGlb(bytes);
  return {
    bytes,
    textureFormat: sourceTextures === 0 ? 'ktx2' : 'source',
    textureCount: textures.length,
    convertedTextures,
    sourceTextureBytes,
    optimizedTextureBytes,
  };
}
