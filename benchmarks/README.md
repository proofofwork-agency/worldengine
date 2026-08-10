# Visual World Parity Benchmark v1

This benchmark measures Studio output against the visual and structural evidence in WorldClaw paper Figures 4-8. It is a comparison protocol, not a claim that WorldEngine already scores 90.

Run all five prompts with pinned providers and the same Studio caps. Capture global, regional, and walk views plus RGB, depth, normal, instance, placement, performance, provenance, cost, and failed-attempt evidence. At least three independent raters score anonymized side-by-side pairs. Certification requires a weighted score of 90/100, every scenario at least 90, every dimension at least 80, all hard gates, and agreement of at least 0.67 (or five raters).

Upload one or more operator-affirmed captures per scenario:

```bash
curl --fail --request POST \
  --header 'Content-Type: image/png' \
  --header 'X-WorldEngine-Evidence-Affirmed: true' \
  --data-binary @walk-view.png \
  http://127.0.0.1:8787/v1/worlds/WORLD_ID/quality-evidence/tropical-pirate-island
```

Then create a `QualityCertification` with `createQualityCertification` and publish it using `POST /v1/worlds/:id/certifications` plus `X-WorldEngine-Certification-Affirmed: true`. The service validates evidence hashes, scenario ownership, provider fingerprints, Studio artifacts, hard gates, rater agreement, cost, and score arithmetic before creating a new immutable bundle version.
