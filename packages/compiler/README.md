# @worldengine/compiler

WorldEngine compilation pipeline with deterministic planning, regional composition and placement, generated/imported GLB optimization (mipmapped UASTC+Zstd KTX2 plus 50%/20% mesh LODs), CPU mesh/placement review diagnostics, canonical content-hashed chunk materialization, provider adapters, cost/legal gates, provenance, validation, caching, and write-once filesystem/S3 storage abstractions. S3 clients must support conditional `If-None-Match: *` creation for immutable versions.

Provider calls remain disabled until the operator configures exact reviewed model profiles and server-side credentials. Apache-2.0.
