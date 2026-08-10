# Provider and legal controls

Provider calls are disabled by default. The profiles committed to this repository are intentionally marked `UNREVIEWED`, have no accepted timestamp, permit no territories, and are not enabled. They document integration targets; they do not authorize use.

To enable a model, an operator must register a profile containing the exact provider/model/revision, terms URL and fingerprint, review and acceptance timestamps, territories, commercial-use permission, notices, output conditions, retention/training settings, restrictions, and unit cost. A compile request repeats the exact terms fingerprint, territory, commercial-use intent, maximum cost, maximum number of generated assets, and maximum number of regional reference images.

The compiler service reads the profile array from `WORLDENGINE_PROVIDER_POLICY_FILE`. API credentials stay server-side in `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `WAVESPEED_API_KEY`, `TRIPO_API_KEY`, and `MESHY_API_KEY`; webhook verification uses `WAVESPEED_WEBHOOK_SECRET`. Local Studio workers use `WORLDENGINE_BLENDER_EXECUTABLE`, `WORLDENGINE_SAM2_CHECKPOINT`, and `WORLDENGINE_SAM2_CONFIG`. Startup capability-checks every enabled and accepted profile and fails when a credential/adapter or structured-output, image-input, segmentation, multiview or PBR capability is missing. Do not put these values in a `VITE_` variable.

For local setup, copy `apps/compiler-service/.env.example` to the ignored `.env.local`, copy the policy example to the ignored `.worldengine/provider-policy.json`, and run the service's `dev:configured` script. The browser will never ask for the keys; its health view only receives booleans and public model/policy metadata.

Start from `apps/compiler-service/provider-policy.example.json`. It is deliberately unusable as committed: replace each exact revision, current terms fingerprint, review metadata, territories, output conditions, and real unit cost; only then set `acceptedAt` and `enabled`. Leaving any required profile unreviewed keeps that quality profile unavailable in the editor. `pnpm provider:check -- --profile cheap|studio` prints every blocking issue and exits nonzero.

The compiler rejects:

- unknown provider/model/revision tuples;
- changed terms fingerprints;
- profiles without explicit acceptance and enablement;
- territory or commercial-use conflicts;
- any maximum cost estimate above the request cap;
- Hunyuan3D-family use from an EU territory;
- restricted profiles such as SAM3 unless a reviewed operator profile explicitly permits them.

The supplied HTTP adapters use stable idempotency keys and the exported `ProviderRequestGuard`; duplicate in-flight invocations share one POST. OpenRouter requests require schema output, zero-data-retention routing, parameter support, and disabled provider fallback. OpenAI image calls use the exact configured revision and idempotency key. WaveSpeed result polling uses GET, downloads outputs immediately, rejects non-HTTPS and oversized outputs, and validates GLB bytes. Its webhook endpoint verifies the raw-body HMAC, rejects timestamps older than five minutes, compares signatures in constant time, and stores event IDs for durable deduplication. No adapter blindly retries a provider POST and there is no silent model fallback.

Paid live-provider tests are intentionally manual: an operator must first review current terms/fingerprints, enable exact profiles, provide server credentials, set a strict nonzero cap, and set the explicit `WORLDENGINE_LIVE_PROVIDER_TEST=I_ACCEPT_BILLABLE_PROVIDER_CALLS` opt-in. The command otherwise performs only a dry-run. Recorded fake-provider contracts remain the CI path, so CI neither spends money nor hides a legal acceptance decision.

Candidate generated records are not review-stamped during ingestion. Studio review receives terrain/composition pairs, masks, five identity references (four cardinal reconstruction inputs plus a perspective review view), exact-runtime-GLB diagnostics, Blender RGB/depth/normal/instance evidence, and the terrain placement atlas. Only successful structured multimodal review can add `reviewedAt`; rejection prevents bundle publication. Quality certification is a second, independent manual gate requiring five scenario-specific content-hashed captures and blinded ratings. It cannot turn raw provider output into a review stamp.

The Blender worker is intentionally separate and GPL-3.0-or-later. The Apache core writes a fixed JSON job and accepts a fixed result manifest; no provider or model may supply executable Python. SAM2 is also isolated behind a fixed box-segmentation job. WorldEngine's local object-terrain fitting is stored as bounded renderer-neutral height-field edits, rather than hiding unrestricted Blender code in the core.

This project is a clean-room implementation of general visual-world planning and compilation ideas. Do not copy third-party source, figures, sample assets, prompts, documentation prose, names, or branding without a separate applicable license. Imported assets require source and license provenance. Generated assets require the provider/model profile that governed their creation.

These controls support review; they are not a legal opinion. See `docs/EU_OPERATOR_CHECKLIST.md`. Trademark clearance, patent freedom-to-operate analysis, and current provider/model terms require qualified counsel and operator approval before commercial launch.
