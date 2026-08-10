import {
  QUALITY_DIMENSION_WEIGHTS,
  QualityCertificationSchema,
  type ProviderRole,
  type QualityCertification,
  type QualityDimension,
  type QualityProfile,
} from '@worldengine/schema';

export const PAPER_DERIVED_BENCHMARK_SCENARIOS = [
  { id: 'snow-future-valley', title: 'Snowy futuristic valley' },
  { id: 'tropical-pirate-island', title: 'Tropical pirate island' },
  { id: 'river-canyon-settlement', title: 'River canyon settlement' },
  { id: 'desert-battlefield', title: 'Desert battlefield' },
  { id: 'medieval-fantasy-valley', title: 'Medieval fantasy valley' },
] as const;

export interface QualityBenchmarkInput {
  benchmarkId: string;
  qualityProfile: QualityProfile;
  targetScore?: number;
  dimensionScores: Record<QualityDimension, { score: number; evidenceIds?: string[]; notes?: string[] }>;
  hardGates: Array<{ id: string; passed: boolean; message: string; evidenceIds?: string[] }>;
  scenarios: Array<{ id: string; score: number; evidenceIds?: string[] }>;
  raterCount: number;
  raterAgreement: number;
  evidenceIds?: string[];
  providers?: Array<{ role: ProviderRole; provider: string; modelId: string; revision: string; termsFingerprint: string }>;
  attempts?: QualityCertification['attempts'];
  actualCostUsd: number;
  durationMs: number;
  createdAt?: string;
}

export function createQualityCertification(input: QualityBenchmarkInput): QualityCertification {
  const targetScore = input.targetScore ?? 90;
  const dimensions = (Object.keys(QUALITY_DIMENSION_WEIGHTS) as QualityDimension[]).map((dimension) => ({
    dimension,
    score: input.dimensionScores[dimension].score,
    weight: QUALITY_DIMENSION_WEIGHTS[dimension],
    evidenceIds: input.dimensionScores[dimension].evidenceIds ?? [],
    notes: input.dimensionScores[dimension].notes ?? [],
  }));
  const weightedScore = Number(dimensions.reduce((sum, item) => sum + item.score * item.weight, 0).toFixed(2));
  const scenarios = input.scenarios.map((scenario) => ({ ...scenario, passed: scenario.score >= targetScore, evidenceIds: scenario.evidenceIds ?? [] }));
  const certified = weightedScore >= targetScore
    && dimensions.every((dimension) => dimension.score >= 80)
    && input.hardGates.every((gate) => gate.passed)
    && scenarios.every((scenario) => scenario.passed)
    && (input.raterAgreement >= 0.67 || input.raterCount >= 5);
  return QualityCertificationSchema.parse({
    schemaVersion: '1.0.0', benchmarkId: input.benchmarkId, rubricVersion: 'visual-world-parity-v1', referenceBaseline: 'WorldClaw-paper-figures-4-8', evaluatorProtocol: 'blinded-side-by-side-v1', qualityProfile: input.qualityProfile,
    targetScore, weightedScore, dimensions, hardGates: input.hardGates, scenarios, raterCount: input.raterCount, raterAgreement: input.raterAgreement,
    evidenceIds: input.evidenceIds ?? [], providers: input.providers ?? [], attempts: input.attempts ?? [], actualCostUsd: input.actualCostUsd,
    durationMs: input.durationMs, certified, createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export function renderQualityReportHtml(certification: QualityCertification): string {
  const dimensionRows = certification.dimensions.map((item) => `<tr><td>${escapeHtml(item.dimension)}</td><td>${item.score.toFixed(1)}</td><td>${Math.round(item.weight * 100)}%</td></tr>`).join('');
  const scenarioRows = certification.scenarios.map((item) => `<tr><td>${escapeHtml(item.id)}</td><td>${item.score.toFixed(1)}</td><td>${item.passed ? 'PASS' : 'FAIL'}</td></tr>`).join('');
  const gateRows = certification.hardGates.map((item) => `<li class="${item.passed ? 'pass' : 'fail'}">${item.passed ? 'PASS' : 'FAIL'} · ${escapeHtml(item.id)} — ${escapeHtml(item.message)}</li>`).join('');
  const attempts = certification.attempts.map((item) => `<tr><td>${escapeHtml(item.phase)}</td><td>${escapeHtml(item.status)}</td><td>$${item.costUsd.toFixed(2)}</td><td>${escapeHtml(item.message)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>WorldEngine quality report</title><style>body{font:14px system-ui;max-width:960px;margin:40px auto;color:#162018}h1{margin-bottom:4px}.score{font-size:48px;font-weight:750}.pass{color:#176b36}.fail{color:#a12d2d}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ccd5cd;padding:8px;text-align:left}code{background:#eef2ee;padding:2px 5px}</style></head><body><h1>Visual World Parity Benchmark v1</h1><p><code>${escapeHtml(certification.benchmarkId)}</code> · ${escapeHtml(certification.qualityProfile)} · ${escapeHtml(certification.createdAt)}</p><p>Reference: ${escapeHtml(certification.referenceBaseline)} · Protocol: ${escapeHtml(certification.evaluatorProtocol)}</p><div class="score ${certification.certified ? 'pass' : 'fail'}">${certification.weightedScore.toFixed(1)}/100 · ${certification.certified ? 'CERTIFIED' : 'NOT CERTIFIED'}</div><h2>Dimensions</h2><table><thead><tr><th>Dimension</th><th>Score</th><th>Weight</th></tr></thead><tbody>${dimensionRows}</tbody></table><h2>Scenarios</h2><table><thead><tr><th>Scenario</th><th>Score</th><th>Gate</th></tr></thead><tbody>${scenarioRows}</tbody></table><h2>Hard gates</h2><ul>${gateRows}</ul><h2>Attempts</h2><table><thead><tr><th>Phase</th><th>Status</th><th>Cost</th><th>Message</th></tr></thead><tbody>${attempts}</tbody></table><p>Raters: ${certification.raterCount}; agreement: ${certification.raterAgreement.toFixed(3)}. Actual provider cost: $${certification.actualCostUsd.toFixed(2)}. Duration: ${(certification.durationMs / 1000).toFixed(1)}s.</p></body></html>`;
}
