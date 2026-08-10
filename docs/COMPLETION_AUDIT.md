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
| Terrain-conditioned regional concepts from recorded cameras | Proven with mocked provider contracts | The canonical terrain render is passed to the selected reviewed image-edit adapter; structure/terrain/camera preservation thresholds are enforced. Each region retains calibrated camera provenance. Live visual quality remains unproven. |
| Structured object descriptors, actual boxes, segmentation, crops/multiview references, image-to-3D | Proven with mocked provider/worker contracts | Studio tests execute composition detection, SAM2 mask ingestion, lossless affine crop, four ordered identity views and fixed WaveSpeed H3.1 multiview PBR reconstruction. Cheap retains the bounded single-image WaveSpeed route. |
| Reverse projection, actual-mesh silhouette/contact correction, deterministic placement | Proven by contract; live worker run pending | Composition math tests cover camera projection and mask metrics. The fixed Blender job fits the imported mesh, measures SAM-mask IoU ≥0.85, center error ≤4 px and class-specific contact, while the placement atlas preserves anchor evidence. |
| Exact final-asset and placement review before `reviewedAt` | Proven with mocked reviewer | CPU diagnostics parse optimized GLB bytes; the Blender 5.1 worker contract produces RGB/depth/normal/semantic/instance evidence; placement atlases compare requested boxes to recovered anchors; rejected output never publishes and remains catalogued. |
| Mesh LODs, KTX2, chunk dependencies, provenance, immutable export | Proven | Meshoptimizer plus embedded and standalone Basis KTX2 tests, safe terrain dependency resolution, GLB/KTX2 validators, provenance-parent validation, bundle materializer, and immutable storage tests. |
| No generated scripts or arbitrary Blender/Python execution | Proven | Review accepts schema-only visual patches; the optional process-separated Blender and SAM2 workers accept fixed JSON schemas and allowlists. Provider/model text is never evaluated as Python. |
| Local object-terrain support co-deformation | Proven deterministically | Studio region refinement returns actual mesh footprints; height-field edits use a 2 m support margin, fall off completely by 5 m and leave samples outside unchanged. Live Blender contact evidence remains part of the `$25` gate. |
| Paper-derived 90/100 evidence gate | Proven as a gate; manual score pending | Five fixed scenarios, seven weighted dimensions, per-dimension/scenario thresholds, hard gates, rater agreement, provider fingerprints, Studio artifact requirements, content-hash verification and immutable HTML report are tested. No score is claimed until paid runs and independent ratings exist. |

## Compiler service, cost, storage, and recovery

| Requirement | Status | Authoritative evidence |
| --- | --- | --- |
| Compile/SSE/expansion/patch/bundle APIs | Proven | Route integration tests cover persisted SSE replay, canonical reads, immutable versions, revision conflicts, expansion, imports, and concurrent mutations. |
| SQLite job/DAG ledger, cancellation, crash recovery, webhook deduplication | Proven | Active provider work is aborted and publishes no bundle; a queued job actually resumes to completion after service restart; a publication fault becomes a sanitized terminal failure; signed WaveSpeed events are time-bounded and durably deduplicated. |
| Hard cost/generation caps, per-action reservation, no silent fallback, no blind billable POST retry | Proven | Compile-scoped accounting reserves the reviewed unit price before invocation, includes prior resume spend, persists exact provider/model/revision attempts, and blocks the provider call itself when the cap has insufficient room. Legal/cost, idempotency, single-POST failure, ledger and camera-movement tests cover the boundary. |
| Fail-closed provider/model/legal policy | Proven | Unknown/changed/unaccepted/territory/commercial-use cases reject; Hunyuan3D rejects in EU; default SAM/provider profiles are disabled and unreviewed. |
| Filesystem and S3-compatible immutable storage | Proven | Path-containment, content-hash, write-once byte identity, atomic local creation, and S3 `If-None-Match: *` tests. Design and authoring are persisted before the manifest/latest commit point; fault injection proves a failed prerequisite cannot publish a partial version. |

## Reference-world and release evidence

| Requirement | Status | Authoritative evidence |
| --- | --- | --- |
| 4×4 km reference world, ≥5 regions, ≥20 prototypes, ≥5,000 instances, all chunks, no buried/unreviewed assets | Proven | Formal acceptance validator and fixture tests. Current reference has 256 chunks, five regions, 20 prototypes, and 5,143 authoring entities. |
| Complete self-contained bounded-world distribution | Proven | Full materialization produced 256/256 canonical chunks (109.7 MiB) with 0 hash mismatches, 0 runtime validation errors, and 0 acceptance errors. Manifest is written only after all chunks. |
| Non-browser release gate | Passed 2026-08-10 | `pnpm check` and all 131 unit/integration tests passed after the Studio 1.2 changes; both Python workers compiled. Paid/provider gates remain separate. |
| Current placement-review artifact | Proven | `/tmp/worldengine-placement-diagnostic-camera-aligned.png`: 20 objects over five exact regional concept cameras, visually inspected locally, 298,781 bytes. |
| Interactive browser acceptance | Browser-verified | All 8 Playwright scenarios passed on 2026-08-10, including compile completion, patch save, regional regeneration, orbit/WASD/reset, sandbox/third-person/RTS switching, server-side BYOK status, WebGPU/WebGL2 and rights-gated GLB import. Historical performance observations are not a substitute for the named M3 Pro/1080p Studio gate. |

## Remaining manual release gates

1. **Named-hardware certification:** the production browser gate met the live budget in the tested viewport, while the deterministic backend test covers 10,000 visible instances. A formal 1080p Apple M3 Pro certificate still requires recording the named hardware/display mode together with p95 ≤16.7 ms, chunk tasks ≤50 ms, and GPU memory <1.5 GB.
2. **Paid-provider acceptance:** after an operator reviews and accepts exact terms/fingerprints, supplies server-side keys, SAM2 and Blender, run bounded Cheap and Studio smoke tests. No credentials or legal acceptance are committed, so mocked contract coverage is not represented as live quality.
3. **90/100 visual certification:** only after the `$25` hero succeeds, separately authorize the five-region run, upload per-scenario evidence, collect independent blinded ratings and publish only if the strict certificate passes. Current status is experimental and explicitly uncertified.
4. **Independent release review:** use an available independent reviewer, then complete trademark clearance and counsel-led patent freedom-to-operate review.

The Chrome QA extension refused local file selection because its optional “Allow access to file URLs” permission was disabled. This did not block the product's rights gate: GLB hashing, license/affirmation validation, upload, immutable storage, and provenance are covered by editor/server tests. Repeating that one browser-picker interaction requires enabling the extension permission described by Chrome.

BlenderMCP is not a runtime dependency. Studio now has a separate GPL Blender 5.1 worker with fixed operations and diagnostic passes; the Apache core does not execute generated scripts. Terrain support fitting is deterministic height-field editing, not unrestricted Blender mesh sculpting.
