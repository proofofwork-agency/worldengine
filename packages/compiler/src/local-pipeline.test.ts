import { describe, expect, it } from 'vitest';
import { CompileRequestSchema, PrototypeIdSchema, WorldDesignSpecSchema } from '@worldengine/schema';
import { createReferenceDesignSpec, generateReferenceChunk, sampleWorldHeight } from '@worldengine/terrain';
import { compileLocalWorldArtifacts } from './authoring-compiler.js';
import { referenceCamerasForRegion } from './composition.js';
import { planLocalWorldDesign } from './local-planner.js';
import { DeterministicWorldCompiler } from './pipeline.js';
import { applyCanonicalPatch } from './patching.js';
import { validateWorldAcceptance } from './validation.js';

function request(overrides: Record<string, unknown> = {}) {
  return CompileRequestSchema.parse({ prompt: 'A coastal valley with a river, road, old forest, and village at dusk', seed: 91, maxCostUsd: 0, maxAssetGenerations: 0, territory: 'NL', commercialUse: true, dryRun: true, ...overrides });
}

describe('local canonical compiler pipeline', () => {
  it('derives theme, explicit environment, and only prompt-supported vector features', () => {
    const spec = planLocalWorldDesign(request({ prompt: 'A stylized desert caravan road beneath the night sky' }));
    expect(spec.title).toBe('The Ember Expanse');
    expect(spec.style.description).toContain('Stylized');
    expect(spec.environment.timeOfDay).toBe(23);
    expect(spec.features.map((feature) => feature.kind)).toEqual(['road']);
    expect(spec.regions.map((region) => region.biome)).toContain('dunes');
    expect(spec.defaultsApplied).toContain('five-region vector topology because no structured designSpec was supplied');
  });

  it('uses a supplied structured design spec without replacing its intent', () => {
    const supplied = WorldDesignSpecSchema.parse({ ...createReferenceDesignSpec(91), title: 'Operator-authored world', prompt: 'structured', defaultsApplied: [] });
    const planned = planLocalWorldDesign(request({ prompt: 'this prompt must not replace the spec', designSpec: supplied }));
    expect(planned).toEqual(supplied);
  });

  it('matches supplied landmarks to semantic prototypes and corrects their terrain contact', () => {
    const spec = createReferenceDesignSpec(91);
    const artifact = compileLocalWorldArtifacts(request({ designSpec: spec }), spec, new Date('2026-08-10T00:00:00.000Z'));
    const landmarks = artifact.authoringWorld.entities.filter((entity) => entity.visualState['landmark'] === true);
    const prototypes = new Map(artifact.authoringWorld.prototypes.map((prototype) => [prototype.id, prototype.tags]));
    expect(landmarks.map((entity) => prototypes.get(entity.prototypeId)?.[0])).toEqual(['ruin-wall', 'watchtower', 'bridge']);
    for (const landmark of landmarks) expect(landmark.transform.position[1]).toBeCloseTo(sampleWorldHeight(artifact.bundle, landmark.transform.position[0], landmark.transform.position[2]), 5);
  });

  it('builds editable entities and a feature-conditioned optimized runtime bundle', () => {
    const compileRequest = request();
    const spec = planLocalWorldDesign(compileRequest);
    const artifact = compileLocalWorldArtifacts(compileRequest, spec, new Date('2026-08-10T00:00:00.000Z'));
    expect(artifact.authoringWorld.entities).toHaveLength(5_140);
    expect(artifact.authoringWorld.entities.filter((entity) => entity.visualState['compositionPlaced'] === true)).toHaveLength(20);
    expect(artifact.authoringWorld.regionalCompositions).toHaveLength(5);
    expect(artifact.authoringWorld.regionalCompositions.flatMap((composition) => composition.objects)).toHaveLength(20);
    expect(artifact.authoringWorld.regionalCompositions.flatMap((composition) => composition.objects).every((object) => object.screenBox.height > 0 && object.entityId)).toBe(true);
    for (const composition of artifact.authoringWorld.regionalCompositions) {
      const canonical = referenceCamerasForRegion(spec.regions.find((candidate) => candidate.id === composition.regionId)!, 1)[0]!;
      expect(composition.camera).toEqual(canonical);
    }
    expect(artifact.authoringWorld.prototypes).toHaveLength(20);
    expect(artifact.bundle.chunks).toHaveLength(256);
    expect(artifact.bundle.regions).toHaveLength(5);
    expect(artifact.bundle.features.map((feature) => feature.kind).sort()).toEqual(['coastline', 'river', 'road']);
    expect(artifact.bundle.optimization).toMatchObject({ instanceGroups: true, occlusionMetadata: true, terrainLodSamples: [65, 33, 17] });
    expect(validateWorldAcceptance(artifact.designSpec, artifact.authoringWorld, artifact.bundle).filter((issue) => issue.severity === 'error')).toEqual([]);
    const first = artifact.authoringWorld.entities[0]!;
    const belowTerrain = { ...artifact.authoringWorld, entities: [{ ...first, transform: { ...first.transform, position: [first.transform.position[0], first.transform.position[1] - 50, first.transform.position[2]] as [number, number, number] } }, ...artifact.authoringWorld.entities.slice(1)] };
    expect(validateWorldAcceptance(artifact.designSpec, belowTerrain, artifact.bundle).map((issue) => issue.code)).toContain('ACCEPTANCE_BELOW_TERRAIN');
    const chunk = generateReferenceChunk(artifact.bundle, { x: 0, z: 0 }, { samples: 17 });
    expect(chunk.occlusionCells).toHaveLength(16);
    expect(chunk.terrain.biomeWeights).toBeTruthy();
    for (const instance of chunk.instances) expect(instance.matrix[13]).toBeCloseTo(sampleWorldHeight(artifact.bundle, instance.matrix[12], instance.matrix[14]), 5);
  });

  it('prefers a reviewed, rights-affirmed library asset and preserves provenance', () => {
    const spec = WorldDesignSpecSchema.parse({ ...createReferenceDesignSpec(91), assetRequirements: [{ class: 'oak', count: 1, sourcePreference: ['library', 'cache', 'generate'], tags: ['forest'] }] });
    const assetId = PrototypeIdSchema.parse('licensed-oak');
    const compileRequest = request({ designSpec: spec, assetLibrary: [{
      id: assetId, class: 'oak', assetUri: 'assets/licensed-oak.glb', contentHash: 'a'.repeat(64), boundsRadius: 4, lods: [{ distance: 80, assetUri: 'assets/licensed-oak-lod1.glb', contentHash: 'b'.repeat(64), provenanceId: 'provenance-licensed-oak-lod1' }],
      materialVariants: ['summer'], animationClips: ['wind'], tags: ['forest'], rightsAffirmed: true,
      provenance: { id: 'provenance-licensed-oak', subjectId: assetId, kind: 'imported', sourceUri: 'https://assets.test/oak', license: { name: 'Licensed commercial catalog', commercialUse: true }, createdAt: '2026-08-01T00:00:00.000Z', contentHash: 'a'.repeat(64), parentIds: [], reviewedAt: '2026-08-02T00:00:00.000Z' },
      lodProvenance: [{ id: 'provenance-licensed-oak-lod1', subjectId: `${assetId}:lod:1`, kind: 'edited', sourceUri: 'https://assets.test/oak-lod1', license: { name: 'Licensed commercial catalog', commercialUse: true }, createdAt: '2026-08-01T00:00:00.000Z', contentHash: 'b'.repeat(64), parentIds: ['provenance-licensed-oak'], reviewedAt: '2026-08-02T00:00:00.000Z' }],
    }] });
    const artifact = compileLocalWorldArtifacts(compileRequest, spec, new Date('2026-08-10T00:00:00.000Z'));
    expect(artifact.bundle.prototypes).toEqual([expect.objectContaining({ id: assetId, assetUri: 'assets/licensed-oak.glb', lods: [{ distance: 80, assetUri: 'assets/licensed-oak-lod1.glb', contentHash: 'b'.repeat(64), provenanceId: 'provenance-licensed-oak-lod1' }] })]);
    expect(artifact.bundle.provenance).toEqual(expect.arrayContaining([expect.objectContaining({ subjectId: assetId, kind: 'imported' }), expect.objectContaining({ id: 'provenance-licensed-oak-lod1', kind: 'edited' })]));
  });

  it('rejects a reviewed library entry whose provenance is bound to different bytes', () => {
    const spec = WorldDesignSpecSchema.parse({ ...createReferenceDesignSpec(91), assetRequirements: [{ class: 'oak', count: 1, sourcePreference: ['library'], tags: [] }] });
    const assetId = PrototypeIdSchema.parse('mismatched-oak');
    expect(() => request({ designSpec: spec, assetLibrary: [{
      id: assetId, class: 'oak', assetUri: 'assets/mismatched-oak.glb', contentHash: 'a'.repeat(64), boundsRadius: 4, rightsAffirmed: true,
      provenance: { id: 'provenance-mismatched-oak', subjectId: assetId, kind: 'imported', license: { name: 'Reviewed license', commercialUse: true }, createdAt: '2026-08-01T00:00:00.000Z', contentHash: 'b'.repeat(64), parentIds: [], reviewedAt: '2026-08-02T00:00:00.000Z' },
    }] })).toThrow('asset provenance content hash');
  });

  it('emits all three canonical artifacts from the public compiler', async () => {
    const events = [];
    for await (const event of new DeterministicWorldCompiler().compile(request({ prompt: 'A frozen river valley beneath snow' }), 'canonical-artifacts')) events.push(event);
    const artifact = events.find((event) => event.type === 'artifact');
    expect(artifact?.data['designSpec']).toMatchObject({ format: 'WorldDesignSpec', title: 'The Frostbound Reach' });
    expect(artifact?.data['authoringWorld']).toMatchObject({ format: 'AuthoringWorld' });
    expect(artifact?.data['bundle']).toMatchObject({ format: 'VisualWorldBundle', regions: expect.any(Array) });
    expect(events.at(-1)?.type).toBe('completed');
  });

  it('materializes public regeneration patches and explicit sparse chunks', async () => {
    const compileRequest = request();
    const spec = planLocalWorldDesign(compileRequest);
    const artifact = compileLocalWorldArtifacts(compileRequest, spec, new Date('2026-08-10T00:00:00.000Z'));
    const compiler = new DeterministicWorldCompiler();
    const regeneration = [];
    for await (const event of compiler.regenerate({
      worldId: artifact.bundle.worldId, baseRevision: artifact.bundle.sourceRevision, prompt: 'dense frozen forest', regionIds: [spec.regions[0]!.id],
      maxCostUsd: 0, maxAssetGenerations: 0, designSpec: spec, bundle: artifact.bundle,
    }, 'public-regenerate')) regeneration.push(event);
    expect(regeneration.find((event) => event.type === 'artifact')?.data['patch']).toMatchObject({ operations: expect.arrayContaining([expect.objectContaining({ op: 'replace-region', region: expect.objectContaining({ biome: 'frozen-tundra' }) })]) });
    expect(regeneration.at(-1)?.type).toBe('completed');

    const chunks = [];
    for await (const event of compiler.requestChunk({ worldId: artifact.bundle.worldId, x: 9, z: -11, maxCostUsd: 0, maxAssetGenerations: 0, explicit: true, bundle: artifact.bundle }, 'public-chunk')) chunks.push(event);
    expect(chunks.find((event) => event.type === 'artifact')?.data['chunk']).toMatchObject({ id: '9:-11', placeholder: false, terrain: { samples: 257 } });
    expect(chunks.at(-1)?.type).toBe('completed');
  });

  it('turns authoring edits into revisioned runtime overrides and terrain metadata', () => {
    const compileRequest = request();
    const spec = planLocalWorldDesign(compileRequest);
    const artifact = compileLocalWorldArtifacts(compileRequest, spec, new Date('2026-08-10T00:00:00.000Z'));
    const entity = artifact.authoringWorld.entities[0]!;
    const region = artifact.designSpec.regions[0]!;
    const next = applyCanonicalPatch(artifact.designSpec, artifact.authoringWorld, artifact.bundle, {
      id: 'authoring-patch-1' as never,
      worldId: artifact.bundle.worldId,
      baseRevision: 0,
      createdAt: '2026-08-10T00:01:00.000Z',
      author: 'test',
      operations: [
        { op: 'set-transform', entityId: entity.id, transform: { position: [12, 34, 56], rotation: [0, 0, 0, 1], scale: [2, 2, 2] } },
        { op: 'replace-region', region: { ...region, biome: 'regenerated-forest', description: 'Prompt-regenerated regional intent' } },
        { op: 'set-region-density', regionId: region.id, density: 0.11 },
        { op: 'add-terrain-edit', center: [0, 0], radius: 80, delta: 5 },
        { op: 'set-environment', values: { weather: 'rain', timeOfDay: 20 } },
      ],
    }, new Date('2026-08-10T00:01:00.000Z'));
    expect(next.authoringWorld).toMatchObject({ revision: 1, appliedPatchIds: ['authoring-patch-1'] });
    expect(next.bundle).toMatchObject({ bundleVersion: 2, sourceRevision: 1, environment: { weather: 'rain', timeOfDay: 20 } });
    expect(next.bundle.authoredInstances.find((instance) => instance.id === entity.id)?.matrix.slice(12, 15)).toEqual([12, 34, 56]);
    expect(next.bundle.terrain?.edits).toContainEqual({ center: [0, 0], radius: 80, delta: 5, mode: 'add' });
    expect(next.bundle.regions.find((candidate) => candidate.id === region.id)?.density).toBe(0.11);
    expect(next.designSpec.regions.find((candidate) => candidate.id === region.id)).toMatchObject({ biome: 'regenerated-forest', description: 'Prompt-regenerated regional intent' });
    expect(next.invalidatesDetailedChunks).toBe(true);
  });
});
