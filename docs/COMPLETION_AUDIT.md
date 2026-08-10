# Completion audit

This file maps the supplied Web-First Visual World Engine plan and WorldClaw-inspired clean-room pipeline to current, inspectable evidence. A green build is not treated as proof for browser, GPU, hardware, paid-provider, or legal-review requirements that it cannot exercise.

Status meanings:

- **Proven** — current source plus a focused test or generated artifact proves the requirement.
- **Manual gate** — implementation exists, but completion needs operator credentials, current legal acceptance, named hardware, or an external reviewer.
- **Browser-verified** — exercised against a production Vite build through the controlled Chrome surface, with the rendered result and DOM state inspected.

## Product and architecture boundary

| Requirement | Status | Authoritative evidence |
| --- | --- | --- |
| Visual engine only; no gameplay, physics, navigation, networking, combat, or rules | Proven | Renderer-neutral contracts in `packages/runtime/src/contracts.ts`; compiler planning system instruction in `packages/compiler/src/cloud-pipeline.ts`; package boundaries documented in `README.md`. |
| TypeScript pnpm monorepo with Vite, React, Zod/JSON Schema, Vitest, and Playwright | Proven | Root `package.json`, `pnpm-workspace.yaml`, seven package/app builds, `vitest.config.ts`, and `playwright.config.ts`. |
| Three renderer is an adapter, not a schema/compiler dependency | Proven | `@worldengine/schema`, `@worldengine/runtime`, and `@worldengine/compiler` expose plain values/typed buffers; Three.js is isolated in `packages/three`. |
| Server-side single-user BYOK; keys never enter the browser or bundle | Proven | `apps/compiler-service/src/main.ts`, ignored service env configuration, health response `browserKeysAccepted: false`, editor has no key input, and malformed-secret requests are now proven absent from the durable job ledger. |

## Canonical formats and runtime

| Requirement | Status | Authoritative evidence |
| --- | --- | --- |
| Versioned `WorldDesignSpec`, `AuthoringWorld`, and `VisualWorldBundle`; RH/Y-up/meters | Proven | Literal-version Zod schemas and exported draft-7 JSON Schemas in `packages/schema/src`; malformed versions/bounds/IDs reject. |
| Signed 256 m chunks, canonical 257×257 terrain, no format-level global boundary | Proven | `packages/terrain/src/reference.ts`, schema chunk coordinates, deterministic seam/contact tests, sparse negative-coordinate service tests. |
| Host-authoritative transforms and visual states with lifecycle events | Proven | `DefaultVisualWorldEngine` plus runtime lifecycle/conflict/state tests. Structural changes require loading their new immutable bundle rather than mutating an old snapshot. |
| Bounded prioritized streaming, LOD, instancing, culling metadata, floating origin, and placeholders | Proven | Runtime queue/hysteresis/origin tests; Three 65/33/17 terrain LOD, 10,000-instance, resource-accounting, occlusion metadata, and placeholder tests. |
| WebGPU-first and WebGL2 fallback | Browser-verified | Production Chrome selected WebGPU by default and WebGL2 with `?renderer=webgl2`. Both rendered the same hero-landmark view, camera controls remained live, and neither path emitted an application console error. |
| PBR terrain, sky, lighting, fog, water, weather, particles, animation, variants, and tone mapping | Browser-verified | Production screenshots verified terrain, sky, water, lighting, rain transition, PBR placeholders, and hero landmark rendering. Terrain/water filtering and the real third-person camera were corrected during this gate. |
| Explicit sparse-to-detailed expansion without camera-triggered billing | Proven | Compiler expansion endpoint and immutable version tests; editor Chunk inspector now offers `Generate detailed chunk · $0`, preserves camera focus across reload, and never selects provider generation. |
| Terrain and region brushes operate at the clicked world position | Browser-verified | A terrain click created revision 1, undo restored revision 0, and saving against a compiled world published a new immutable patch. The region brush, weather state, snapshot, and schema-valid regional regeneration were also exercised interactively. |

## Paper-aligned compiler pipeline

| Requirement | Status | Authoritative evidence |
| --- | --- | --- |
| Explicit-intent planning with documented defaults only | Proven | Local planner records `defaultsApplied`; structured OpenRouter request forbids gameplay/code and requires exact seed/prompt; schema validation rejects changed seed/prompt. |
| Canonical vector regions and deterministic masks | Proven | `rasterizeRegions` and deterministic composition tests; generated map images are never canonical topology. |
| Seeded regional terrain, biome splats, roads/rivers/coasts, scatter | Proven | Terrain generator and tests cover seams, feature conditioning, deterministic IDs, densities, contact, dependencies, and occlusion cells. |
| Terrain-conditioned regional concepts from recorded cameras | Proven with mocked provider contracts | Canonical CPU terrain render is passed as OpenAI image-edit input. Each region now uses one exact concept camera shared by its descriptors, inverse projection, and review tile. |
| Structured object descriptors, actual boxes, segmentation, isolated/multiview references, image-to-3D | Proven with mocked provider/worker contracts | Studio tests execute actual composition detection, SAM2 mask ingestion, one isolated plus four identity views, direct multiview PBR reconstruction, raw/refined/final GLBs and immutable reference provenance. Cheap retains the bounded WaveSpeed route. |
| Reverse projection, scale/contact correction, deterministic placement | Proven | Composition math tests, five camera-aligned regional compositions, 20 anchors, current atlas projection error `0.000005560531875251142` px and terrain-contact error `0` m. |
| Exact final-asset and placement review before `reviewedAt` | Proven with mocked reviewer | CPU renderer parses exact optimized GLB bytes; the separate Blender 5.1 worker produces turntable plus RGB/depth/normal/instance evidence; placement atlas compares requested boxes to recovered anchors; persisted bytes are reloaded for multimodal review; rejected output never publishes. |
| Mesh LODs, KTX2, chunk dependencies, provenance, immutable export | Proven | Meshoptimizer and Basis KTX2 tests, GLB/KTX2 validators, provenance-parent validation, bundle materializer, and immutable storage tests. |
| No generated scripts or arbitrary Blender/Python execution | Proven | Review accepts schema-only visual patches; the optional process-separated Blender and SAM2 workers accept fixed JSON schemas and allowlists. Provider/model text is never evaluated as Python. |
| Local object-terrain support co-deformation | Proven | Studio placement emits bounded flatten/smooth-compatible height-field edits around detected object footprints; terrain sampling, bundles and renderer all consume the same edits. This is a deterministic alternative to free-form Blender mesh sculpting. |
| Paper-derived 90/100 evidence gate | Proven as a gate; manual score pending | Five fixed scenarios, seven weighted dimensions, per-dimension/scenario thresholds, hard gates, rater agreement, provider fingerprints, Studio artifact requirements, content-hash verification and immutable HTML report are tested. No score is claimed until paid runs and independent ratings exist. |

## Compiler service, cost, storage, and recovery

| Requirement | Status | Authoritative evidence |
| --- | --- | --- |
| Compile/SSE/expansion/patch/bundle APIs | Proven | Route integration tests cover persisted SSE replay, canonical reads, immutable versions, revision conflicts, expansion, imports, and concurrent mutations. |
| SQLite job/DAG ledger, cancellation, crash recovery, webhook deduplication | Proven | Active provider work is aborted and publishes no bundle; a queued job actually resumes to completion after service restart; a publication fault becomes a sanitized terminal failure; signed WaveSpeed events are time-bounded and durably deduplicated. |
| Hard cost/generation caps, no silent fallback, no blind billable POST retry | Proven | Legal/cost tests, no-fallback OpenRouter settings, idempotency tests, explicit single-POST failure test, and camera movement cannot invoke a provider. |
| Fail-closed provider/model/legal policy | Proven | Unknown/changed/unaccepted/territory/commercial-use cases reject; Hunyuan3D rejects in EU; default SAM/provider profiles are disabled and unreviewed. |
| Filesystem and S3-compatible immutable storage | Proven | Path-containment, content-hash, write-once byte identity, atomic local creation, and S3 `If-None-Match: *` tests. Design and authoring are persisted before the manifest/latest commit point; fault injection proves a failed prerequisite cannot publish a partial version. |

## Reference-world and release evidence

| Requirement | Status | Authoritative evidence |
| --- | --- | --- |
| 4×4 km reference world, ≥5 regions, ≥20 prototypes, ≥5,000 instances, all chunks, no buried/unreviewed assets | Proven | Formal acceptance validator and fixture tests. Current reference has 256 chunks, five regions, 20 prototypes, and 5,143 authoring entities. |
| Complete self-contained bounded-world distribution | Proven | Full materialization produced 256/256 canonical chunks (109.7 MiB) with 0 hash mismatches, 0 runtime validation errors, and 0 acceptance errors. Manifest is written only after all chunks. |
| Non-browser release gate | Proven | Latest `pnpm release:check`: all seven builds/typechecks passed; 25 Vitest files / 117 tests passed; production audit found no known vulnerabilities; five clean npm tarballs verified. |
| Current placement-review artifact | Proven | `/tmp/worldengine-placement-diagnostic-camera-aligned.png`: 20 objects over five exact regional concept cameras, visually inspected locally, 298,781 bytes. |
| Interactive browser acceptance | Browser-verified | Compile completion, patch save, schema-valid regional regeneration, undo/snapshot, responsive orbit/WASD/reset, server-side BYOK policy display, WebGPU/WebGL2, rain, and explicit expansion were exercised. Out-of-bounds chunk `-5:-13` transitioned from a 33² sparse placeholder to a detailed URI-backed chunk with 20 instances. Settled hero-view measurements were 8.9–9.4 ms p95 and 8–13 MB tracked resources with `BUDGET OK`. |

## Remaining manual release gates

1. **Named-hardware certification:** the production browser gate met the live budget in the tested viewport, while the deterministic backend test covers 10,000 visible instances. A formal 1080p Apple-M2 certificate still requires recording the named hardware/display mode together with p95 ≤16.7 ms, chunk tasks ≤50 ms, and GPU memory <1.5 GB.
2. **Paid-provider acceptance:** after an operator reviews and accepts exact terms/fingerprints, supplies server-side keys, SAM2 and Blender, run bounded Cheap and Studio smoke tests. No credentials or legal acceptance are committed, so mocked contract coverage is not represented as live quality.
3. **90/100 visual certification:** run all five blinded scenarios, compare direct Tripo and Meshy, upload per-scenario evidence, collect independent ratings and publish only if the strict certificate passes. Current status is explicitly uncertified.
4. **Independent release review:** use an available independent reviewer, then complete trademark clearance and counsel-led patent freedom-to-operate review.

The Chrome QA extension refused local file selection because its optional “Allow access to file URLs” permission was disabled. This did not block the product's rights gate: GLB hashing, license/affirmation validation, upload, immutable storage, and provenance are covered by editor/server tests. Repeating that one browser-picker interaction requires enabling the extension permission described by Chrome.

BlenderMCP is not a runtime dependency. Studio now has a separate GPL Blender 5.1 worker with fixed operations and diagnostic passes; the Apache core does not execute generated scripts. Terrain support fitting is deterministic height-field editing, not unrestricted Blender mesh sculpting.
