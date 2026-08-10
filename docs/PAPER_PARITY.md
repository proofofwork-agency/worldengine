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
| Region-aware height field and scattering | Soft region masks plus ridge/peak/dune/terrace/erosion/riverbed/plateau operators, material splats and conditioned scatter recipes | Contract/deterministic tests pass; live Blender terrain quality unproven |
| Terrain materials | Standalone Basis/UASTC KTX2 dependencies for Three.js plus fixed Blender triplanar base-color/normal/roughness/macrovariation nodes | Implemented and contract-tested; generated live material quality unproven |
| Terrain-conditioned composition | Registered terrain RGB plus depth/semantic context, reference editing and 0.90/0.95/8 px preservation gates | Mocked contracts pass; live image quality unproven |
| Actual object extraction | Structured detection from the composition, SAM2.1 Hiera Large mask, lossless alpha crop and invertible affine | Contract-tested; local full-checkpoint run still required |
| Independent 3D reconstruction | Four ordered cardinal views through WaveSpeed `tripo3d/h3.1/multiview-to-3d`, detailed PBR triangle output | Mocked fail-closed contract passes; no paid quality evidence yet |
| Placement | Calibrated camera projection, real imported-mesh scale/yaw fitting, SAM-mask silhouette IoU/center gates, contact gates and placement atlas | Worker contract and deterministic math are tested; target-machine Blender evidence pending |
| Object refinement | Fixed Blender 5.1 mesh/region jobs, origin/material/normal/contact correction and five render passes | Worker contract implemented; target-machine headless acceptance pending |
| Terrain co-deformation | Raise/lower/flatten/smooth from the real mesh footprint, full falloff by 5 m and seam-preserving world coordinates | Deterministic bounds tested; live scene result pending |
| Render-inspect-repair | Permanent artifact catalog, typed diagnoses, bounded composition/asset/scene attempts and resumable `needs-attention` runs | Control flow implemented; live repair convergence unproven |
| Explicit editable world | Stable entities/prototypes, independent GLBs, patches, terrain edits, provenance and immutable versions | Implemented |
| Free-viewpoint game-engine path | Renderer-neutral streaming runtime and Three.js WebGPU/WebGL2 adapter | Implemented and browser-tested locally |

## Three profiles

| Profile | Maximum | Intended result | Required execution |
| --- | ---: | --- | --- |
| Local draft | $0 | Coherent explorable draft with clearly marked procedural placeholders | No provider or Blender |
| Cheap | $15/world | One visually enriched hero region and up to five generated assets | OpenRouter planning + OpenRouter Images, WaveSpeed Tripo |
| Studio · experimental | First $25/hero; later separate $100/world | One hero gate first; only after success up to five regions | OpenRouter `openai/gpt-5.6-terra` + `openai/gpt-image-2`, local SAM2.1 Large, WaveSpeed H3.1 multiview, Blender 5.1 |

No profile automatically spends its maximum. The policy estimate plus prior resume spend must fit the request cap, the user confirms the displayed bound before execution, and every unique provider action reserves its reviewed unit price before the adapter is invoked. The durable report uses that policy price conservatively when the provider does not expose invoice data.

## Fixed reconstruction route

Studio has one fail-closed route: WaveSpeed-hosted Tripo H3.1 multiview. No direct Tripo or Meshy credential, alias, fallback or bake-off is part of the Studio product path. The policy must pin the exact reviewed revision, terms fingerprint and unit cost. Provider marketing is not quality evidence; only the saved GLBs, calibrated renders, deterministic measurements and blinded evaluation count.

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
- WaveSpeed/Tripo multiview metadata differs from SAM3D's recovered reconstruction camera, so WorldEngine anchors placement from the known composition box and calibrated terrain camera rather than claiming Equation 10-13 equivalence.
- WorldEngine's terrain support fitting is deterministic height-field editing, not free-form Blender mesh co-sculpting.
- The canonical pre-composition terrain pass does not yet include a separately reconstructed ecology kit; generated ecology is visible in the final refined-region passes.
- WorldEngine deliberately rejects raw provider output unless multimodal review passes; mocked contracts prove control flow, not live visual quality.

These are benchmarked differences, not hidden ones.
