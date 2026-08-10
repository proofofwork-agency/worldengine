import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { VertexCountMethod, getPrimitiveVertexCount, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { assertValidGlb } from './asset-validation.js';

export interface MeshLodLevel {
  ratio: number;
  sourceRenderVertices: number;
  renderVertices: number;
  bytes: Uint8Array;
}

export interface MeshLodOptions {
  ratios?: readonly number[];
  errors?: readonly number[];
}

function renderVertexCount(document: Awaited<ReturnType<NodeIO['readBinary']>>): number {
  return document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((meshSum, primitive) => meshSum + getPrimitiveVertexCount(primitive, VertexCountMethod.RENDER), 0), 0);
}

/**
 * Produces independent, content-addressable GLB LOD payloads. The input is
 * reparsed for every level so simplification never compounds between levels.
 */
export async function generateMeshLods(input: Uint8Array, options: MeshLodOptions = {}): Promise<MeshLodLevel[]> {
  assertValidGlb(input);
  const ratios = options.ratios ?? [0.5, 0.2];
  const errors = options.errors ?? [0.01, 0.04];
  if (ratios.length !== errors.length || ratios.length === 0) throw new Error('Mesh LOD ratios and errors must have the same non-zero length');
  for (const [index, ratio] of ratios.entries()) {
    if (!(ratio > 0 && ratio < 1)) throw new Error(`Mesh LOD ratio ${index} must be between zero and one`);
    if (!(errors[index]! >= 0 && errors[index]! <= 1)) throw new Error(`Mesh LOD error ${index} must be between zero and one`);
    if (index > 0 && ratio >= ratios[index - 1]!) throw new Error('Mesh LOD ratios must be strictly decreasing');
  }

  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
  const levels: MeshLodLevel[] = [];
  let previousCount = Number.POSITIVE_INFINITY;
  for (const [index, ratio] of ratios.entries()) {
    const document = await io.readBinary(input);
    if (document.getRoot().listAnimations().length > 0 || document.getRoot().listSkins().length > 0) continue;
    const sourceRenderVertices = renderVertexCount(document);
    if (sourceRenderVertices < 12) continue;
    await document.transform(
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio, error: errors[index]!, lockBorder: false }),
    );
    const lodMaterial = document.createMaterial('worldengine-lod-inherits-base-material');
    for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) primitive.setMaterial(lodMaterial);
    await document.transform(prune());
    const renderVertices = renderVertexCount(document);
    if (renderVertices >= sourceRenderVertices || renderVertices >= previousCount || renderVertices < 3) continue;
    const bytes = await io.writeBinary(document);
    assertValidGlb(bytes);
    levels.push({ ratio, sourceRenderVertices, renderVertices, bytes });
    previousCount = renderVertices;
  }
  return levels;
}
