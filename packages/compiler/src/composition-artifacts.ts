import sharp from 'sharp';

export interface CropAffineTransform {
  compositionToCrop: [number, number, number, number, number, number];
  cropToComposition: [number, number, number, number, number, number];
  sourceBox: { x: number; y: number; width: number; height: number };
}

export function createCropAffine(box: { x: number; y: number; width: number; height: number }, imageWidth: number, imageHeight: number, padding = 0.08): CropAffineTransform {
  const padX = box.width * padding; const padY = box.height * padding;
  const x = Math.max(0, Math.floor(box.x - padX)); const y = Math.max(0, Math.floor(box.y - padY));
  const right = Math.min(imageWidth, Math.ceil(box.x + box.width + padX)); const bottom = Math.min(imageHeight, Math.ceil(box.y + box.height + padY));
  const sourceBox = { x, y, width: right - x, height: bottom - y };
  if (sourceBox.width <= 0 || sourceBox.height <= 0) throw new Error('Object crop lies outside its source image');
  return { compositionToCrop: [1, 0, 0, 1, -x, -y], cropToComposition: [1, 0, 0, 1, x, y], sourceBox };
}

export function mapAffinePoint(matrix: CropAffineTransform['compositionToCrop'], point: readonly [number, number]): [number, number] {
  return [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]];
}

export async function createLosslessAlphaCrop(imageBytes: Uint8Array, maskBytes: Uint8Array, box: { x: number; y: number; width: number; height: number }, width: number, height: number): Promise<{ bytes: Uint8Array; transform: CropAffineTransform }> {
  const transform = createCropAffine(box, width, height);
  const image = await sharp(imageBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(maskBytes).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (image.info.width !== width || image.info.height !== height || mask.info.width !== width || mask.info.height !== height) throw new Error('Composition or mask dimensions do not match the calibrated camera');
  const { x, y, width: cropWidth, height: cropHeight } = transform.sourceBox;
  const crop = new Uint8Array(cropWidth * cropHeight * 4);
  for (let row = 0; row < cropHeight; row += 1) for (let column = 0; column < cropWidth; column += 1) {
    const sourceIndex = (y + row) * width + x + column; const destination = (row * cropWidth + column) * 4; const source = sourceIndex * 4;
    crop[destination] = image.data[source]!; crop[destination + 1] = image.data[source + 1]!; crop[destination + 2] = image.data[source + 2]!; crop[destination + 3] = mask.data[sourceIndex]!;
  }
  const png = await sharp(crop, { raw: { width: cropWidth, height: cropHeight, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  return { bytes: Uint8Array.from(png), transform };
}
