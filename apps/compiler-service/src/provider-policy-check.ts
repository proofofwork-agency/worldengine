import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderTermsProfileSchema, type QualityProfile } from '@worldengine/schema';
import { providerProfileOperationalIssues } from '@worldengine/compiler';

const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(serviceDirectory, '../..');
const requestedPolicyPath = argument('--policy') ?? process.env['WORLDENGINE_PROVIDER_POLICY_FILE'];
const requestedCandidates = requestedPolicyPath ? [resolve(requestedPolicyPath), resolve(serviceDirectory, requestedPolicyPath), resolve(repositoryRoot, requestedPolicyPath)] : [];
const policyPath = requestedCandidates.find(existsSync)
  ?? (existsSync(resolve(repositoryRoot, '.worldengine/provider-policy.json')) ? resolve(repositoryRoot, '.worldengine/provider-policy.json') : resolve(serviceDirectory, 'provider-policy.example.json'));
const profile = (argument('--profile') ?? 'studio') as QualityProfile;
if (!['local', 'cheap', 'studio'].includes(profile)) throw new Error('--profile must be local, cheap, or studio');
const policies = ProviderTermsProfileSchema.array().parse(JSON.parse(await readFile(policyPath, 'utf8')));
const identities = policies.map((item) => `${item.provider.toLowerCase()}::${item.modelId.toLowerCase()}::${item.revision}`);
if (new Set(identities).size !== identities.length) throw new Error('Provider policy contains duplicate provider/model/revision identities');
const operational = policies.filter((item) => providerProfileOperationalIssues(item).length === 0);
const providers = new Set(operational.map((item) => item.provider.toLowerCase()));
const required = profile === 'cheap' ? ['openrouter', 'wavespeed'] : profile === 'studio' ? ['openrouter', 'sam2-local'] : [];
const missing = required.filter((provider) => !providers.has(provider));
if (profile !== 'local' && !providers.has('openrouter-image')) missing.push('openrouter-image');
if (profile === 'studio' && !operational.some((item) => item.provider.toLowerCase() === 'openrouter-image' && item.modelId.toLowerCase() === 'openai/gpt-image-2')) missing.push('openrouter-openai-gpt-image-2');
if (profile === 'studio' && !operational.some((item) => item.provider.toLowerCase() === 'wavespeed' && item.modelId.toLowerCase() === 'tripo3d/h3.1/multiview-to-3d')) missing.push('wavespeed-tripo-h3.1-multiview');
const report = {
  policyPath, profile, ready: missing.length === 0, missing,
  profiles: policies.map((item) => ({ provider: item.provider, modelId: item.modelId, revision: item.revision, operational: providerProfileOperationalIssues(item).length === 0, issues: providerProfileOperationalIssues(item), territories: item.permittedTerritories, commercialUse: item.commercialUse, unitCostUsd: item.cost.usd })),
};
console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exitCode = 1;
