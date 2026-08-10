import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { CompileRequestSchema } from '@worldengine/schema';
import { createReferenceBundle, createReferenceDesignSpec } from '@worldengine/terrain';
import { compileLocalWorldArtifacts } from './authoring-compiler.js';
import { referenceCamerasForRegion } from './composition.js';
import { renderPlacementDiagnosticAtlas, renderTerrainReference } from './terrain-reference.js';

describe('terrain-conditioned reference rendering', () => {
  it('renders deterministic PNG bytes from the canonical terrain and known camera', () => {
    const bundle = createReferenceBundle(17);
    const region = bundle.regions[0]!;
    const camera = referenceCamerasForRegion(region, 1)[0]!;
    const first = renderTerrainReference(bundle, region, camera, 192, 128);
    const second = renderTerrainReference(bundle, region, camera, 192, 128);
    expect([...first.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(first.byteLength).toBeGreaterThan(1_000);
    expect(first).toEqual(second);
  });

  it('renders an atlas proving inverse-projected anchors and terrain contact', async () => {
    const spec = createReferenceDesignSpec(29);
    const request = CompileRequestSchema.parse({ prompt: spec.prompt, seed: spec.seed, maxCostUsd: 0, maxAssetGenerations: 0, maxReferenceImages: 0, territory: 'NL', commercialUse: true, dryRun: false, designSpec: spec });
    const artifact = compileLocalWorldArtifacts(request, spec, new Date('2026-08-10T00:00:00.000Z'));
    const generatedIds = new Set(artifact.authoringWorld.prototypes.slice(0, 4).map((prototype) => prototype.id));
    const first = await renderPlacementDiagnosticAtlas(artifact.bundle, artifact.authoringWorld, generatedIds);
    const second = await renderPlacementDiagnosticAtlas(artifact.bundle, artifact.authoringWorld, generatedIds);
    expect(first).toMatchObject({ renderedObjects: 4, maximumProjectionErrorPixels: expect.any(Number), maximumTerrainContactErrorMeters: 0 });
    expect(first!.maximumProjectionErrorPixels).toBeLessThanOrEqual(0.01);
    expect(first!.bytes).toEqual(second!.bytes);
    await expect(sharp(first!.bytes).metadata()).resolves.toMatchObject({ format: 'png', channels: 4 });
  });
});
