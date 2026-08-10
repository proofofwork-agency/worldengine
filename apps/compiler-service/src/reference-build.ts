import { resolve } from 'node:path';
import { CompileRequestSchema } from '@worldengine/schema';
import { compileLocalWorldArtifacts, FileWorldStorage, materializeBundleChunks } from '@worldengine/compiler';
import { createReferenceDesignSpec } from '@worldengine/terrain';

const output = resolve(process.argv[2] ?? 'data/reference');
const designSpec = createReferenceDesignSpec();
const request = CompileRequestSchema.parse({
  prompt: designSpec.prompt,
  seed: designSpec.seed,
  maxCostUsd: 0,
  maxAssetGenerations: 0,
  maxReferenceImages: 0,
  territory: 'NL',
  commercialUse: true,
  dryRun: false,
  designSpec,
  assetLibrary: [],
  providerModels: [],
});
const artifacts = compileLocalWorldArtifacts(request, designSpec, new Date('2026-08-10T00:00:00.000Z'));
const storage = new FileWorldStorage(output);
const designPath = await storage.putDesignSpec(artifacts.bundle.worldId, artifacts.bundle.bundleVersion, artifacts.designSpec);
const authoringPath = await storage.putAuthoringWorld(artifacts.bundle.worldId, artifacts.bundle.bundleVersion, artifacts.authoringWorld);
console.log(`Materializing ${artifacts.bundle.chunks.length} canonical ${artifacts.bundle.terrainSamples}×${artifacts.bundle.terrainSamples} chunks...`);
const materialized = await materializeBundleChunks(artifacts.bundle, storage, {
  concurrency: 2,
  rowsPerTask: 8,
  onProgress: ({ completed, total, bytesWritten }) => {
    if (completed % 16 === 0 || completed === total) console.log(`${completed}/${total} chunks · ${(bytesWritten / 1024 / 1024).toFixed(1)} MiB`);
  },
});
const bundlePath = await storage.putBundle(materialized);
console.log(`Reference canonical artifacts written:\n${designPath}\n${authoringPath}\n${bundlePath}`);
