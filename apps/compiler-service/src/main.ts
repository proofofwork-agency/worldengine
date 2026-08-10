import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ProviderTermsProfileSchema, type ProviderTermsProfile } from '@worldengine/schema';
import { BlenderWorkerClient, LocalSam2SegmentationAdapter, OpenRouterImageAdapter, OpenRouterPlanningAdapter, ProviderExecutionRegistry, WaveSpeedTripoAdapter, WaveSpeedTripoMultiviewAdapter, providerProfileOperationalIssues, type StudioWorkerRegistry } from '@worldengine/compiler';
import { startCompilerService } from './server.js';

const dataDirectory = resolve(process.env['WORLDENGINE_DATA_DIR'] ?? 'data');
const port = Number(process.env['PORT'] ?? 8787);
const waveSpeedWebhookSecret = process.env['WAVESPEED_WEBHOOK_SECRET'];
const policyPath = process.env['WORLDENGINE_PROVIDER_POLICY_FILE'];
const allowedOrigins = process.env['WORLDENGINE_ALLOWED_ORIGINS']?.split(',').map((origin) => origin.trim()).filter(Boolean);
const providerProfiles: ProviderTermsProfile[] | undefined = policyPath
  ? ProviderTermsProfileSchema.array().parse(JSON.parse(await readFile(resolve(policyPath), 'utf8')))
  : undefined;
const providerRegistry = new ProviderExecutionRegistry();
let configuredAdapters = 0;
for (const profile of providerProfiles ?? []) {
  if (profile.provider === 'openrouter' && process.env['OPENROUTER_API_KEY']) {
    providerRegistry.register(new OpenRouterPlanningAdapter(profile.modelId, profile.revision, process.env['OPENROUTER_API_KEY']));
    configuredAdapters += 1;
  }
  if (profile.provider === 'openrouter-image' && process.env['OPENROUTER_API_KEY']) {
    providerRegistry.register(new OpenRouterImageAdapter(profile.modelId, profile.revision, process.env['OPENROUTER_API_KEY']));
    configuredAdapters += 1;
  }
  if (profile.provider === 'wavespeed' && process.env['WAVESPEED_API_KEY']) {
    if (profile.modelId === 'tripo3d/h3.1/multiview-to-3d') providerRegistry.register(new WaveSpeedTripoMultiviewAdapter(profile.modelId, profile.revision, process.env['WAVESPEED_API_KEY']));
    else providerRegistry.register(new WaveSpeedTripoAdapter(profile.modelId, profile.revision, process.env['WAVESPEED_API_KEY']));
    configuredAdapters += 1;
  }
  if (profile.provider === 'sam2-local' && process.env['WORLDENGINE_SAM2_CHECKPOINT'] && process.env['WORLDENGINE_SAM2_CONFIG']) {
    providerRegistry.register(new LocalSam2SegmentationAdapter(profile.modelId, profile.revision, process.env['WORLDENGINE_PYTHON_EXECUTABLE'] ?? 'python3', resolve(process.env['WORLDENGINE_SAM2_WORKER'] ?? 'workers/sam2/worker.py'), resolve(process.env['WORLDENGINE_SAM2_CHECKPOINT']), process.env['WORLDENGINE_SAM2_CONFIG']));
    configuredAdapters += 1;
  }
}
for (const profile of (providerProfiles ?? []).filter((candidate) => candidate.enabled && candidate.acceptedAt !== null)) {
  const policyIssues = providerProfileOperationalIssues(profile);
  if (policyIssues.length > 0) throw new Error(`Enabled provider ${profile.provider}/${profile.modelId}@${profile.revision} has incomplete policy: ${policyIssues.join(', ')}`);
  const selected = { provider: profile.provider, modelId: profile.modelId, revision: profile.revision };
  if (!providerRegistry.has(selected)) throw new Error(`Enabled provider ${profile.provider}/${profile.modelId}@${profile.revision} has no API credential or adapter`);
  if (profile.provider === 'openrouter') await providerRegistry.requireCapabilities(selected, { structuredOutput: true, imageInput: true });
  else if (profile.provider === 'openrouter-image') await providerRegistry.requireCapabilities(selected, { imageInput: true });
  else if (profile.provider === 'wavespeed' && profile.modelId === 'tripo3d/h3.1/multiview-to-3d') await providerRegistry.requireCapabilities(selected, { imageInput: true, multiImageInput: true, pbr3d: true });
  else if (profile.provider === 'wavespeed') await providerRegistry.requireCapabilities(selected, { imageInput: true });
  else if (profile.provider === 'sam2-local') await providerRegistry.requireCapabilities(selected, { imageInput: true, segmentation: true });
  else throw new Error(`Enabled provider ${profile.provider} has no compiler role`);
}
const studioWorkers: StudioWorkerRegistry = {};
if (process.env['WORLDENGINE_BLENDER_EXECUTABLE']) studioWorkers.blender = new BlenderWorkerClient(process.env['WORLDENGINE_BLENDER_EXECUTABLE'], resolve(process.env['WORLDENGINE_BLENDER_WORKER'] ?? 'workers/blender/worker.py'));
const service = await startCompilerService({
  dataDirectory,
  host: process.env['HOST'] ?? '127.0.0.1',
  port,
  ...(allowedOrigins && allowedOrigins.length > 0 ? { allowedOrigins } : {}),
  ...(waveSpeedWebhookSecret ? { waveSpeedWebhookSecret } : {}),
  ...(providerProfiles ? { providerProfiles } : {}),
  ...(configuredAdapters > 0 ? { providerRegistry } : {}),
  ...(studioWorkers.blender ? { studioWorkers } : {}),
});
console.log(`WorldEngine compiler listening at ${service.origin}`);

const shutdown = async () => {
  await service.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
