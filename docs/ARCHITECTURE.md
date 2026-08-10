# Architecture

## Boundary

WorldEngine owns visual intent, compiled visual artifacts, terrain appearance, chunk availability, renderer resources, instancing, level of detail, environment rendering, imported animation playback, and visual state. It does not own physics bodies, collision results, navigation meshes, pathfinding, network replication, input, AI, health, damage rules, or gameplay entity lifetime.

The dependency direction is intentionally one-way:

```text
schema ← terrain ← compiler ← compiler-service
   ↑         ↑
 runtime ← three ← editor / host game
```

`@worldengine/schema`, `@worldengine/terrain`, and `@worldengine/runtime` never import Three.js. Runtime contracts use IDs, ordinary objects, arrays, matrices, and typed buffers.

## Canonical formats

All formats are versioned `1.1.0`, right-handed, Y-up, and meter-based. Readers migrate the additive `1.0.0` representation before validation.

- `WorldDesignSpec` records prompt-derived intent plus all explicit defaults, vector regions, adjacency, landmarks, environment, constraints, and asset requirements.
- `AuthoringWorld` is an editable scene graph with stable entity/prototype IDs, terrain sources and edits, visual zones, regional reference images, known-camera regional compositions with structured screen-space boxes, diagnostics, provenance, and applied patch IDs.
- `VisualWorldBundle` is immutable. Its manifest indexes prototypes, environment data, chunk sources, dependencies, optimization flags, and provenance.
- `RuntimeChunk` documents serialize float32 terrain and uint8 biome splats as base64. The runtime validates and decodes both into typed arrays before crossing the renderer boundary.

Zod schemas are the executable source of truth. Draft-7 JSON Schema projections are exported as `jsonSchemas` for external tooling.

The reference distribution build writes every canonical chunk first, validates its terrain/entities/dependencies, and then publishes a manifest whose relative URI, SHA-256, and byte length bind the exact JSON payload. A failed partial build therefore cannot publish a new manifest that references missing chunks. The editor intentionally keeps a separate lower-sample procedural preview source for responsive authoring.

## Determinism

Terrain samples continuous world coordinates through seeded value-noise fBm. Adjacent chunks therefore calculate the same floating-point value along their shared border. Placement uses a coordinate-derived PRNG seed, stable prototype ordering, and world-coordinate height sampling. Repeating a procedural compile yields the same terrain and placement.

Cloud artifact cache keys include provider, exact model/revision, input, and settings. This makes reuse deterministic without claiming that a nondeterministic provider can regenerate bit-identical bytes.

## Streaming

`DefaultVisualWorldEngine` computes signed chunk coordinates around a host-provided position, orders requested chunks by distance, bounds active generation/loading work, applies a hysteresis band before unloading, and emits chunk/entity availability and disposal events. Full 257-sample procedural documents yield between bounded row batches. Because the Three.js backend's highest terrain mesh LOD is 65 samples, the interactive editor evaluates a deterministic 65-sample preview directly while compiler artifacts retain canonical 257-sample terrain. It initially streams a 384-meter neighborhood and expands as its focus moves, so controls and the nearest chunks become useful before the wider view finishes. The host controls when `streamAround` is called. Unknown coordinates can resolve to low-detail procedural placeholders; this path cannot call a provider. The editor can explicitly materialize the inspected placeholder through the compiler's zero-cost expansion endpoint; it then loads the new immutable bundle while preserving the camera focus so the same coordinate is requested as a detailed chunk.

The engine shifts its renderer origin after a configurable threshold while leaving canonical world coordinates unchanged. Three.js chunk and instance groups are moved relative to that origin at render time. Transform, visual-state, environment, and chunk-invalidation patches can apply live. Structural/entity/prototype/terrain/region patches deliberately require loading the new immutable bundle version; the runtime rejects them instead of partially applying or silently ignoring them.

## Renderer backend

The Three.js adapter attempts `WebGPURenderer` only when browser capability exists and initialization succeeds, then falls back to `WebGLRenderer`. It downsamples canonical 257-sample terrain into bounded 65/33/17 render LODs without changing source data, preserves biome splats, adds seamless procedural PBR detail/normal textures, builds seam skirts, cooperatively yields during mesh preparation, partitions instances by prototype and occlusion cell, and streams hash-verified GLB geometry through `GLTFLoader`. Local conformance prototypes combine grounded multi-part silhouettes and vertex variation with deterministic tiled albedo, roughness, and tangent-normal maps; their small owned textures participate in resource accounting and disposal. Static GLB scene nodes remain separate instanced parts under one prototype so every mesh transform, material array, PBR texture, and LOD variant survives import; skeletal scenes use independent clones and mixers. The adapter applies persistent host transform/visibility/material/team/damage/animation patches and configures environment fog, clear/cloud/rain/snow sky tint, animated physical water, weather particles, hemisphere light, sun/moon, ACES tone mapping, shadows, resource budgets, picking, distance LOD, and frustum culling. KTX2 assets are decoded through a bounded Basis worker pool when the host supplies a matching transcoder path; the editor emits the Three.js-matched transcoder under `/basis/` in development and production builds.

Renderer resource creation is transactional: a failed prototype or integrity check disposes detached terrain, materials, and instances and removes rejected cache entries. Static meshes can be merged and instanced; dynamic skeletal visuals remain separate host-controlled objects.

The adapter surface allows future Babylon.js, PlayCanvas, native, or custom backends without changing bundle formats.

The Three.js adapter also exposes editor-only terrain picking: it raycasts the currently drawn terrain LOD and converts the hit through the floating-origin root back into canonical world coordinates. Terrain and region brushes therefore author the clicked world position rather than a screen-space or preselected placeholder coordinate; renderer-neutral runtime contracts remain free of Three.js types.

## Compiler durability

The Node service uses SQLite WAL mode for jobs, ordered events, DAG checkpoints, webhook receipts, worlds, and patch records. SSE reads resume after `Last-Event-ID` before attaching to live events. Graceful shutdown waits for compiler tasks without converting them to terminal jobs, allowing startup recovery from their saved DAG nodes. Versioned design, authoring, bundle, and chunk JSON is write-once: local storage creates a temporary file and atomically hard-links it into an absent target, permits only byte-identical retries, and rejects conflicting overwrites. Canonical publication always writes content-addressed assets/chunks, design, and authoring before the bundle; `putBundle` is the final commit point because it atomically advances the mutable `latest.json` pointer. Fault injection proves an authoring-write failure cannot call that commit point and is converted into a durable, sanitized terminal failure event rather than a hanging SSE stream. Each patch or detailed sparse chunk produces a new immutable bundle version; revision conflicts return HTTP 409. Detailed chunk entries retain the exact payload version and SHA-256 so later manifest-only patches cannot break them.

Filesystem storage is the default. World IDs, versions, coordinates, hashes, and reference extensions are validated before any path is constructed, uploaded bytes must match their declared SHA-256, and mutations of the same world are serialized to prevent lost immutable versions. `S3WorldStorage` applies the same key validation and requires its injected AWS, MinIO, Cloudflare R2, or other compatible client to support `If-None-Match: *`; conditional creation plus byte-identical retry checks prevents version overwrites across processes without placing a vendor SDK in core.

Browser-originated compiler mutations are accepted only from localhost, loopback, private-LAN/`.local` editors, or an explicit operator allowlist. Provider outputs must use public HTTPS URLs, and bearer-authenticated WaveSpeed result polling is pinned to the configured API origin. Read-only bundle and immutable asset GETs retain permissive CORS so compiled visuals remain embeddable by host games.

Ingested GLBs must be self-contained: image and additional buffer payloads use GLB buffer views or safe data URIs. Even otherwise safe external URLs are rejected because mutable or expiring bytes outside the content hash would violate immutable bundle and provenance guarantees.

## Compiler stages

The deterministic DAG performs requirements planning, polygon rasterization, composite landforms, seeded terrain/features/scatter, regional composition, reverse-projection placement, structured visual review, optimization and immutable export. Local produces all three canonical artifacts. Cheap adds structured planning/review, a known-camera terrain edit, an isolated reference and WaveSpeed Tripo. Studio detects objects in the actual composition, creates local SAM2 masks, synthesizes five identity references, sends the ordered front/left/back/right set to one exact direct Tripo or Meshy PBR adapter, keeps the perspective view for review, refines the candidate through a separate allowlisted Blender 5.1 process, records RGB/depth/normal/instance passes, and applies bounded renderer-neutral support-surface edits after placement. Every descriptor, box, inverse projection and atlas tile uses the exact concept camera.

Raw provider GLBs, Blender derivatives, KTX2 outputs, 50%/20% meshoptimizer LODs and diagnostics are content-addressed. A CPU rasterizer validates exact optimized geometry; Blender passes expose higher-quality asset evidence; the placement atlas reports screen/contact error. The reviewer receives persisted bytes and may emit only a schema-valid patch, never code. Generated/edited records receive `reviewedAt` only after approval. Provider outputs are cached by exact revision, inputs and settings; no alternate provider is selected automatically.

Before generation, the editor carries reviewed imported or previously generated GLBs from the open immutable bundle into the next compile as an asset library. The compiler binds each reusable entry to matching provenance and content hashes, rejects unreviewed or commercially incompatible entries, and generates only the remaining requirement slots.

The editor never receives provider keys. Its region regeneration produces a revision-checked `replace-region` patch plus explicit intersecting chunk invalidations. Normal prompt changes create a new compile because prompt intent cannot be smuggled into an existing immutable design revision.
