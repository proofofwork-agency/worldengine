# Paper parity and the 90/100 gate

WorldEngine is a clean-room product implementation of the global-to-regional visual-world workflow described in *WorldClaw: Agentic 3D Open-World Generation at Scale* (arXiv:2608.05248). It does not contain WorldClaw code, assets, figures, prompts, branding or model weights.

## What the paper actually demonstrates

The paper's core chain is intent/specification, a semantic region layout, region-aware composite terrain, reusable terrain prototypes and materials, terrain-conditioned regional compositions, instance segmentation, independent image-to-3D meshes, camera-derived placement, and iterative object/terrain refinement. Section 2.3.3 specifically re-renders object repairs and performs local support-surface co-deformation for floating, penetration and unstable contact. Figures 4-7 show global, regional and walk views plus instance, depth and normal passes. Figure 8 is qualitative rather than a numerical benchmark. Section 3.1 reports Claude Opus 4.8, GPT-Image-2, SAM3/SAM3D, Hunyuan3D, Blender 5.1.1 and four NVIDIA H20 GPUs. Section 5 explicitly says final quality depends heavily on the foundation models, generated Blender programs are unstable, and the long repair chain is expensive.

Consequently, sharing a pipeline shape does not guarantee equal visual output. A 90% claim requires an actual blinded comparison; architecture or mocked provider tests are not visual evidence.

## Implementation mapping

| Paper capability | WorldEngine implementation | Current proof boundary |
| --- | --- | --- |
| Intent analysis and scene planning | Zod-validated `WorldDesignSpec`; local deterministic planner or pinned structured-output planner | Implemented and contract-tested |
| Semantic layout and region masks | Canonical vector polygons, deterministic masks and soft terrain blending | Implemented and deterministic |
| Region-aware height field and scattering | Seeded landform operators, features, biome weights, slope/contact-aware scatter | Implemented; not the paper's generated Blender terrain program |
| Terrain materials | Local PBR tiled channels and KTX2 optimization; imported/generated asset materials | Implemented baseline; procedural Blender node authoring remains a quality gap |
| Terrain-conditioned composition | Exact known camera, canonical terrain RGB input, image editing, recorded composition | Implemented; live quality depends on enabled image model |
| Actual object extraction | Structured multimodal detection from the actual composition, then local SAM2 box mask | Studio implemented; alternative to restricted SAM3 |
| Independent 3D reconstruction | Four ordered cardinal views through a direct Tripo or Meshy PBR adapter, with a fifth perspective reference retained for review; Cheap uses WaveSpeed Tripo | Studio implemented; provider bake-off is still manual |
| Placement | Reverse known camera projection, terrain raycast, scale/contact correction and placement atlas | Implemented deterministically |
| Object refinement | Fixed Blender 5.1 asset repair, normalized origin/material/normals/contact, turntable and passes | Implemented as an allowlisted worker; no arbitrary generated Python |
| Terrain co-deformation | Local renderer-neutral flatten/smooth height-field support edits around the placed footprint | Implemented deterministic alternative; not Blender mesh sculpting |
| Render-inspect-repair | Persisted exact-asset and placement evidence, structured multimodal approval, bounded policy fields | Publication gate implemented; automatic provider regeneration after a failed asset remains deliberately fail-closed |
| Explicit editable world | Stable entities/prototypes, independent GLBs, patches, terrain edits, provenance and immutable versions | Implemented |
| Free-viewpoint game-engine path | Renderer-neutral streaming runtime and Three.js WebGPU/WebGL2 adapter | Implemented and browser-tested locally |

## Three profiles

| Profile | Maximum | Intended result | Required execution |
| --- | ---: | --- | --- |
| Local | $0 | Coherent explorable world with procedural PBR placeholders | No provider or Blender |
| Cheap | $15/world | One visually enriched hero region and up to five generated assets | OpenRouter, OpenAI image, WaveSpeed Tripo |
| Studio | $100/world | Up to five hero regions, actual masks, multiview PBR assets, Blender diagnostics and terrain support fitting | OpenRouter, OpenAI image, local SAM2, Blender 5.1, direct Tripo **or** Meshy |

No profile automatically spends its maximum. The policy estimate must fit the request cap, and the user confirms the displayed bound before execution.

## Tripo versus Meshy

WorldEngine does not silently fall back between providers. Studio exposes a deliberate bake-off choice. Run the same isolated/multiview references, face limit, texture target, seed class and benchmark scenarios through each reviewed adapter. The adapters follow the current [Tripo multiview task contract](https://platform.tripo3d.ai/docs/generation) and [Meshy multi-image contract](https://docs.meshy.ai/en/api/multi-image-to-3d), while policy still pins the exact reviewed revision. Compare mesh silhouette and topology, view consistency, PBR texture fidelity, thin structures, Blender repair burden, failure rate, latency and actual cost. Pin the winner's exact revision in the certification. A provider marketing page is not evidence of superiority.

## The 90/100 protocol

`benchmarks/visual-world-parity-v1.json` is authoritative. It compares anonymized WorldEngine output with the paper's Figures 4-8 using:

| Dimension | Weight |
| --- | ---: |
| Composition and style | 30% |
| Asset reconstruction | 20% |
| Terrain coherence | 15% |
| Placement and contact | 10% |
| Editability and provenance | 10% |
| Runtime visual quality and performance | 10% |
| Reliability, cost and reproducibility | 5% |

Certification needs all five scenarios at 90+, an overall 90+, every dimension at 80+, seven hard gates, three independent raters with agreement at least 0.67 (or five raters), exact provider/revision/terms fingerprints, actual cost at or below $100, complete Studio artifact types, no unreviewed generated/edited provenance and immutable scenario-specific captures whose SHA-256 bytes exist in storage.

This repository implements and tests that gate. It does **not** ship a fabricated score. Paid runs and independent ratings have not been performed with the committed disabled policies, so WorldEngine is currently not certified at 90/100.

## Meaningful remaining differences

- The paper used a stronger and restricted/different model stack plus four H20 GPUs; Studio uses legal/operator-reviewed substitutes.
- SAM2 box prompting does not reproduce SAM3 sliding-window text detection; the preceding VLM detector supplies the boxes.
- Tripo/Meshy multiview metadata differs from SAM3D's recovered reconstruction camera, so WorldEngine anchors placement from the known composition box and terrain camera rather than claiming Equation 10-13 equivalence.
- WorldEngine's terrain support fitting is deterministic height-field editing, not free-form Blender mesh co-sculpting.
- Procedural Blender shader-node authoring is not yet in the fixed worker.
- WorldEngine deliberately rejects raw provider output unless multimodal review passes; mocked contracts prove control flow, not live visual quality.

These are benchmarked differences, not hidden ones.
