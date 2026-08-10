export function encodeFloat32(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + stride, bytes.length)));
  }
  return btoa(binary);
}

export function decodeFloat32(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength % 4 !== 0) throw new Error('Invalid float32 payload length');
  return new Float32Array(bytes.buffer);
}

export function encodeUint8(values: Uint8Array): string {
  let binary = '';
  const stride = 0x8000;
  for (let offset = 0; offset < values.length; offset += stride) {
    binary += String.fromCharCode(...values.subarray(offset, Math.min(offset + stride, values.length)));
  }
  return btoa(binary);
}

export function decodeUint8(encoded: string, expectedLength?: number): Uint8Array {
  const binary = atob(encoded);
  if (expectedLength !== undefined && binary.length !== expectedLength) throw new Error(`Invalid uint8 payload length: expected ${expectedLength}, received ${binary.length}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
