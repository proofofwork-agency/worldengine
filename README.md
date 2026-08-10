# WorldEngine

> **Alpha software.** The formats and security boundaries are tested, but public APIs, bundle migrations, provider integrations, and visual output may still change before a stable release. Do not use this alpha as the sole control for irreversible production or legal decisions.

WorldEngine is a web-first visual world compiler and streaming renderer. It turns a validated world description and asset catalog into immutable, chunked visual bundles that a host game can embed. The host retains authority over gameplay, physics, navigation, networking, combat, and rules.

This repository contains a working local reference release: renderer-neutral formats, deterministic terrain and placement, streaming lifecycle, a Three.js WebGPU/WebGL2 backend, a durable compiler service, and a visual React editor. Paid cloud generation is deliberately disabled until an operator supplies reviewed provider profiles and accepts their current terms.

## Research basis, credit, and clean-room boundary

WorldEngine is an independent clean-room implementation inspired by the general global-to-regional workflow described in **“WorldClaw: Agentic 3D Open-World Generation at Scale”** by the Tencent Hunyuan research team ([arXiv:2608.05248](https://arxiv.org/abs/2608.05248)). We credit the paper for describing a pipeline that plans a world, establishes global terrain, composes regional scenes, reconstructs independent objects, places them through known cameras, and iteratively reviews visual results.

WorldEngine is not WorldClaw, is not affiliated with or endorsed by Tencent or the paper authors, and does not use WorldClaw as a product or repository name. This repository does not contain their source code, figures, sample assets, prompts, documentation prose, branding, model weights, or generated Blender programs. It independently implements general ideas and interfaces with project-authored schemas, algorithms, tests, assets, and documentation. Research attribution is not a claim of code lineage and does not grant rights to any third-party model, service, trademark, dataset, or output.

The paper's experimental stack is recorded only for technical comparison. WorldEngine substitutes operator-reviewed services and local workers where the original model or license is unsuitable, especially in the EU. See [the detailed paper mapping](docs/PAPER_PARITY.md), [provider/legal controls](docs/PROVIDERS_AND_LEGAL.md), and [EU operator checklist](docs/EU_OPERATOR_CHECKLIST.md). These are engineering safeguards, not legal advice; trademark clearance, patent freedom-to-operate, and current provider/model terms still require qualified review before commercial launch.

## Quick start

Requires Node.js 22+ and pnpm 10+.

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm dev
```

The editor opens at `http://127.0.0.1:5173`. Append `?renderer=webgl2` to force the fallback backend for conformance comparison; without it the editor attempts WebGPU first. To run the local compiler in another terminal:

```bash
corepack pnpm dev:compiler
```

The editor connects to port `8787` on the same hostname that served the page, so LAN previews work without pointing a remote browser back at its own `127.0.0.1`. Copy `apps/editor/.env.example` to `apps/editor/.env.local` only to override that endpoint. A compile is never simulated when the service is unavailable: the editor reports the connection failure and leaves the open world unchanged.

### Enabling BYOK cloud generation

BYOK is deliberately server-side: the editor never opens a key dialog because a browser form would expose long-lived provider credentials. To opt in:

```bash
mkdir -p .worldengine
cp apps/compiler-service/provider-policy.example.json .worldengine/provider-policy.json
cp apps/compiler-service/.env.example apps/compiler-service/.env.local
# Review and edit both local files, then:
corepack pnpm --filter @worldengine/compiler-service dev:configured
```

In `.worldengine/provider-policy.json`, replace every placeholder with the exact current model revision, terms fingerprint, real unit cost, permitted territory, and commercial-use decision; add `acceptedAt` and set `enabled` only after that review. Put `OPENROUTER_API_KEY` and `WAVESPEED_API_KEY` in ignored `.env.local` (preferred) or `.env`; the configured scripts load both and `.env.local` wins. The OpenRouter key serves the separate `openrouter` planning/review and `openrouter-image` GPT Image profiles. Studio additionally needs a separately installed Blender 5.1 executable and reviewed local SAM2 checkpoint. Startup fails closed if an enabled profile lacks its credential or capability. Validate the setup without calling a provider:

```bash
corepack pnpm provider:check -- --profile studio
```

Localhost, loopback, private-LAN, and `.local` editor origins may mutate the compiler by default; for another editor origin, add its exact origin to `WORLDENGINE_ALLOWED_ORIGINS`. The Pipeline tab then shows each profile as ready. This is an explicit opt-in and may incur only the confirmed cap.

## Visual quality profiles

The editor exposes three explicit profiles:

- **Local draft** (`$0`) builds deterministic 257×257 region-aware terrain, procedural placeholders, 5,000+ instances, streaming, weather, water, LOD and editing. It is an explicit draft, never a paper-quality result or a cloud-failure fallback.
- **Cheap** (`≤ $15`) adds server-side BYOK planning/review, terrain-conditioned regional imagery, isolated transparent references and single-image Tripo reconstruction through WaveSpeed for one hero region. Reviewed library/cache GLBs are reused first.
- **Studio · experimental** first runs one hero region under an explicitly confirmed `$25` cap. It adds executable composite terrain plans, actual composition detection, local SAM2.1 Hiera Large masks, alpha crops, four ordered identity-preserving views, WaveSpeed-hosted Tripo H3.1 PBR reconstruction, a separate Blender 5.1 worker, RGB/depth/normal/semantic/instance evidence, calibrated placement, mesh-footprint terrain fitting and bounded multimodal repair. Only after that gate passes may an operator separately authorize scaling to five regions under `$100`.

Generated records receive `reviewedAt` only after the reviewer sees persisted terrain/composition pairs, masks, crops and multiview references, exact-GLB diagnostics, Blender passes and placement evidence. Raw provider output, Blender-refined output, optimized GLBs and rejected diagnostics remain content-addressed in the compile artifact catalog. A rejected run publishes no bundle and leaves the open world labelled `Local draft`; it appears separately as `needs attention`. Every unique provider action reserves the reviewed unit price before invocation and is recorded with its exact provider/model/revision; resume runs carry prior spend forward. There is no silent model fallback, blind billable POST retry, browser key storage or camera-triggered generation.

The Blender code is an optional separately installed GPL-3.0-or-later worker. The Apache TypeScript core sends only a fixed JSON job with allowlisted operations; it never evaluates model-generated Python. Blender repairs the isolated asset and produces diagnostic passes. Renderer-neutral height-field edits perform bounded local flatten/smooth support fitting after placement, preserving the global terrain. BlenderMCP is therefore not required and is not silently installed.

Quality similarity is not self-declared. `benchmarks/visual-world-parity-v1.json` defines five paper-derived scenarios, seven weighted dimensions, a 90/100 threshold, minimum per-dimension and per-scenario scores, all hard gates, and independent blinded raters. The service accepts scenario-specific immutable evidence and will publish a certification only when its hashes, provider fingerprints, Studio artifacts, cost, rater agreement and arithmetic all pass. Until a real paid run and external assessment exist, the honest product status is **experimental Studio pipeline; no 90/100 or parity claim**. See [docs/PAPER_PARITY.md](docs/PAPER_PARITY.md).

## Generation routes

WorldEngine never silently switches between these routes. The request, reviewed provider policy, hard cost cap, and operator confirmation select exactly one path.

| Route | Network generation | Intended use | Main stages |
| --- | --- | --- | --- |
| **Local** | None | Free deterministic baseline and offline development | Prompt/spec → vector regions → seeded terrain/features/scatter → project-authored PBR visual prototypes → immutable bundle |
| **Reviewed import** | None inside WorldEngine | Highest-control hero assets made or licensed elsewhere | Rights affirmation → GLB validation → content hash → optimization/LODs → provenance → immutable version |
| **Cheap BYOK** | OpenRouter planning + OpenRouter Images + WaveSpeed | One enriched hero region under a `$15` hard maximum | Structured plan/review → terrain-conditioned image edit → isolated reference → single-image Tripo → placement/review |
| **Studio BYOK · experimental** | OpenRouter planning/images + local SAM2.1 Large + WaveSpeed Tripo H3.1 + local Blender 5.1 | First one hero region under `$25`; separate later scale gate up to five/$100 | Compiled terrain → registered Blender passes → terrain-conditioned edit → detection/mask/crop → four-cardinal PBR reconstruction → fixed Blender validation → calibrated silhouette/contact fit → bounded typed repair |
| **Sparse expansion** | None | Explicitly materialize an out-of-bounds visual chunk | Deterministic placeholder → explicit `$0` chunk request → detailed immutable chunk hot-patch |

Camera movement never selects a route or starts billable work. Generated assets are published only after schema-valid review; imported assets require explicit rights metadata. BlenderMCP, Claude, Hunyuan3D, SAM3, and generated Python are not runtime dependencies.

### External cloud endpoints used by the reference adapters

All provider calls originate in `@worldengine/compiler-service`; the editor and exported games receive neither API keys nor provider authorization headers. Base URLs can be replaced only through operator-controlled adapter configuration, while exact provider/model/revision tuples remain pinned by policy.

| Service | Default outbound endpoints | WorldEngine role |
| --- | --- | --- |
| **OpenRouter planning** | `GET /api/v1/model/{author}/{model}`; `POST /api/v1/chat/completions` | Capability check, structured planning, composition detection, and multimodal review with fallback disabled and ZDR/data-collection controls requested |
| **OpenRouter Images** | `GET /api/v1/images/models`; `POST /api/v1/images` | Default BYOK image route for `openai/gpt-image-2`: terrain-conditioned reference edits, transparent isolation, and identity views, with provider fallback disabled |
| **WaveSpeed** | `POST /api/v3/{reviewed-model-id}`; submission-provided same-origin result URL | Cheap single-image job and Studio `tripo3d/h3.1/multiview-to-3d`; four ordered inputs, detailed triangle geometry/textures, PBR, `align_image`, `auto_size: false` |
| **SAM2 worker** | No cloud endpoint | Local SAM2.1 Hiera Large box-prompted segmentation through a fixed JSON process contract and pinned code/checkpoint hashes |
| **Blender worker** | No cloud endpoint | Local GPL worker for allowlisted mesh/region repair plus RGB/depth/normal/semantic/instance renders |

WaveSpeed may call the inbound `POST /v1/webhooks/wavespeed` compiler route when configured; the service requires a fresh HMAC signature and durably deduplicates event IDs. Provider POSTs use idempotency protection and are not blindly retried. Endpoint availability, pricing, retention, commercial rights, and model terms can change, so the committed provider policy is intentionally disabled and unusable until an operator reviews the current terms.

## Packages

| Package | Responsibility |
| --- | --- |
| `@worldengine/schema` | Versioned `WorldDesignSpec`, `AuthoringWorld`, `VisualWorldBundle`, chunk, patch, compiler, provenance, and provider-policy schemas |
| `@worldengine/terrain` | Seeded seam-safe terrain, signed chunk generation, deterministic placement, and the 4×4 km reference world |
| `@worldengine/runtime` | Renderer-neutral loading, chunk streaming, host visual state, lifecycle events, sparse placeholders, and floating origin |
| `@worldengine/three` | WebGPU-first/WebGL2-fallback Three.js rendering, terrain, instancing, visual-state variants, lighting, weather, water, picking, and multi-mesh/multi-material GLB import |
| `@worldengine/compiler` | Checkpointed deterministic DAG, artifact cache, cost/legal gates, provider adapters, asset/bundle validation, and filesystem/S3 storage |
| `@worldengine/compiler-service` | Node HTTP API, SQLite job/event/DAG/webhook ledger, SSE progress, cancellation/recovery, immutable snapshots, patches, and explicit expansion |
| `@worldengine/editor` | React/Vite authoring and conformance viewer |

## Runtime integration

```ts
import { DefaultVisualWorldEngine, HttpWorldBundleSource } from '@worldengine/runtime';
import { ThreeRendererBackend } from '@worldengine/three';

const backend = new ThreeRendererBackend({
  preferWebGPU: true,
  // Required only for bundles containing KTX2 textures.
  ktx2TranscoderPath: '/basis/',
});
const engine = new DefaultVisualWorldEngine(backend, {
  canvas,
  width: canvas.clientWidth,
  height: canvas.clientHeight,
});

await engine.load(new HttpWorldBundleSource(new URL('/world/bundle.json', location.href)));
engine.setView(cameraView);
engine.streamAround(playerVisualPosition, 768);
engine.update({ deltaSeconds, elapsedSeconds });
```

Moving the camera never starts a paid provider request. Out-of-bounds coordinates receive a deterministic sparse placeholder only when the source supports it; detailed expansion uses the explicit compiler endpoint or the **Generate detailed chunk · $0** action in the editor's Chunk inspector. That action publishes a new immutable bundle version, preserves the current camera focus, and replaces the placeholder after the runtime reloads it.

## Compiler API

- `POST /v1/compiles` validates budgets and provider policy, then creates a durable job.
- `GET /v1/compiles` and `GET /v1/compiles/:id` return durable job history.
- `GET /v1/compiles/:id/events` streams persisted SSE events and replays existing events after reconnect.
- `POST /v1/compiles/:id/cancel` cancels a non-terminal job.
- `POST /v1/worlds/:id/chunks/:x/:z/compile` explicitly materializes a signed sparse chunk into a new immutable version.
- `GET /v1/worlds/:id/chunks/:x_:z.json?version=N` serves the content-hashed payload referenced by a manifest.
- `POST /v1/worlds/:id/patches` applies a revision-checked visual patch and creates a new bundle version.
- `POST /v1/worlds/:id/quality-evidence/:scenarioId` stores an operator-affirmed benchmark capture by SHA-256 in a new immutable version.
- `POST /v1/worlds/:id/certifications` validates and publishes a parity certificate; `GET /v1/worlds/:id/quality-report?format=html` renders it.
- `GET /v1/worlds/:id/bundle?version=N` returns an immutable manifest; omit `version` for latest.
- `POST /v1/webhooks/wavespeed` accepts only fresh HMAC-SHA256-signed events and durably deduplicates them when `WAVESPEED_WEBHOOK_SECRET` is configured.

Every compile request requires `maxCostUsd` and `maxAssetGenerations`; `maxReferenceImages` defaults to zero. Unknown models, changed terms, forbidden territories, unaccepted profiles, disallowed commercial use, and estimates above the cap fail closed.

Dry-runs are read-only estimates: they may populate the content-addressed compiler cache but do not publish a world or advance an immutable bundle version. Local or cloud execution requires the separate unchecked confirmation in the editor. Sparse chunk materialization is deterministic and rejects non-zero asset-generation requests rather than implying that it called a provider.

Canonical world reads and reviewed asset import are also available:

- `GET /v1/worlds/:id/design`, `/authoring`, and `/bundle` return the three canonical artifacts.
- `POST /v1/worlds/:id/assets/:prototypeId/import` accepts a validated, self-contained glTF 2.0 GLB only with explicit rights/license headers, stores raw and optimized bytes by SHA-256, records reviewed provenance, and creates an immutable version. External image/buffer references are rejected because their bytes are not covered by the GLB hash.
- `GET /v1/worlds/:id/assets/:contentHash.glb` and `/references/:contentHash.:extension` serve immutable generated/imported artifacts.

## Reference world

The included “Aster Vale” fixture is a 4×4 km, 16×16 grid with 256 m chunks and canonical 257×257 terrain samples. It contains five vector regions, 20 reviewed procedural prototypes, 5,120 deterministic scatter instances, three authored landmarks, and 20 reverse-projected composition anchors (5,143 authoring entities total). Signed coordinates allow explicit expansion with no global format boundary.

The editor enables GLB replacement after a remote world has been compiled, because reviewed bytes are uploaded directly into a content-addressed immutable version rather than hidden inside a JSON compile request.

Generate its complete immutable canonical design, authoring world, 256 content-hashed canonical chunk payloads, and final runtime manifest on disk with:

```bash
corepack pnpm reference:build
```

This explicit distribution build is intentionally heavier than the editor preview: it materializes every 257×257 payload before publishing the manifest, so a static host never needs to synthesize bounded-world terrain in the browser.

Run the complete non-browser release gate (all builds and TypeScript checks, Vitest, production dependency audit, and npm-tarball inspection) with `corepack pnpm release:check`. Browser conformance remains a separate `corepack pnpm test:e2e` gate; the current release was also exercised manually in production Chrome through WebGPU and forced WebGL2, including compilation, editing, regeneration, weather, camera controls, and sparse expansion.

## Release boundary

The self-hosted Local draft path is implemented and tested. Studio remains experimental: the repository contains the 1.2 contracts, compiled terrain operators, fixed WaveSpeed/SAM2/Blender orchestration, artifact and resume APIs, deterministic gates and mocked integration coverage, but no paid Studio output has been accepted. Paid live-provider quality, the `$25` M3 Pro/1080p hero gate, external 90/100 ratings, and independent risk review remain mandatory before any parity or production-quality claim.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the exact implemented surface and guarded follow-on work.

Copyright 2026 Proof of Work Agency and WorldEngine contributors. Licensed under Apache-2.0 except where a file explicitly states another license. The provider/model legal controls are engineering safeguards, not legal advice.
