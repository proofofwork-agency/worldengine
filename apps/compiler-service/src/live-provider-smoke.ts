import type { ProviderRole, QualityProfile } from '@worldengine/schema';

interface ProviderStatus { provider: string; modelId: string; revision: string; termsFingerprint: string; operational: boolean; configured: boolean }
interface Health { generation?: { blenderWorker: string; qualityProfiles?: Record<string, { available: boolean; issue?: string }>; providers: ProviderStatus[] } }

const flag = (name: string) => process.argv.includes(name);
const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const profile = (argument('--profile') ?? 'cheap') as QualityProfile;
if (profile !== 'cheap' && profile !== 'studio') throw new Error('Live provider smoke supports --profile cheap or studio');
const execute = flag('--execute');
if (execute && process.env['WORLDENGINE_LIVE_PROVIDER_TEST'] !== 'I_ACCEPT_BILLABLE_PROVIDER_CALLS') throw new Error('Set WORLDENGINE_LIVE_PROVIDER_TEST=I_ACCEPT_BILLABLE_PROVIDER_CALLS to authorize the billable smoke test');
const origin = (argument('--origin') ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const hardMaximum = profile === 'cheap' ? 15 : 100;
const maxCostUsd = Number(argument('--max-cost-usd') ?? (profile === 'cheap' ? 5 : 25));
if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > hardMaximum) throw new Error(`--max-cost-usd must be greater than zero and no more than ${hardMaximum}`);
const healthResponse = await fetch(`${origin}/health`);
if (!healthResponse.ok) throw new Error(`Compiler health failed: ${healthResponse.status}`);
const health = await healthResponse.json() as Health;
const ready = health.generation?.providers.filter((item) => item.operational && item.configured) ?? [];
const provider = (name: string) => ready.find((item) => item.provider === name) ?? (() => { throw new Error(`Reviewed, configured provider ${name} is unavailable`); })();
const studioMeshProvider = () => ready.find((item) => item.provider === 'wavespeed' && item.modelId === 'tripo3d/h3.1/multiview-to-3d') ?? (() => { throw new Error('Reviewed, configured WaveSpeed Tripo H3.1 multiview provider is unavailable'); })();
const imageProvider = ready.find((item) => item.provider === 'openrouter-image' && item.modelId === 'openai/gpt-image-2') ?? (() => { throw new Error('Reviewed, configured OpenRouter openai/gpt-image-2 image provider is unavailable'); })();
if (profile === 'studio' && health.generation?.qualityProfiles?.['studio']?.available !== true) throw new Error(`Studio worker unavailable: ${health.generation?.qualityProfiles?.['studio']?.issue ?? health.generation?.blenderWorker ?? 'unknown'}`);
const selections: Array<{ status: ProviderStatus; role: ProviderRole }> = profile === 'cheap' ? [
  { status: provider('openrouter'), role: 'planner' }, { status: provider('openrouter'), role: 'reviewer' },
  { status: imageProvider, role: 'composition-image' }, { status: provider('wavespeed'), role: 'image-to-3d' },
] : [
  { status: provider('openrouter'), role: 'planner' }, { status: provider('openrouter'), role: 'reviewer' }, { status: provider('openrouter'), role: 'object-detection' },
  { status: imageProvider, role: 'composition-image' }, { status: imageProvider, role: 'multiview-image' },
  { status: provider('sam2-local'), role: 'segmentation' }, { status: studioMeshProvider(), role: 'image-to-3d' },
];
const providerModels = selections.map(({ status, role }) => ({ provider: status.provider, modelId: status.modelId, revision: status.revision, termsFingerprint: status.termsFingerprint, role }));
const response = await fetch(`${origin}/v1/compiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  prompt: profile === 'studio' ? 'A compact tropical pirate cove with one dock and one weathered watchtower.' : 'A compact forest clearing with one ancient oak.',
  seed: 90210, qualityProfile: profile, heroRegionIds: ['region-1-western-coast'], maxCostUsd, maxAssetGenerations: 1, maxReferenceImages: 1,
  territory: argument('--territory') ?? 'NL', commercialUse: true, dryRun: !execute, providerModels,
  refinementPolicy: profile === 'studio' ? { maxTerrainRounds: 3, maxCompositionAttempts: 3, maxAssetAttempts: 2, maxSceneRounds: 3, maxAssetRepairRounds: 2, maxSceneRepairRounds: 1, terrainCoDeformation: true } : { maxTerrainRounds: 0, maxCompositionAttempts: 1, maxAssetAttempts: 1, maxSceneRounds: 0, maxAssetRepairRounds: 0, maxSceneRepairRounds: 0, terrainCoDeformation: false },
}) });
if (!response.ok) throw new Error(`Compiler rejected smoke test: ${response.status} ${await response.text()}`);
const { compileId, events } = await response.json() as { compileId: string; events: string };
console.log(JSON.stringify({ compileId, profile, execute, maxCostUsd, events: `${origin}${events}` }, null, 2));
const stream = await fetch(`${origin}${events}`);
const body = await stream.text();
if (!body.includes('event: completed')) throw new Error(`Smoke test did not complete:\n${body.slice(-4_000)}`);
console.log(execute ? 'LIVE_PROVIDER_SMOKE_PASSED' : 'DRY_RUN_PROVIDER_GATE_PASSED');
